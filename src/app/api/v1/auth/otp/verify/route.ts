import type { NextRequest } from 'next/server';
import {
  verifyOtp,
  OtpVerifySchema,
  codeHasher,
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
 * POST /api/v1/auth/otp/verify
 *
 * On success sets the session cookie and returns the available contexts.
 * `contextCount > 1` means the switcher is shown rather than a school being
 * chosen for the user (§8.4).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = newRequestId();

  const parsed = OtpVerifySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return failValidation(parsed.error.issues, requestId);

  // Guessing is bounded per challenge by the attempt counter; this bounds
  // guessing ACROSS challenges from one source.
  const guard = await rateLimiter.check(`otp:verify:${clientIp(req)}`, 30, 900);
  if (!guard.allowed) return failRateLimited(guard.retryAfterSeconds, requestId);

  const result = await verifyOtp(
    {
      identifier: parsed.data.identifier,
      code: parsed.data.code,
      requestId,
      ...(clientIp(req) !== 'unknown' ? { ip: clientIp(req) } : {}),
      ...(req.headers.get('user-agent')
        ? { userAgent: req.headers.get('user-agent')! }
        : {}),
    },
    { codeHasher, tokens: tokenGenerator },
  );

  if (!result.ok) return fail(result.error, requestId);

  const res = ok(
    {
      contexts: result.value.contexts,
      contextCount: result.value.contextCount,
      // The token is NOT in the body: it goes in an HttpOnly cookie so page
      // scripts cannot read it.
    },
    { requestId },
  );
  return setSessionCookie(res, result.value.sessionToken, result.value.expiresAt);
}
