import { resolveSession, revokeSession, tokenGenerator } from '../../../../../modules/identity/index';
import { newRequestId, ok } from '../../../_lib/http';
import { clearSessionCookie, readSessionToken } from '../../../_lib/session-cookie';

export const runtime = 'nodejs';

/**
 * POST /api/v1/auth/logout
 *
 * Idempotent and always 200: logging out with no session, or with an already
 * revoked one, is a success from the caller's point of view. Revocation takes
 * effect on the next request because the session is server-side state, not a
 * signed token (§8.5).
 */
export async function POST(): Promise<Response> {
  const requestId = newRequestId();
  const token = await readSessionToken();

  if (token) {
    const session = await resolveSession(token, { tokens: tokenGenerator });
    if (session.ok) await revokeSession(session.value.sessionId);
  }

  return clearSessionCookie(ok({ loggedOut: true }, { requestId }));
}
