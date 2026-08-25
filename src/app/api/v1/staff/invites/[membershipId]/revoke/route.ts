import type { NextRequest } from 'next/server';
import { revokeInvite, RevokeInviteSchema } from '../../../../../../../modules/identity/index';
import type { MembershipId } from '../../../../../../../shared/ids';
import { fail, failValidation, newRequestId, ok } from '../../../../../_lib/http';
import { requireAuth, toAuthFailure } from '../../../../../_lib/auth';

export const runtime = 'nodejs';

/**
 * POST /api/v1/staff/invites/:membershipId/revoke
 *
 * A state transition, so a verb on the resource (§19.2). The link stops
 * working immediately, and the reason is required because revocation is
 * audited.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ membershipId: string }> },
): Promise<Response> {
  const requestId = newRequestId();

  const auth = await requireAuth(requestId);
  if (!auth.ok) return auth.response;

  const parsed = RevokeInviteSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return failValidation(parsed.error.issues, requestId);

  const { membershipId } = await params;

  try {
    const result = await revokeInvite(
      auth.ctx,
      membershipId as MembershipId,
      parsed.data.reason,
    );
    if (!result.ok) return fail(result.error, requestId);
    return ok(result.value, { requestId });
  } catch (e) {
    const denied = toAuthFailure(e, requestId);
    if (denied) return denied;
    throw e;
  }
}
