/**
 * OTP policy — pure decisions, no IO, no clock, no randomness.
 *
 * Randomness and hashing are injected, so every rule below is exhaustively
 * testable: expiry at the boundary second, the fifth attempt versus the sixth,
 * a consumed code being replayed.
 *
 * Phone OTP is the guardian's ONLY login method. That is also how credential
 * distribution to thousands of guardians is solved — there is nothing to
 * distribute (§8.2).
 */

export const OTP = {
  /** Six digits: enough entropy given five attempts and a five-minute window. */
  digits: 6,
  ttlSeconds: 5 * 60,
  maxAttempts: 5,
  /** Requests per identifier per window, before the transport is asked. Each
   *  OTP is a billable SMS, so this is a spend control as much as a security
   *  one (§8.2). */
  maxRequestsPerWindow: 3,
  requestWindowSeconds: 15 * 60,
} as const;

export interface OtpChallengeState {
  readonly codeHash: string;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly consumedAt: Date | null;
}

export type OtpVerdict =
  | { kind: 'valid' }
  | { kind: 'expired' }
  | { kind: 'already_used' }
  | { kind: 'too_many_attempts' }
  | { kind: 'mismatch'; attemptsRemaining: number };

/**
 * Generates a zero-padded code from an injected random source.
 * `randomInt(max)` must return a uniformly distributed integer in [0, max).
 */
export function generateCode(randomInt: (maxExclusive: number) => number): string {
  const max = 10 ** OTP.digits;
  return String(randomInt(max)).padStart(OTP.digits, '0');
}

export function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + OTP.ttlSeconds * 1000);
}

/**
 * The order of these checks is deliberate.
 *
 * `already_used` and `expired` are reported before the hash is compared, so a
 * spent or stale challenge costs nothing. `too_many_attempts` is checked before
 * comparison too — otherwise the attempt counter could be bypassed by a caller
 * that ignores the verdict.
 */
export function verifyChallenge(
  state: OtpChallengeState,
  candidateHash: string,
  now: Date,
  equals: (a: string, b: string) => boolean,
): OtpVerdict {
  if (state.consumedAt !== null) return { kind: 'already_used' };
  if (now.getTime() >= state.expiresAt.getTime()) return { kind: 'expired' };
  if (state.attempts >= OTP.maxAttempts) return { kind: 'too_many_attempts' };

  // Constant-time comparison is the caller's contract, hence the injected
  // `equals` rather than `===`.
  if (!equals(state.codeHash, candidateHash)) {
    return { kind: 'mismatch', attemptsRemaining: OTP.maxAttempts - state.attempts - 1 };
  }
  return { kind: 'valid' };
}

/**
 * A resend reuses the live challenge rather than minting a second code.
 *
 * Two valid codes for one identifier doubles the guessing surface and doubles
 * the SMS bill for a user who taps "resend" twice.
 */
export function shouldReuseChallenge(
  existing: OtpChallengeState | null,
  now: Date,
): boolean {
  if (existing === null) return false;
  if (existing.consumedAt !== null) return false;
  return now.getTime() < existing.expiresAt.getTime();
}
