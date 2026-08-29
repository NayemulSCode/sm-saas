/**
 * POST /api/v1/memberships/:id/roles — grant a role.
 *
 * Nobody grants beyond their own permissions, and nobody edits their own
 * membership. Both refusals are audited: the attempt is the signal.
 */
import { grantRole, GrantRoleSchema } from '../../../../../../modules/identity/index';
import type { MembershipId, RoleId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof GrantRoleSchema.parse>,
  unknown,
  { membershipId: string }
>(
  GrantRoleSchema,
  (ctx, input, params) =>
    grantRole(ctx, {
      membershipId: params.membershipId as MembershipId,
      roleId: input.roleId as RoleId,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      reason: input.reason,
    }),
  { status: 201 },
);
