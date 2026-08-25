/**
 * The authentication guard for route handlers.
 *
 * Every protected handler starts with `requireAuth()`. It returns either a
 * fully-built AuthContext or a Response to send back — so a handler cannot
 * accidentally continue with a half-resolved context.
 */

import { resolveAuthContext } from '../../../modules/identity/index';
import { tokenGenerator } from '../../../modules/identity/index';
import { CommonErrors } from '../../../shared/result';
import type { AuthContext } from '../../../shared/auth-context';
import { AuthorizationError } from '../../../shared/auth-context';
import { fail } from './http';
import { readSessionToken } from './session-cookie';

export type Authenticated =
  | { ok: true; ctx: AuthContext }
  | { ok: false; response: Response };

export async function requireAuth(requestId: string): Promise<Authenticated> {
  const token = await readSessionToken();
  if (!token) return { ok: false, response: fail(CommonErrors.FORBIDDEN, requestId) };

  const resolved = await resolveAuthContext(token, { tokens: tokenGenerator, requestId });
  if (!resolved.ok) return { ok: false, response: fail(resolved.error, requestId) };

  return { ok: true, ctx: resolved.value };
}

/**
 * Maps an AuthorizationError thrown by `authorize()` to a response.
 *
 * The domain throws rather than returning for authorization, because a use
 * case that forgets to handle the failure must not continue — so the mapping
 * lives here, at the edge, and every protected handler wraps its call.
 */
export function toAuthFailure(e: unknown, requestId: string): Response | undefined {
  if (!(e instanceof AuthorizationError)) return undefined;
  if (e.kind === 'read_only') {
    return fail(CommonErrors.TENANT_SUSPENDED, requestId);
  }
  return fail(CommonErrors.FORBIDDEN, requestId);
}
