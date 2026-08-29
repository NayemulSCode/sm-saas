/**
 * POST /api/v1/memberships/:id/roles/revoke
 *
 * Self-revocation is blocked by the same rule as self-granting: locking
 * yourself out of a one-administrator school is unrecoverable.
 */
import { revokeRole, RevokeRoleSchema } from '../../../../../../../modules/identity/index';
import type { MembershipId, RoleId } from '../../../../../../../shared/ids';
import { authed } from '../../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof RevokeRoleSchema.parse>,
  unknown,
  { membershipId: string }
>(RevokeRoleSchema, (ctx, input, params) =>
  revokeRole(ctx, {
    membershipId: params.membershipId as MembershipId,
    roleId: input.roleId as RoleId,
    reason: input.reason,
  }),
);
