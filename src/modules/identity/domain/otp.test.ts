import { describe, it, expect } from 'vitest';
import {
  OTP,
  generateCode,
  expiryFrom,
  verifyChallenge,
  shouldReuseChallenge,
  type OtpChallengeState,
} from './otp.js';

const NOW = new Date('2027-01-15T08:30:00Z');
const eq = (a: string, b: string) => a === b;

const challenge = (over: Partial<OtpChallengeState> = {}): OtpChallengeState => ({
  codeHash: 'HASH',
  expiresAt: new Date(NOW.getTime() + 60_000),
  attempts: 0,
  consumedAt: null,
  ...over,
});

describe('generateCode', () => {
  it('is always six digits, zero-padded', () => {
    expect(generateCode(() => 0)).toBe('000000');
    expect(generateCode(() => 7)).toBe('000007');
    expect(generateCode(() => 999_999)).toBe('999999');
  });

  it('asks for the full six-digit range', () => {
    let seen = -1;
    generateCode((max) => {
      seen = max;
      return 0;
    });
    expect(seen).toBe(10 ** OTP.digits);
  });
});

describe('expiryFrom', () => {
  it('is five minutes out', () => {
    expect(expiryFrom(NOW).getTime() - NOW.getTime()).toBe(OTP.ttlSeconds * 1000);
  });
});

describe('verifyChallenge', () => {
  it('accepts the right code', () => {
    expect(verifyChallenge(challenge(), 'HASH', NOW, eq)).toEqual({ kind: 'valid' });
  });

  it('reports a mismatch with the attempts left', () => {
    expect(verifyChallenge(challenge({ attempts: 1 }), 'WRONG', NOW, eq)).toEqual({
      kind: 'mismatch',
      attemptsRemaining: OTP.maxAttempts - 2,
    });
  });

  // Single use: a code that already logged someone in must not work twice.
  it('refuses a consumed challenge even with the right code', () => {
    expect(verifyChallenge(challenge({ consumedAt: NOW }), 'HASH', NOW, eq)).toEqual({
      kind: 'already_used',
    });
  });

  it('expires exactly at the boundary, not after it', () => {
    const expiresAt = new Date(NOW.getTime() + 1000);
    const state = challenge({ expiresAt });
    expect(verifyChallenge(state, 'HASH', new Date(expiresAt.getTime() - 1), eq)).toEqual({
      kind: 'valid',
    });
    expect(verifyChallenge(state, 'HASH', expiresAt, eq)).toEqual({ kind: 'expired' });
  });

  it('locks out on the sixth attempt, not the fifth', () => {
    const atLimit = challenge({ attempts: OTP.maxAttempts - 1 });
    expect(verifyChallenge(atLimit, 'WRONG', NOW, eq)).toEqual({
      kind: 'mismatch',
      attemptsRemaining: 0,
    });

    const overLimit = challenge({ attempts: OTP.maxAttempts });
    expect(verifyChallenge(overLimit, 'HASH', NOW, eq)).toEqual({
      kind: 'too_many_attempts',
    });
  });

  // The counter must not be bypassable by a caller that supplies the right
  // code after exhausting its attempts.
  it('refuses a correct code once attempts are exhausted', () => {
    expect(
      verifyChallenge(challenge({ attempts: OTP.maxAttempts }), 'HASH', NOW, eq),
    ).toEqual({ kind: 'too_many_attempts' });
  });

  it('reports used before expired for a consumed AND stale challenge', () => {
    const state = challenge({
      consumedAt: NOW,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    expect(verifyChallenge(state, 'HASH', NOW, eq)).toEqual({ kind: 'already_used' });
  });

  it('uses the injected comparator rather than ===', () => {
    let called = false;
    verifyChallenge(challenge(), 'HASH', NOW, (a, b) => {
      called = true;
      return a === b;
    });
    expect(called).toBe(true);
  });
});

describe('shouldReuseChallenge', () => {
  // Two live codes for one identifier doubles the guessing surface AND the SMS
  // bill for a user who taps resend twice.
  it('reuses a live challenge', () => {
    expect(shouldReuseChallenge(challenge(), NOW)).toBe(true);
  });

  it('does not reuse an expired one', () => {
    expect(
      shouldReuseChallenge(challenge({ expiresAt: new Date(NOW.getTime() - 1) }), NOW),
    ).toBe(false);
  });

  it('does not reuse a consumed one', () => {
    expect(shouldReuseChallenge(challenge({ consumedAt: NOW }), NOW)).toBe(false);
  });

  it('mints a new one when there is none', () => {
    expect(shouldReuseChallenge(null, NOW)).toBe(false);
  });
});
