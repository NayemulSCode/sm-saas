/**
 * The rules for granting a role. §9.5.
 *
 * Pure, and separate from the use case, because these two rules are the only
 * thing standing between a school administrator and total control of the
 * system. They should be readable and testable without a database in front of
 * them.
 *
 *   grantRole(ctx, membership, role):
 *     authorize(ctx, 'role.manage')
 *     if role.permissions ⊄ ctx.permissions  → 403 CANNOT_GRANT_BEYOND_OWN
 *     if membership.id == ctx.membershipId   → 403 SELF_GRANT_BLOCKED
 *     audit('role.granted', reason required)
 */

import type { Permission } from '../../../shared/permissions';

export type GrantVerdict =
  | { kind: 'allowed' }
  /** The role confers something the granter does not hold. */
  | { kind: 'beyond_own'; excess: readonly Permission[] }
  /** The granter is trying to change their own membership. */
  | { kind: 'self_grant' };

export interface GrantRequest {
  /** The membership being changed. */
  targetMembershipId: string;
  /** Every permission the role confers. */
  rolePermissions: readonly Permission[];
}

export interface Granter {
  membershipId: string;
  permissions: ReadonlySet<Permission>;
}

/**
 * Both rules, in the order that matters.
 *
 * SELF-GRANT IS CHECKED FIRST and independently of the permission subset. A
 * principal who already holds everything passes the subset check trivially, so
 * checking it first would let them grant themselves any role they can see —
 * and the point of the rule is that nobody edits their own access, however
 * privileged. Removing your own role is likewise blocked: locking yourself out
 * of a school with one administrator is unrecoverable without operator help.
 *
 * NEITHER RULE MAKES THE OTHER REDUNDANT. Self-grant stops vertical escalation
 * by the powerful; the subset rule stops it by the merely trusted — an office
 * assistant with `role.manage` handing a colleague `fee.waive` and being paid
 * for it.
 */
export function evaluateGrant(granter: Granter, request: GrantRequest): GrantVerdict {
  if (granter.membershipId === request.targetMembershipId) {
    return { kind: 'self_grant' };
  }

  const excess = request.rolePermissions.filter((p) => !granter.permissions.has(p));
  if (excess.length > 0) {
    // Sorted so the error is stable and diffable in a test and in an audit row.
    return { kind: 'beyond_own', excess: [...excess].sort() };
  }

  return { kind: 'allowed' };
}
