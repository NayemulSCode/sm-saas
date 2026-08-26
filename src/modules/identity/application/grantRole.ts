/**
 * Grant and revoke roles. §9.5.
 *
 * The two guards are in `domain/grant.ts` and are the only thing standing
 * between a school administrator and total control. Both attempts are audited
 * whether or not they succeed — the ATTEMPT is the signal, and a blocked
 * escalation that leaves no trace teaches nobody anything.
 */

import { withTenant } from '../../../db/rls';
import { audit } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { MembershipId, RoleId } from '../../../shared/ids';
import type { Permission } from '../../../shared/permissions';
import { evaluateGrant } from '../domain/grant';
import { roles } from '../infrastructure/roleRepository';

export const GrantErrors = defineErrors({
  ROLE_NOT_FOUND: {
    code: 'ROLE_NOT_FOUND',
    messageKey: 'role.error.notFound',
    httpStatus: 404,
  },
  MEMBERSHIP_NOT_FOUND: {
    code: 'MEMBERSHIP_NOT_FOUND',
    messageKey: 'role.error.membershipNotFound',
    httpStatus: 404,
  },
  CANNOT_GRANT_BEYOND_OWN: {
    code: 'CANNOT_GRANT_BEYOND_OWN',
    messageKey: 'role.error.beyondOwn',
    httpStatus: 403,
  },
  SELF_GRANT_BLOCKED: {
    code: 'SELF_GRANT_BLOCKED',
    messageKey: 'role.error.selfGrant',
    httpStatus: 403,
  },
  ALREADY_GRANTED: {
    code: 'ALREADY_GRANTED',
    messageKey: 'role.error.alreadyGranted',
    httpStatus: 409,
  },
  NOT_GRANTED: {
    code: 'NOT_GRANTED',
    messageKey: 'role.error.notGranted',
    httpStatus: 404,
  },
});

export interface GrantRoleInput {
  membershipId: MembershipId;
  roleId: RoleId;
  /**
   * `{}` — unrestricted within the tenant. An absent axis is unrestricted; a
   * present but empty one denies everything, so a misconfigured role fails
   * closed (§9.3).
   */
  scope?: Record<string, readonly string[]> | undefined;
  /** Required and audited. Access changes are never routine. */
  reason: string;
}

export async function grantRole(
  ctx: AuthContext,
  input: GrantRoleInput,
): Promise<Result<{ membershipRoleId: string }, DomainError>> {
  authorize(ctx, 'role.manage');

  return withTenant(ctx, async (tx) => {
    // RLS scopes both lookups to the caller's tenant, so a role or membership
    // from another school reads as "not found" rather than as a refusal.
    const membership = await roles.membershipExists(tx, input.membershipId);
    if (!membership) return err(GrantErrors.MEMBERSHIP_NOT_FOUND);

    const role = await roles.byId(tx, input.roleId);
    if (!role) return err(GrantErrors.ROLE_NOT_FOUND);

    const verdict = evaluateGrant(
      { membershipId: ctx.membershipId, permissions: ctx.permissions },
      { targetMembershipId: input.membershipId, rolePermissions: role.permissions },
    );

    if (verdict.kind !== 'allowed') {
      /*
       * Audited BEFORE returning. A refused escalation is exactly the row an
       * investigation looks for, and it is the only evidence that someone
       * tried. Recording only successes would make the guard invisible.
       */
      await audit(tx, ctx, 'role.grant_refused', input.membershipId, {
        entityType: 'membership',
        reason: input.reason,
        after: {
          roleId: input.roleId,
          refusedBecause: verdict.kind,
          // Permission KEYS, not values — they are vocabulary, not personal
          // data, and knowing which one was refused is the whole point.
          excess: verdict.kind === 'beyond_own' ? verdict.excess.join(',') : null,
        },
      });

      return err(
        verdict.kind === 'self_grant'
          ? GrantErrors.SELF_GRANT_BLOCKED
          : GrantErrors.CANNOT_GRANT_BEYOND_OWN,
      );
    }

    if (await roles.isGranted(tx, input.membershipId, input.roleId)) {
      return err(GrantErrors.ALREADY_GRANTED);
    }

    const membershipRoleId = await roles.grant(tx, {
      membershipId: input.membershipId,
      roleId: input.roleId,
      scope: input.scope ?? {},
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'role.granted', input.membershipId, {
      entityType: 'membership',
      reason: input.reason,
      after: {
        membershipRoleId,
        roleId: input.roleId,
        roleCode: role.code,
        scoped: Object.keys(input.scope ?? {}).length > 0,
      },
    });

    return ok({ membershipRoleId });
  });
}

/**
 * Removes a role from a membership.
 *
 * Self-revocation is blocked by the same rule as self-granting: locking
 * yourself out of a school that has one administrator is unrecoverable without
 * operator help, and "I was only removing a role" is how it happens.
 */
export async function revokeRole(
  ctx: AuthContext,
  input: { membershipId: MembershipId; roleId: RoleId; reason: string },
): Promise<Result<{ revoked: boolean }, DomainError>> {
  authorize(ctx, 'role.manage');

  return withTenant(ctx, async (tx) => {
    if (ctx.membershipId === input.membershipId) {
      await audit(tx, ctx, 'role.grant_refused', input.membershipId, {
        entityType: 'membership',
        reason: input.reason,
        after: { roleId: input.roleId, refusedBecause: 'self_revoke' },
      });
      return err(GrantErrors.SELF_GRANT_BLOCKED);
    }

    const removed = await roles.revoke(tx, input.membershipId, input.roleId, ctx.personId);
    if (removed === 0) return err(GrantErrors.NOT_GRANTED);

    await audit(tx, ctx, 'role.revoked', input.membershipId, {
      entityType: 'membership',
      reason: input.reason,
      after: { roleId: input.roleId },
    });

    return ok({ revoked: true });
  });
}

/** What a role confers — for a UI that shows it before anyone clicks grant. */
export async function listRoles(
  ctx: AuthContext,
): Promise<Result<Array<{ id: RoleId; code: string; permissions: readonly Permission[] }>, DomainError>> {
  authorize(ctx, 'role.manage');
  return withTenant(ctx, async (tx) => ok(await roles.all(tx)));
}
