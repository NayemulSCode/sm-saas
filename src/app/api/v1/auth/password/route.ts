import type { NextRequest } from 'next/server';
import {
  authenticatePassword,
  PasswordLoginSchema,
  passwordHasher,
  tokenGenerator,
} from '../../../../../modules/identity/index';
import { rateLimiter } from '../../../../../shared/rate-limiter';
import {
  clientIp,
  fail,
  failRateLimited,
  failValidation,
  newRequestId,
  ok,
} from '../../../_lib/http';
import { setSessionCookie } from '../../../_lib/session-cookie';

export const runtime = 'nodejs';

/**
 * POST /api/v1/auth/password — staff login.
 *
 * Guardians have no password and never reach this route; their path is
 * phone OTP (§8.2).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = newRequestId();

  const parsed = PasswordLoginSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return failValidation(parsed.error.issues, requestId);

  // Per-identifier lockout lives in the domain and survives a restart. This is
  // the cheap outer guard: it stops a spray across many accounts from one
  // source before any Argon2id work is done.
  const guard = await rateLimiter.check(`pw:ip:${clientIp(req)}`, 30, 900);
  if (!guard.allowed) return failRateLimited(guard.retryAfterSeconds, requestId);

  const ip = clientIp(req);
  const ua = req.headers.get('user-agent');
  const result = await authenticatePassword(
    {
      identifier: parsed.data.identifier,
      password: parsed.data.password,
      requestId,
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
