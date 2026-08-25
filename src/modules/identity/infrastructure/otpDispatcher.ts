/**
 * OTP delivery.
 *
 * The notification module owns SMS and ships in Phase 3b, where this becomes a
 * pg-boss enqueue INSIDE the login transaction — so a code can never be
 * delivered for a challenge that rolled back (invariant 9, ADR-0010).
 *
 * Until then: a mock that logs. `SMS_PROVIDER=mock` is the default everywhere
 * except production, and **no test or CI run ever sends a real SMS** (§15.6).
 */

import type { OtpDispatcher } from '../domain/ports';
import { env } from '../../../config/env';

/** Logs the code. Development and test only. */
export const mockOtpDispatcher: OtpDispatcher = {
  async send(to, code) {
    // No PII beyond the destination, which the operator already has; the code
    // is short-lived and hashed at rest. Never enabled in production.
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'otp.dispatch.mock',
        to: to.value,
        code,
        at: new Date().toISOString(),
      }),
    );
  },
};

/** Refuses to send rather than silently dropping a login code. */
const unconfiguredDispatcher: OtpDispatcher = {
  async send() {
    throw new Error(
      'No SMS provider configured. Set SMS_PROVIDER, or use `mock` outside production.',
    );
  },
};

export function otpDispatcher(): OtpDispatcher {
  const config = env();
  if (config.SMS_PROVIDER === 'mock') {
    if (config.NODE_ENV === 'production') {
      // A mock dispatcher in production means guardians silently never receive
      // a code, and the failure looks like "OTP does not work" for weeks.
      throw new Error('SMS_PROVIDER=mock is not permitted in production.');
    }
    return mockOtpDispatcher;
  }
  // provider_a / provider_b adapters arrive with the notification module.
  return unconfiguredDispatcher;
}
