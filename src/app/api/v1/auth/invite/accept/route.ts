import type { NextRequest } from 'next/server';
import {
  acceptInvite,
  AcceptInviteSchema,
  passwordHasher,
  tokenGenerator,
} from '../../../../../../modules/identity/index';
import { rateLimiter } from '../../../../../../shared/rate-limiter';
import {
  clientIp,
  fail,
  failRateLimited,
  failValidation,
  newRequestId,
  ok,
} from '../../../../_lib/http';
import { setSessionCookie } from '../../../../_lib/session-cookie';

export const runtime = 'nodejs';

/**
 * POST /api/v1/auth/invite/accept
 *
 * UNAUTHENTICATED: the invite token IS the credential. Sets the password and
 * opens a session, so the new staff member lands signed in rather than being
 * bounced to a login form they have no password for yet.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = newRequestId();

  const parsed = AcceptInviteSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return failValidation(parsed.error.issues, requestId);

  // The token is 32 bytes of CSPRNG and unguessable, but Argon2id hashing on
  // an unauthenticated endpoint is a CPU amplifier worth bounding.
  const guard = await rateLimiter.check(`invite:ip:${clientIp(req)}`, 20, 900);
  if (!guard.allowed) return failRateLimited(guard.retryAfterSeconds, requestId);

  const ip = clientIp(req);
  const ua = req.headers.get('user-agent');
  const result = await acceptInvite(
    {
      token: parsed.data.token,
      password: parsed.data.password,
      ...(ip !== 'unknown' ? { ip } : {}),
      ...(ua ? { userAgent: ua } : {}),
    },
    { hasher: passwordHasher, tokens: tokenGenerator },
  );

  if (!result.ok) return fail(result.error, requestId);

  const res = ok(
    { contexts: result.value.contexts, contextCount: result.value.contextCount },
    { requestId },
  );
  return setSessionCookie(res, result.value.sessionToken, result.value.expiresAt);
}
