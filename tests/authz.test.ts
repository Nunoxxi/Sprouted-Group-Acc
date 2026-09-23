import { describe, expect, it } from 'vitest';

import {
  AuthorizationError,
  assertEntityPermission,
  can,
  canAccessEntity,
  mustSetUpTwoFactor,
  passwordPolicy,
  permissions,
  roleHas,
  roleRequiresTwoFactor,
  roles,
  visibleEntityIds,
  type Permission,
  type Principal,
  type Role,
} from '@/lib/authz';

function principal(role: Role, entityIds: Principal['entityIds'] = ['sprouted-roots'], twoFactorEnabled = true): Principal {
  return { userId: `u-${role}`, name: role, email: `${role}@example.com`, role, entityIds, twoFactorEnabled };
}

/**
 * The role matrix, written out in full so a change to authz.ts has to be
 * matched by a deliberate change here. Rows are the spec's words.
 */
const expected: Record<Role, Permission[]> = {
  owner: [...permissions],
  accountant: [
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
  ],
  // Keeps the books: enters and posts, reconciles, adds an account. Does not
  // correct a posted entry, close a period or touch a person's data.
  bookkeeper: [
    'chart:edit',
    'document:draft',
    'document:post',
    'document:mark-paid',
    'contact:create',
    'rates:manage',
    'stock:enter',
    'reports:view',
    'pii:view',
    'audit:read',
    'export:run',
  ],
  // Field staff telephone farmers and pay them, so they see contact details;
  // they cannot report on a person or erase one.
  'data-entry': ['document:draft', 'contact:create', 'stock:enter', 'reports:view', 'pii:view'],
  viewer: ['reports:view'],
};

describe('role matrix', () => {
  for (const role of roles) {
    it(`${role} has exactly the permissions the spec gives it`, () => {
      const granted = permissions.filter((permission) => roleHas(role, permission));
      expect(granted.sort()).toEqual([...expected[role]].sort());
    });
  }

  it('Data entry cannot post, void or unlock periods', () => {
    expect(roleHas('data-entry', 'document:post')).toBe(false);
    expect(roleHas('data-entry', 'document:void')).toBe(false);
    expect(roleHas('data-entry', 'period:unlock')).toBe(false);
    // Stock: data entry may count and enter prices, never post the adjustment.
    expect(roleHas('data-entry', 'stock:enter')).toBe(true);
    expect(roleHas('data-entry', 'stock:post')).toBe(false);
    expect(roleHas('data-entry', 'inventory:manage')).toBe(false);
  });

  it('a Bookkeeper posts the day to day but does not correct or close', () => {
    // What the role is for.
    expect(roleHas('bookkeeper', 'document:draft')).toBe(true);
    expect(roleHas('bookkeeper', 'document:post')).toBe(true);
    expect(roleHas('bookkeeper', 'document:mark-paid')).toBe(true);
    expect(roleHas('bookkeeper', 'chart:edit')).toBe(true);
    expect(roleHas('bookkeeper', 'pii:view')).toBe(true);
    // Correcting what is posted, and closing the period it sits in, are an
    // Accountant's. So is anything to do with a person's own data.
    expect(roleHas('bookkeeper', 'document:void')).toBe(false);
    expect(roleHas('bookkeeper', 'period:file')).toBe(false);
    expect(roleHas('bookkeeper', 'revaluation:run')).toBe(false);
    expect(roleHas('bookkeeper', 'privacy:manage')).toBe(false);
    // And the Settings area, with everything in the chart that reaches
    // history, stays with the Owner.
    expect(roleHas('bookkeeper', 'settings:manage')).toBe(false);
    expect(roleHas('bookkeeper', 'stock:post')).toBe(false);
    expect(roleHas('bookkeeper', 'inventory:manage')).toBe(false);
  });

  it('a Bookkeeper can do strictly less than an Accountant', () => {
    const wider = permissions.filter((permission) => roleHas('bookkeeper', permission) && !roleHas('accountant', permission));
    expect(wider).toEqual([]);
  });

  it('Viewer can edit nothing', () => {
    const editing = permissions.filter((permission) => permission !== 'reports:view');
    expect(editing.some((permission) => roleHas('viewer', permission))).toBe(false);
  });

  it('only Owners manage users, sessions and entities', () => {
    for (const permission of ['users:manage', 'sessions:manage', 'entity:create', 'entity:configure', 'period:unlock', 'settings:manage'] as const) {
      expect(roles.filter((role) => roleHas(role, permission))).toEqual(['owner']);
    }
  });
});

describe('two-factor requirement', () => {
  it('is exactly the roles that can post transactions', () => {
    for (const role of roles) {
      expect(roleRequiresTwoFactor(role)).toBe(roleHas(role, 'document:post'));
    }
    expect(roleRequiresTwoFactor('owner')).toBe(true);
    expect(roleRequiresTwoFactor('accountant')).toBe(true);
    expect(roleRequiresTwoFactor('bookkeeper')).toBe(true);
    expect(roleRequiresTwoFactor('data-entry')).toBe(false);
    expect(roleRequiresTwoFactor('viewer')).toBe(false);
  });

  it('blocks a posting role until TOTP is enabled, and never blocks a viewer', () => {
    expect(mustSetUpTwoFactor(principal('accountant', ['sprouted-roots'], false))).toBe(true);
    expect(mustSetUpTwoFactor(principal('accountant', ['sprouted-roots'], true))).toBe(false);
    expect(mustSetUpTwoFactor(principal('viewer', ['sprouted-roots'], false))).toBe(false);
  });
});

describe('entity access is separate from role', () => {
  it('an Accountant on Roots has no access to Oikazi at all', () => {
    const p = principal('accountant', ['sprouted-roots']);
    expect(canAccessEntity(p, 'sprouted-roots')).toBe(true);
    expect(canAccessEntity(p, 'oikazi')).toBe(false);
    expect(() => assertEntityPermission(p, 'oikazi', 'reports:view')).toThrow(AuthorizationError);
  });

  it('Owners see every entity, including ones created later', () => {
    const p = principal('owner', 'all');
    expect(canAccessEntity(p, 'oikazi')).toBe(true);
    expect(canAccessEntity(p, 'an-entity-added-next-year')).toBe(true);
  });

  it('nobody can access an empty entity id', () => {
    expect(canAccessEntity(principal('owner', 'all'), '')).toBe(false);
  });

  it('an unknown entity and an ungranted one are refused with the same message', () => {
    const p = principal('accountant', ['sprouted-roots']);
    const messageFor = (entityId: string) => {
      try {
        assertEntityPermission(p, entityId, 'reports:view');
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(messageFor('oikazi')).toBe(messageFor('does-not-exist'));
    expect(messageFor('oikazi')).not.toBeNull();
  });

  it('checks entity access before role, so a wrong entity never reveals what the role could do', () => {
    const viewer = principal('viewer', ['sprouted-roots']);
    expect(() => assertEntityPermission(viewer, 'oikazi', 'document:post')).toThrow('You do not have access to this entity.');
    expect(() => assertEntityPermission(viewer, 'sprouted-roots', 'document:post')).toThrow(/cannot do that/);
  });

  it('visibleEntityIds only ever narrows', () => {
    const all = ['sprouted-roots', 'sprouted-crafts', 'oikazi'];
    expect(visibleEntityIds(principal('accountant', ['oikazi']), all)).toEqual(['oikazi']);
    expect(visibleEntityIds(principal('viewer', []), all)).toEqual([]);
    expect(visibleEntityIds(principal('owner', 'all'), all)).toEqual(all);
    expect(visibleEntityIds(principal('accountant', ['not-a-real-entity']), all)).toEqual([]);
  });
});

describe('password policy', () => {
  it('matches the spec: 12 characters, lock at ten failures, links live 48 hours', () => {
    expect(passwordPolicy.minLength).toBe(12);
    expect(passwordPolicy.lockAfterFailedAttempts).toBe(10);
    expect(passwordPolicy.setPasswordLinkTtlSeconds).toBe(48 * 60 * 60);
  });
});

describe('can()', () => {
  it('agrees with roleHas for every role and permission', () => {
    for (const role of roles) {
      for (const permission of permissions) {
        expect(can(principal(role), permission)).toBe(roleHas(role, permission));
      }
    }
  });
});
