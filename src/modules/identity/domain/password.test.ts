import { describe, it, expect } from 'vitest';
import {
  LOCKOUT,
  gateLogin,
  shouldLock,
  lockUntil,
  hasPassword,
  type AccountLockState,
} from './password';

const NOW = new Date('2027-01-15T08:30:00Z');
const state = (over: Partial<AccountLockState> = {}): AccountLockState => ({
  status: 'active',
  failedAttempts: 0,
  lockedUntil: null,
  ...over,
});

describe('gateLogin', () => {
  it('allows an active, unlocked account', () => {
    expect(gateLogin(state(), NOW)).toEqual({ kind: 'allowed' });
  });

  it('refuses a disabled account', () => {
    expect(gateLogin(state({ status: 'disabled' }), NOW)).toEqual({ kind: 'disabled' });
  });

  it('locks until the boundary, then allows again', () => {
    const until = new Date(NOW.getTime() + 1000);
    const s = state({ lockedUntil: until });
    expect(gateLogin(s, NOW)).toEqual({ kind: 'locked', until });
    // At the instant it expires, the account is usable again.
    expect(gateLogin(s, until)).toEqual({ kind: 'allowed' });
  });

  it('ignores a stale lock', () => {
    expect(gateLogin(state({ lockedUntil: new Date(NOW.getTime() - 1) }), NOW)).toEqual({
      kind: 'allowed',
    });
  });

  // Disabled outranks locked: a disabled account is not merely waiting.
  it('reports disabled before locked', () => {
    const s = state({ status: 'disabled', lockedUntil: new Date(NOW.getTime() + 1000) });
    expect(gateLogin(s, NOW)).toEqual({ kind: 'disabled' });
  });
});

describe('shouldLock', () => {
  it('trips on the attempt that reaches the maximum, not before', () => {
    expect(shouldLock(LOCKOUT.maxAttempts - 1)).toBe(false);
    expect(shouldLock(LOCKOUT.maxAttempts)).toBe(true);
    expect(shouldLock(LOCKOUT.maxAttempts + 1)).toBe(true);
  });
});

describe('lockUntil', () => {
  it('is fifteen minutes out', () => {
    expect(lockUntil(NOW).getTime() - NOW.getTime()).toBe(LOCKOUT.lockSeconds * 1000);
  });
});

describe('hasPassword', () => {
  // An OTP-only guardian has password_hash NULL. That is a normal state, not
  // an error, and must not be distinguishable from a wrong password.
  it('is false for a guardian with no password', () => {
    expect(hasPassword(null)).toBe(false);
    expect(hasPassword('')).toBe(false);
  });

  it('is true for a staff member with one', () => {
    expect(hasPassword('$argon2id$v=19$...')).toBe(true);
  });
});
