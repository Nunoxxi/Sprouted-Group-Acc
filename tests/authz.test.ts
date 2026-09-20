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
    'document:draft',
    'document:post',
    'document:mark-paid',
    'document:void',
    'period:file',
    'contact:create',
    'reports:view',
    'audit:read',
    'export:run',
  ],
  'data-entry': ['document:draft', 'contact:create', 'reports:view'],
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
  });

  it('Viewer can edit nothing', () => {
    const editing = permissions.filter((permission) => permission !== 'reports:view');
    expect(editing.some((permission) => roleHas('viewer', permission))).toBe(false);
  });

  it('only Owners manage users, sessions and entities', () => {
    for (const permission of ['users:manage', 'sessions:manage', 'entity:create', 'period:unlock'] as const) {
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
