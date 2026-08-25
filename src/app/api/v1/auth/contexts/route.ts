import { listContexts, tokenGenerator } from '../../../../../modules/identity/index';
import { CommonErrors } from '../../../../../shared/result';
import { fail, newRequestId, ok } from '../../../_lib/http';
import { readSessionToken } from '../../../_lib/session-cookie';

export const runtime = 'nodejs';

/**
 * GET /api/v1/auth/contexts — the switcher list.
 *
 * Built from VERIFIED memberships on the server. The client never supplies the
 * set of tenants it may see (§8.4).
 */
export async function GET(): Promise<Response> {
  const requestId = newRequestId();

  const token = await readSessionToken();
  if (!token) return fail(CommonErrors.FORBIDDEN, requestId);

  const contexts = await listContexts(token, { tokens: tokenGenerator });
  if (!contexts.ok) return fail(contexts.error, requestId);

  return ok({ contexts: contexts.value, count: contexts.value.length }, { requestId });
}
