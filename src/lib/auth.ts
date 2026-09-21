/**
 * Better Auth configuration. This is the only file that talks to the auth
 * library's server API; everything else goes through src/lib/dal.ts.
 *
 * What the library owns: password hashing (scrypt), sessions and cookies,
 * reset/invite tokens, TOTP secrets and backup codes, the breached-password
 * check, rate limiting, and the ban that refuses sign-in. What this file adds
 * on top, as hooks: counting failed sign-ins and locking at ten, refusing
 * deactivated users, and sending the emails.
 */

import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { admin, haveIBeenPwned, twoFactor } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

import { banReasons, passwordPolicy, roles } from './authz';
import { sendEmail } from './email';
import { senderForUser } from './email-sender';
import { prisma } from './prisma';

// The origin check compares this to the browser's Origin header exactly, so a
// trailing slash or surrounding whitespace in the env var would refuse every
// sign-in with "Invalid origin". Normalise rather than trust the paste.
const appUrl = (process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? 'http://localhost:3000').trim().replace(/\/+$/, '');

// Admin-plugin permissions: Owners administer users and sessions; every other
// role has none. Impersonation is deliberately not granted to anyone.
const ac = createAccessControl(defaultStatements);
const ownerAc = ac.newRole({
  user: ['create', 'list', 'set-role', 'ban', 'set-password', 'get', 'update'],
  session: ['list', 'revoke', 'delete'],
});
const memberAc = ac.newRole({ user: [], session: [] });
const adminRoles = Object.fromEntries(roles.map((role) => [role, role === 'owner' ? ownerAc : memberAc]));

const LOCKED_MESSAGE = 'This account is locked after too many failed sign-ins. Ask an Owner to unlock it.';
const DEACTIVATED_MESSAGE = 'This account has been deactivated.';

export const auth = betterAuth({
  appName: 'Sprouted Accounting',
  baseURL: appUrl,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  trustedOrigins: [appUrl],

  // The chart of accounts already owns the name "Account", so the auth tables
  // are prefixed. Model names are given as Prisma *client properties*
  // (authSession -> prisma.authSession -> table AuthSession): the adapter's
  // schema check compares them with the client's property names verbatim.
  session: {
    modelName: 'authSession',
    expiresIn: 12 * 60 * 60, // an accounting session ends with the working day
    updateAge: 60 * 60,
    // No cookie cache: every request reads the session row, so a forced
    // sign-out or deactivation takes effect on the next request.
  },
  account: { modelName: 'authAccount' },
  verification: { modelName: 'authVerification' },
  rateLimit: {
    enabled: true,
    storage: 'database',
    modelName: 'rateLimit',
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/two-factor/verify-totp': { window: 60, max: 5 },
      '/two-factor/verify-backup-code': { window: 60, max: 3 },
      '/request-password-reset': { window: 300, max: 3 },
      '/reset-password': { window: 60, max: 5 },
    },
  },

  user: {
    additionalFields: {
      failedLoginAttempts: { type: 'number', required: false, defaultValue: 0, input: false },
      deactivatedAt: { type: 'date', required: false, input: false },
      invitedById: { type: 'string', required: false, input: false },
    },
  },

  emailAndPassword: {
    enabled: true,
    // Invite-only: there is no sign-up endpoint. Owners create users; the
    // person sets their own password from the emailed link.
    disableSignUp: true,
    minPasswordLength: passwordPolicy.minLength,
    maxPasswordLength: passwordPolicy.maxLength,
    // The invite link *is* a reset-password token: the library creates the
    // credential the first time it is used.
    resetPasswordTokenExpiresIn: passwordPolicy.setPasswordLinkTtlSeconds,
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url }) {
      const hasPassword = await prisma.authAccount.count({ where: { userId: user.id, providerId: 'credential' } });
      const isInvite = hasPassword === 0;
      // From the entity the person belongs to, when it has its own sender.
      const sender = await senderForUser(user.id);
      const speakingFor = sender.entityName ? ` for ${sender.entityName}` : '';
      await sendEmail({
        from: sender.from,
        to: user.email,
        subject: isInvite ? `You have been invited to Sprouted Accounting${speakingFor}` : 'Reset your Sprouted Accounting password',
        text: [
          `Hello ${user.name},`,
          '',
          isInvite
            ? `An Owner has invited you to Sprouted Accounting${speakingFor}. Set your password here:`
            : 'Set a new password for your Sprouted Accounting account here:',
          url,
          '',
          'The link expires in 48 hours. Passwords must be at least 12 characters and are checked against known breached passwords.',
          isInvite ? '' : 'If you did not ask for this, you can ignore this email.',
        ].join('\n'),
      });
    },
  },

  databaseHooks: {
    session: {
      create: {
        // Belt and braces alongside the admin plugin's ban check: a deactivated
        // user never gets a session even if a ban was lifted by mistake.
        async before(session) {
          const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { deactivatedAt: true } });
          if (user?.deactivatedAt) {
            throw new APIError('FORBIDDEN', { message: DEACTIVATED_MESSAGE, code: 'USER_DEACTIVATED' });
          }
        },
      },
    },
  },

  hooks: {
    // Refuse locked and deactivated accounts *before* the password is checked,
    // with the same message for a right or wrong password, so a locked account
    // cannot be used as a password oracle.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const email = String((ctx.body as { email?: string })?.email ?? '').toLowerCase();
      if (!email) return;
      const user = await prisma.user.findUnique({ where: { email }, select: { banned: true, banReason: true, deactivatedAt: true } });
      if (!user) return; // the library answers "invalid email or password"
      if (user.deactivatedAt || user.banReason === banReasons.deactivated) {
        throw new APIError('FORBIDDEN', { message: DEACTIVATED_MESSAGE, code: 'USER_DEACTIVATED' });
      }
      if (user.banned && user.banReason === banReasons.locked) {
        throw new APIError('FORBIDDEN', { message: LOCKED_MESSAGE, code: 'ACCOUNT_LOCKED' });
      }
    }),
    // Count failed password attempts per account; lock at ten. The counter
    // resets on success. Unlocking is an Owner action (src/app/actions/users.ts).
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const email = String((ctx.body as { email?: string })?.email ?? '').toLowerCase();
      if (!email) return;
      const returned = ctx.context.returned;
      const failed = returned instanceof APIError && returned.statusCode === 401;
      const user = await prisma.user.findUnique({ where: { email }, select: { id: true, failedLoginAttempts: true, banned: true } });
      if (!user) return;

      if (failed) {
        const attempts = user.failedLoginAttempts + 1;
        const lock = attempts >= passwordPolicy.lockAfterFailedAttempts;
        await prisma.user.update({
          where: { id: user.id },
          data: lock ? { failedLoginAttempts: attempts, banned: true, banReason: banReasons.locked, banExpires: null } : { failedLoginAttempts: attempts },
        });
        if (lock) {
          await prisma.authSession.deleteMany({ where: { userId: user.id } });
        }
        return;
      }

      if (!(returned instanceof APIError) && user.failedLoginAttempts > 0) {
        await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0 } });
      }
    }),
  },

  plugins: [
    admin({
      defaultRole: 'viewer',
      adminRoles: ['owner'],
      roles: adminRoles,
      bannedUserMessage: LOCKED_MESSAGE,
    }),
    twoFactor({
      issuer: 'Sprouted Accounting',
      twoFactorTable: 'twoFactor',
      // Wrong TOTP codes are limited by the library too, independently of the
      // password lock: ten failures pause verification for fifteen minutes.
      accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 15 * 60 },
    }),
    haveIBeenPwned({
      customPasswordCompromisedMessage: 'That password appears in a list of known breached passwords. Choose a different one.',
    }),
    nextCookies(), // must be last
  ],
});

export type Auth = typeof auth;
