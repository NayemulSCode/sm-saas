import { switchContext, ActivateContextSchema, tokenGenerator } from '../../../../../../../modules/identity/index';
import { CommonErrors } from '../../../../../../../shared/result';
import type { MembershipId } from '../../../../../../../shared/ids';
import { fail, failValidation, newRequestId, ok } from '../../../../../_lib/http';
import { readSessionToken } from '../../../../../_lib/session-cookie';

export const runtime = 'nodejs';

/**
 * POST /api/v1/auth/contexts/:membershipId/activate
 *
 * A state transition, so a verb on the resource rather than PATCH {active}
 * (§19.2). The server verifies the membership belongs to THIS account before
 * activating it — the client supplies an id, never a tenant.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ membershipId: string }> },
): Promise<Response> {
  const requestId = newRequestId();

  const token = await readSessionToken();
  if (!token) return fail(CommonErrors.FORBIDDEN, requestId);

  const parsed = ActivateContextSchema.safeParse(await params);
  if (!parsed.success) return failValidation(parsed.error.issues, requestId);

  const result = await switchContext(
    token,
    parsed.data.membershipId as MembershipId,
    { tokens: tokenGenerator },
  );
  if (!result.ok) return fail(result.error, requestId);

  return ok(result.value, { requestId });
}
