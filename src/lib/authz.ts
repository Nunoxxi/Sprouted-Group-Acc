/**
 * Authorization rules. Pure: no database, no framework. Every server function
 * and route handler goes through src/lib/dal.ts, which builds a Principal
 * from the session and asks these functions. Nothing else decides access.
 *
 * Role answers "what may this person do"; entity access answers "where".
 * They are independent: an Accountant with access to Sprouted Roots only can
 * post there and cannot see Oikazi at all. Owners hold every entity.
 */

export const roles = ['owner', 'accountant', 'data-entry', 'viewer'] as const;
export type Role = (typeof roles)[number];

export const roleLabels: Record<Role, string> = {
  owner: 'Owner',
  accountant: 'Accountant',
  'data-entry': 'Data entry',
  viewer: 'Viewer',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (roles as readonly string[]).includes(value);
}

export const permissions = [
  'document:draft', // create and edit drafts (invoices and bills)
  'document:post', // post a journal
  'document:mark-paid', // reconcile
  'document:void', // reversing entry
  'period:file', // lock a VAT period
  'period:unlock', // reopen one (not yet built; reserved so the matrix is complete)
  'contact:create',
  'entity:create',
  'entity:configure', // functional currency and other per-entity settings
  'rates:manage', // exchange rate table, bank accounts
  'revaluation:run', // period-end FX revaluation and its reversal
  'inventory:manage', // items and stock locations
  'stock:enter', // enter a stock count or an NRV selling price (nothing posts)
  'stock:post', // transfers, adjustments, posting a count, write-downs — each writes a journal
  'reports:view',
  // Seeing a person's telephone number, mobile money number or signature —
  // not the transactions, which a Viewer may read. See src/lib/privacy.ts.
  'pii:view',
  'privacy:manage', // produce a subject access report, erase a person
  'audit:read',
  'export:run',
  // Adding an account and correcting one that has nothing posted to it. An
  // Accountant needs this mid-close; it cannot reach history.
  'chart:edit',
  // The Settings area, and everything in the chart that reaches history or
  // takes something away: renumbering or retyping an account with postings,
  // switching one off, deleting, merging, importing, reordering. Owner only.
  'settings:manage',
  'users:manage', // invite, change role and entity access, deactivate, unlock
  'sessions:manage', // see who is signed in, force sign-out
] as const;
export type Permission = (typeof permissions)[number];

const matrix: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(permissions),
  accountant: new Set<Permission>([
    'chart:edit',
    'document:draft',
    'document:post',
    'document:mark-paid',
    'document:void',
    'period:file',
    'contact:create',
    'rates:manage',
    'revaluation:run',
    'inventory:manage',
    'stock:enter',
    'stock:post',
    'reports:view',
    'pii:view',
    'privacy:manage',
    'audit:read',
    'export:run',
  ]),
  // Field staff need to be able to telephone a farmer and to pay them, so
  // they see contact details — but they cannot produce a report about a
  // person or erase one.
  'data-entry': new Set<Permission>(['document:draft', 'contact:create', 'stock:enter', 'reports:view', 'pii:view']),
  viewer: new Set<Permission>(['reports:view']),
};

export function roleHas(role: Role, permission: Permission): boolean {
  return matrix[role].has(permission);
}

/** Any role that can post transactions must use app-based TOTP. */
export function roleRequiresTwoFactor(role: Role): boolean {
  return roleHas(role, 'document:post');
}

export type Principal = {
  userId: string;
  name: string;
  email: string;
  role: Role;
  /** 'all' for owners; otherwise the exact entity ids granted. */
  entityIds: 'all' | readonly string[];
  twoFactorEnabled: boolean;
};

export function can(principal: Principal, permission: Permission): boolean {
  return roleHas(principal.role, permission);
}

export function canAccessEntity(principal: Principal, entityId: string): boolean {
  if (!entityId) return false;
  return principal.entityIds === 'all' || principal.entityIds.includes(entityId);
}

/** True when the person must finish TOTP setup before they can do anything else. */
export function mustSetUpTwoFactor(principal: Principal): boolean {
  return roleRequiresTwoFactor(principal.role) && !principal.twoFactorEnabled;
}

/** Restrict a list of entity ids to those the principal may see. Never widens. */
export function visibleEntityIds(principal: Principal, allEntityIds: readonly string[]): string[] {
  return allEntityIds.filter((id) => canAccessEntity(principal, id));
}

export class AuthorizationError extends Error {
  readonly status: 401 | 403;
  constructor(message: string, status: 401 | 403 = 403) {
    super(message);
    this.name = 'AuthorizationError';
    this.status = status;
  }
}

/** Throws unless the principal may perform `permission` on `entityId`. */
export function assertEntityPermission(principal: Principal, entityId: string, permission: Permission): void {
  if (!canAccessEntity(principal, entityId)) {
    // Same message whether the entity is unknown or merely not granted: the
    // caller learns nothing about entities they cannot see.
    throw new AuthorizationError('You do not have access to this entity.');
  }
  if (!can(principal, permission)) {
    throw new AuthorizationError(`Your role (${roleLabels[principal.role]}) cannot do that.`);
  }
}

export const passwordPolicy = {
  minLength: 12,
  maxLength: 128,
  /** Failed sign-ins before the account locks until an Owner unlocks it. */
  lockAfterFailedAttempts: 10,
  /** Invite and reset links expire after this many seconds. */
  setPasswordLinkTtlSeconds: 48 * 60 * 60,
} as const;

/** Values of User.banReason. Both refuse sign-in; only one is reversible by the person. */
export const banReasons = { locked: 'LOCKED', deactivated: 'DEACTIVATED' } as const;
