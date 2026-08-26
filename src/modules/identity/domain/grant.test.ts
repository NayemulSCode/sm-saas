import { describe, it, expect } from 'vitest';
import { evaluateGrant } from './grant';
import { PERMISSIONS, type Permission } from '../../../shared/permissions';

const granter = (membershipId: string, permissions: Permission[]) => ({
  membershipId,
  permissions: new Set(permissions),
});

const ME = 'membership-me';
const THEM = 'membership-them';

describe('evaluateGrant', () => {
  it('allows granting a role wholly inside the granter’s own permissions', () => {
    const v = evaluateGrant(granter(ME, ['role.manage', 'student.read', 'student.write']), {
      targetMembershipId: THEM,
      rolePermissions: ['student.read'],
    });
    expect(v.kind).toBe('allowed');
  });

  it('allows granting a role that confers nothing at all', () => {
    const v = evaluateGrant(granter(ME, ['role.manage']), {
      targetMembershipId: THEM,
      rolePermissions: [],
    });
    expect(v.kind).toBe('allowed');
  });

  describe('nobody grants beyond what they hold', () => {
    it('refuses, and names exactly what was missing', () => {
      const v = evaluateGrant(granter(ME, ['role.manage', 'fee.collect']), {
        targetMembershipId: THEM,
        rolePermissions: ['fee.collect', 'fee.waive', 'result.publish'],
      });
      expect(v.kind).toBe('beyond_own');
      if (v.kind !== 'beyond_own') return;
      // Named so the audit row and the error say WHICH permission was refused,
      // not merely that something was.
      expect(v.excess).toEqual(['fee.waive', 'result.publish']);
    });

    it('refuses on a single missing permission out of many held', () => {
      const v = evaluateGrant(granter(ME, PERMISSIONS.filter((p) => p !== 'fee.waive')), {
        targetMembershipId: THEM,
        rolePermissions: ['student.read', 'fee.waive'],
      });
      expect(v.kind).toBe('beyond_own');
      if (v.kind === 'beyond_own') expect(v.excess).toEqual(['fee.waive']);
    });

    it('lets someone holding everything grant anything — to someone else', () => {
      const v = evaluateGrant(granter(ME, [...PERMISSIONS]), {
        targetMembershipId: THEM,
        rolePermissions: [...PERMISSIONS],
      });
      expect(v.kind).toBe('allowed');
    });
  });

  describe('nobody edits their own access', () => {
    it('refuses a self-grant', () => {
      const v = evaluateGrant(granter(ME, ['role.manage']), {
        targetMembershipId: ME,
        rolePermissions: [],
      });
      expect(v.kind).toBe('self_grant');
    });

    /*
     * The ordering that matters. A principal holds everything, so the subset
     * check passes trivially — if it ran first they could grant themselves any
     * role they can see. The rule is that nobody edits their own access,
     * however privileged.
     */
    it('refuses a self-grant even when the granter holds every permission', () => {
      const v = evaluateGrant(granter(ME, [...PERMISSIONS]), {
        targetMembershipId: ME,
        rolePermissions: ['fee.waive'],
      });
      expect(v.kind).toBe('self_grant');
    });

    it('reports self_grant rather than beyond_own when both would apply', () => {
      const v = evaluateGrant(granter(ME, []), {
        targetMembershipId: ME,
        rolePermissions: ['fee.waive'],
      });
      // Both are true; the more specific and more serious one is reported.
      expect(v.kind).toBe('self_grant');
    });
  });

  /*
   * Neither rule makes the other redundant, and this is the pair that proves
   * it: the same request is refused for two different reasons depending only
   * on who is asking.
   */
  it('refuses the powerful for self-dealing and the trusted for escalation', () => {
    const role: Permission[] = ['fee.waive'];

    const principal = evaluateGrant(granter(ME, [...PERMISSIONS]), {
      targetMembershipId: ME,
      rolePermissions: role,
    });
    const clerk = evaluateGrant(granter(ME, ['role.manage', 'fee.collect']), {
      targetMembershipId: THEM,
      rolePermissions: role,
    });

    expect(principal.kind).toBe('self_grant');
    expect(clerk.kind).toBe('beyond_own');
  });
});
