/**
 * Bootstrap the first Owner. There is no sign-up page, and only Owners can
 * invite, so the very first account has to be created from the command line:
 *
 *   npm run auth:create-owner -- --email you@example.com --name "Your Name"
 *
 * This inserts the user row only — no password. The person then opens
 * /forgot-password, enters the email, and sets a password from the link the
 * library sends (48-hour expiry). Password hashing, tokens and sessions stay
 * with Better Auth. Safe to re-run: an existing user is promoted to Owner and
 * reactivated rather than duplicated.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const email = argument('--email')?.trim().toLowerCase();
  const name = argument('--name')?.trim();
  if (!email || !name) {
    console.error('Usage: npm run auth:create-owner -- --email you@example.com --name "Your Name"');
    process.exit(2);
  }

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, role: 'owner', emailVerified: true },
    update: { role: 'owner', deactivatedAt: null, banned: false, banReason: null, banExpires: null, failedLoginAttempts: 0 },
    select: { id: true, authAccounts: { where: { providerId: 'credential' }, select: { id: true } } },
  });

  console.log(`Owner ${email} ready (id ${user.id}).`);
  if (user.authAccounts.length === 0) {
    console.log('No password yet: open /forgot-password, enter this email, and set one from the emailed link.');
    console.log('Without RESEND_API_KEY the link is printed to the server console instead of sent.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
