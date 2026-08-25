import type { NextRequest } from 'next/server';
import {
  requestOtp,
  OtpRequestSchema,
  OTP,
  codeHasher,
  randomSource,
  otpDispatcher,
} from '../../../../../../modules/identity/index';
import { rateLimiter } from '../../../../../../shared/rate-limiter';
import { clientIp, failRateLimited, failValidation, newRequestId, ok } from '../../../../_lib/http';

/** Node runtime: this path reaches PostgreSQL, which the edge runtime cannot. */
export const runtime = 'nodejs';

/**
 * POST /api/v1/auth/otp/request
 *
 * Always answers 200 with the same body, whether or not the account exists.
 * An endpoint that distinguishes them is a tool for discovering which phone
 * numbers are enrolled at a school (§8.2).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = newRequestId();

  const parsed = OtpRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return failValidation(parsed.error.issues, requestId);

  // Two limits, deliberately. Per identifier is the real control — it does not
  // depend on a header a caller can forge. Per IP catches broad sweeps.
  const perIdentifier = await rateLimiter.check(
    `otp:id:${parsed.data.identifier}`,
    OTP.maxRequestsPerWindow,
    OTP.requestWindowSeconds,
  );
  const perIp = await rateLimiter.check(`otp:ip:${clientIp(req)}`, 20, 3600);

  if (!perIdentifier.allowed || !perIp.allowed) {
    return failRateLimited(
      Math.max(perIdentifier.retryAfterSeconds, perIp.retryAfterSeconds),
      requestId,
    );
  }

  await requestOtp(
    { identifier: parsed.data.identifier },
    { codeHasher, random: randomSource, dispatcher: otpDispatcher() },
  );

  return ok({ accepted: true, expiresInSeconds: OTP.ttlSeconds }, { requestId });
}
