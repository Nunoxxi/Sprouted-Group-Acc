/**
 * Data access layer: who is asking, and may they?
 *
 * Every Server Function and Route Handler calls one of the `require*`
 * functions before touching the database. The principal comes from the
 * library's session (never from anything the client sent), entity access
 * from UserEntityAccess, and the decision from src/lib/authz.ts. The UI
 * hiding a button is a courtesy; this is the check.
 */

import { headers } from 'next/headers';
import { cache } from 'react';

import { auth } from './auth';
import {
  AuthorizationError,
  assertEntityPermission,
  can,
  isRole,
  mustSetUpTwoFactor,
  type Permission,
  type Principal,
} from './authz';
import { prisma } from './prisma';

type SessionUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
  twoFactorEnabled?: boolean | null;
  deactivatedAt?: Date | string | null;
};

/**
 * The signed-in principal, or null. Memoised per request with React's
 * cache(), so a page and its nested components share one session lookup.
 */
export const getPrincipal = cache(async (): Promise<Principal | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const user = session.user as unknown as SessionUser;
  // A session that outlived a deactivation or lock is worth nothing. The
  // library refuses new sessions for these users; this refuses existing ones.
  if (user.deactivatedAt || user.banned) return null;

  const role = isRole(user.role) ? user.role : 'viewer';
  const entityIds =
    role === 'owner'
      ? ('all' as const)
      : (await prisma.userEntityAccess.findMany({ where: { userId: user.id }, select: { entityId: true } })).map((row) => row.entityId);

  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    role,
    entityIds,
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
  };
});

export type RequireOptions = {
  /** Only the two-factor setup flow itself may pass while setup is pending. */
  allowPendingTwoFactor?: boolean;
};

export async function requirePrincipal(options: RequireOptions = {}): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) {
    throw new AuthorizationError('Sign in to continue.', 401);
  }
  if (!options.allowPendingTwoFactor && mustSetUpTwoFactor(principal)) {
    throw new AuthorizationError('Set up two-factor authentication to continue.', 403);
  }
  return principal;
}

/** The principal, provided they may do `permission` on `entityId`. Throws otherwise. */
export async function requireEntityAccess(entityId: string, permission: Permission): Promise<Principal> {
  const principal = await requirePrincipal();
  assertEntityPermission(principal, entityId, permission);
  return principal;
}

/** The principal, provided their role grants `permission` (entity-independent). */
export async function requirePermission(permission: Permission): Promise<Principal> {
  const principal = await requirePrincipal();
  if (!can(principal, permission)) {
    throw new AuthorizationError('Your role cannot do that.');
  }
  return principal;
}

/**
 * For Server Functions that report errors as values rather than throwing:
 * turns an authorization failure into `{ ok: false, error }` and rethrows
 * anything else.
 */
export function authorizationFailure(error: unknown): { ok: false; error: string } | null {
  if (error instanceof AuthorizationError) {
    return { ok: false, error: error.message };
  }
  return null;
}
