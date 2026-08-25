import { resolveSession, tokenGenerator } from '../../../../../modules/identity/index';
import { CommonErrors } from '../../../../../shared/result';
import { fail, newRequestId, ok } from '../../../_lib/http';
import { readSessionToken } from '../../../_lib/session-cookie';

export const runtime = 'nodejs';

/** GET /api/v1/auth/me — who am I, and is this tenant read-only? */
export async function GET(): Promise<Response> {
  const requestId = newRequestId();

  const token = await readSessionToken();
  if (!token) return fail(CommonErrors.FORBIDDEN, requestId);

  const session = await resolveSession(token, { tokens: tokenGenerator });
  if (!session.ok) return fail(session.error, requestId);

  return ok(
    {
      accountId: session.value.accountId,
      activeMembershipId: session.value.activeMembershipId,
      // A suspended tenant resolves but cannot write — invariant 14. The client
      // renders accordingly; the server enforces it regardless.
      readOnly: session.value.readOnly,
    },
    { requestId },
  );
}
