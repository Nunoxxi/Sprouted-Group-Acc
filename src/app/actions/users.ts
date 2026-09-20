'use server';

/**
 * User management: Owners only. Creating users, banning (which is how the
 * library refuses sign-in) and revoking sessions go through Better Auth's
 * admin API with the Owner's own session, so the library enforces the Owner
 * role a second time. Role, entity access and deactivation are app data.
 *
 * Users are never deleted. Deactivation sets deactivatedAt, bans, and
 * revokes every session; the id stays valid for every audit event, journal
 * and filing that references it.
 */

import { refresh } from 'next/cache';
import { headers } from 'next/headers';

import { auth } from '@/lib/auth';
import { recordAuditEvent } from '@/lib/audit';
import { banReasons, isRole, roleLabels, type Principal, type Role } from '@/lib/authz';
import { authorizationFailure, requirePermission } from '@/lib/dal';
import { prisma } from '@/lib/prisma';

import type { ActionResult } from './documents';

export type UserStatus = 'active' | 'invited' | 'locked' | 'deactivated';

export type ManagedUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  roleLabel: string;
  status: UserStatus;
  twoFactorEnabled: boolean;
  entityIds: string[];
  failedLoginAttempts: number;
  createdAt: string;
  lastSeenAt: string | null;
};

export type ActiveSession = {
  id: string;
  token: string;
  userId: string;
  userName: string;
  userEmail: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

async function asOwner<T>(run: (owner: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let owner: Principal;
  try {
    owner = await requirePermission('users:manage');
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(owner);
}

function statusOf(user: { banned: boolean; banReason: string | null; deactivatedAt: Date | null }, hasPassword: boolean): UserStatus {
  if (user.deactivatedAt || user.banReason === banReasons.deactivated) return 'deactivated';
  if (user.banned && user.banReason === banReasons.locked) return 'locked';
  if (!hasPassword) return 'invited';
  return 'active';
}

/** Every entity a user-management event should be recorded against. */
async function entitiesFor(userId: string, role: Role): Promise<string[]> {
  if (role === 'owner') {
    return (await prisma.entity.findMany({ select: { id: true } })).map((entity) => entity.id);
  }
  return (await prisma.userEntityAccess.findMany({ where: { userId }, select: { entityId: true } })).map((row) => row.entityId);
}

async function auditUserChange(owner: Principal, entityIds: string[], summary: string, subject: { id: string; email: string }, metadata?: Record<string, unknown>) {
  for (const entityId of entityIds) {
    await recordAuditEvent({
      entityId,
      userId: owner.userId,
      userName: owner.name,
      action: 'USER',
      resourceType: 'user',
      resourceRef: subject.email,
      summary,
      metadata: { subjectUserId: subject.id, ...metadata },
    });
  }
}

// --- reading ---------------------------------------------------------------------

export async function listUsers(): Promise<ActionResult<ManagedUser[]>> {
  return asOwner(async () => {
    const users = await prisma.user.findMany({
      orderBy: [{ deactivatedAt: 'asc' }, { name: 'asc' }],
      include: {
        entityAccess: { select: { entityId: true } },
        authAccounts: { where: { providerId: 'credential' }, select: { id: true } },
        sessions: { orderBy: { updatedAt: 'desc' }, take: 1, select: { updatedAt: true } },
      },
    });

    return {
      ok: true,
      value: users.map((user) => {
        const role = isRole(user.role) ? user.role : 'viewer';
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role,
          roleLabel: roleLabels[role],
          status: statusOf(user, user.authAccounts.length > 0),
          twoFactorEnabled: user.twoFactorEnabled,
          entityIds: user.entityAccess.map((row) => row.entityId),
          failedLoginAttempts: user.failedLoginAttempts,
          createdAt: user.createdAt.toISOString(),
          lastSeenAt: user.sessions[0]?.updatedAt.toISOString() ?? null,
        };
      }),
    };
  });
}

export async function listSessions(): Promise<ActionResult<ActiveSession[]>> {
  return asOwner(async () => {
    const current = await auth.api.getSession({ headers: await headers() });
    const sessions = await prisma.authSession.findMany({
      where: { expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { name: true, email: true } } },
    });

    return {
      ok: true,
      value: sessions.map((session) => ({
        id: session.id,
        token: session.token,
        userId: session.userId,
        userName: session.user.name,
        userEmail: session.user.email,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        isCurrent: session.token === current?.session.token,
      })),
    };
  });
}

// --- inviting and changing access -------------------------------------------------

export type InviteInput = {
  name: string;
  email: string;
  role: Role;
  entityIds: string[];
};

export async function inviteUser(input: InviteInput): Promise<ActionResult<{ userId: string }>> {
  return asOwner(async (owner) => {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    if (!name || !email) return fail('Name and email are both needed.');
    if (!isRole(input.role)) return fail('Unknown role.');

    const validation = await validateEntityIds(input.role, input.entityIds);
    if (!validation.ok) return validation;

    // No password: the library creates the credential when the invitee uses
    // the emailed link. Owner-ness is checked by the admin plugin as well.
    const requestHeaders = await headers();
    let created: { user: { id: string } };
    try {
      created = await auth.api.createUser({
        headers: requestHeaders,
        body: { email, name, role: input.role },
      });
    } catch (error) {
      return fail(messageOf(error, 'Could not create the user.'));
    }

    await prisma.$transaction([
      prisma.user.update({ where: { id: created.user.id }, data: { invitedById: owner.userId, emailVerified: true } }),
      prisma.userEntityAccess.createMany({
        data: validation.value.map((entityId) => ({ userId: created.user.id, entityId, grantedById: owner.userId })),
      }),
    ]);

    // The invitation email. Expiry is the library's reset-token TTL (48h).
    await auth.api.requestPasswordReset({ headers: requestHeaders, body: { email, redirectTo: '/set-password' } });

    await auditUserChange(
      owner,
      await entitiesFor(created.user.id, input.role),
      `${name} invited as ${roleLabels[input.role]}`,
      { id: created.user.id, email },
      { role: input.role, entityIds: validation.value },
    );

    refresh();
    return { ok: true, value: { userId: created.user.id } };
  });
}

export async function resendInvite(userId: string): Promise<ActionResult<null>> {
  return asOwner(async () => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, deactivatedAt: true } });
    if (!user) return fail('User not found.');
    if (user.deactivatedAt) return fail('That account is deactivated.');
    await auth.api.requestPasswordReset({ headers: await headers(), body: { email: user.email, redirectTo: '/set-password' } });
    return { ok: true, value: null };
  });
}

export type AccessInput = {
  userId: string;
  role: Role;
  entityIds: string[];
};

export async function updateUserAccess(input: AccessInput): Promise<ActionResult<null>> {
  return asOwner(async (owner) => {
    if (!isRole(input.role)) return fail('Unknown role.');
    if (input.userId === owner.userId && input.role !== 'owner') {
      return fail('You cannot remove your own Owner role. Ask another Owner.');
    }

    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true, name: true, role: true } });
    if (!user) return fail('User not found.');

    const validation = await validateEntityIds(input.role, input.entityIds);
    if (!validation.ok) return validation;

    const before = await entitiesFor(user.id, isRole(user.role) ? user.role : 'viewer');

    if (user.role !== input.role) {
      // Through the library so the admin plugin validates the role name. Not
      // inside the transaction below: the library uses its own connection.
      await auth.api.setRole({ headers: await headers(), body: { userId: user.id, role: input.role } });
    }

    await prisma.$transaction(async (tx) => {
      await tx.userEntityAccess.deleteMany({ where: { userId: user.id, entityId: { notIn: validation.value } } });
      const existing = new Set((await tx.userEntityAccess.findMany({ where: { userId: user.id }, select: { entityId: true } })).map((r) => r.entityId));
      await tx.userEntityAccess.createMany({
        data: validation.value.filter((id) => !existing.has(id)).map((entityId) => ({ userId: user.id, entityId, grantedById: owner.userId })),
      });
    });

    // Record against every entity involved before or after the change.
    const after = await entitiesFor(user.id, input.role);
    await auditUserChange(
      owner,
      Array.from(new Set(before.concat(after))),
      `${user.name}: role ${roleLabels[input.role]}, access to ${after.length} ${after.length === 1 ? 'entity' : 'entities'}`,
      user,
      { role: input.role, entityIds: after },
    );

    refresh();
    return { ok: true, value: null };
  });
}

async function validateEntityIds(role: Role, entityIds: string[]): Promise<ActionResult<string[]>> {
  if (role === 'owner') {
    return { ok: true, value: [] }; // Owners hold every entity implicitly
  }
  const unique = Array.from(new Set(entityIds));
  const known = await prisma.entity.findMany({ where: { id: { in: unique } }, select: { id: true } });
  if (known.length !== unique.length) {
    return fail('One of the entities does not exist.');
  }
  return { ok: true, value: unique };
}

// --- deactivation, reactivation, unlocking -----------------------------------------

export async function deactivateUser(userId: string): Promise<ActionResult<null>> {
  return asOwner(async (owner) => {
    if (userId === owner.userId) return fail('You cannot deactivate yourself.');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, deactivatedAt: true } });
    if (!user) return fail('User not found.');
    if (user.deactivatedAt) return fail('Already deactivated.');

    const requestHeaders = await headers();
    // The ban is what the library checks; deactivatedAt is what the app checks.
    await auth.api.banUser({ headers: requestHeaders, body: { userId, banReason: banReasons.deactivated } });
    await prisma.user.update({ where: { id: userId }, data: { deactivatedAt: new Date() } });
    await auth.api.revokeUserSessions({ headers: requestHeaders, body: { userId } });

    await auditUserChange(owner, await entitiesFor(userId, isRole(user.role) ? user.role : 'viewer'), `${user.name} deactivated`, user);
    refresh();
    return { ok: true, value: null };
  });
}

export async function reactivateUser(userId: string): Promise<ActionResult<null>> {
  return asOwner(async (owner) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, deactivatedAt: true } });
    if (!user) return fail('User not found.');
    if (!user.deactivatedAt) return fail('That account is not deactivated.');

    await auth.api.unbanUser({ headers: await headers(), body: { userId } });
    await prisma.user.update({ where: { id: userId }, data: { deactivatedAt: null, failedLoginAttempts: 0 } });

    await auditUserChange(owner, await entitiesFor(userId, isRole(user.role) ? user.role : 'viewer'), `${user.name} reactivated`, user);
    refresh();
    return { ok: true, value: null };
  });
}

export async function unlockUser(userId: string): Promise<ActionResult<null>> {
  return asOwner(async (owner) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, banned: true, banReason: true, deactivatedAt: true },
    });
    if (!user) return fail('User not found.');
    if (user.deactivatedAt) return fail('That account is deactivated, not locked. Reactivate it instead.');
    if (!(user.banned && user.banReason === banReasons.locked)) return fail('That account is not locked.');

    await auth.api.unbanUser({ headers: await headers(), body: { userId } });
    await prisma.user.update({ where: { id: userId }, data: { failedLoginAttempts: 0 } });

    await auditUserChange(owner, await entitiesFor(userId, isRole(user.role) ? user.role : 'viewer'), `${user.name} unlocked after failed sign-ins`, user);
    refresh();
    return { ok: true, value: null };
  });
}

// --- sessions ----------------------------------------------------------------------

export async function revokeSession(sessionToken: string): Promise<ActionResult<null>> {
  return asOwner(async (owner) => {
    const session = await prisma.authSession.findUnique({
      where: { token: sessionToken },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
    if (!session) return fail('That session has already ended.');

    await auth.api.revokeUserSession({ headers: await headers(), body: { sessionToken } });

    const role = isRole(session.user.role) ? session.user.role : 'viewer';
    await auditUserChange(owner, await entitiesFor(session.user.id, role), `${session.user.name} signed out by an Owner`, session.user, {
      sessionId: session.id,
    });
    refresh();
    return { ok: true, value: null };
  });
}

function messageOf(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return fallback;
}
