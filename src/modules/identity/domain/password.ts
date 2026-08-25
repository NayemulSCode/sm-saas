/**
 * Password login policy — pure decisions, no IO, no clock.
 *
 * Staff log in with a password; guardians never do (§8.3). A guardian's
 * credential has `password_hash NULL`, which is a normal state and must be
 * indistinguishable from a wrong password to a caller.
 */

export const LOCKOUT = {
  /** Failed attempts before the account locks. */
  maxAttempts: 5,
  lockSeconds: 15 * 60,
} as const;

export interface AccountLockState {
  readonly status: 'active' | 'locked' | 'disabled';
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

export type LoginGate =
  | { kind: 'allowed' }
  | { kind: 'locked'; until: Date }
  | { kind: 'disabled' };

/** Checked BEFORE the hash comparison, so a locked account costs no work. */
export function gateLogin(state: AccountLockState, now: Date): LoginGate {
  if (state.status === 'disabled') return { kind: 'disabled' };
  if (state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime()) {
    return { kind: 'locked', until: state.lockedUntil };
  }
  return { kind: 'allowed' };
}

/** The attempt that trips the lock is the one that REACHES the maximum. */
export function shouldLock(failedAttemptsAfterThisOne: number): boolean {
  return failedAttemptsAfterThisOne >= LOCKOUT.maxAttempts;
}

export function lockUntil(now: Date): Date {
  return new Date(now.getTime() + LOCKOUT.lockSeconds * 1000);
}

/**
 * Whether a credential can be used for password login at all.
 *
 * Returns false for an OTP-only guardian. The CALLER must still spend the same
 * time it would have spent verifying, or the response time reveals which
 * accounts have passwords (§8.7).
 */
export function hasPassword(passwordHash: string | null): boolean {
  return passwordHash !== null && passwordHash.length > 0;
}
