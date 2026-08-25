import { describe, it, expect } from 'vitest';
import {
  SESSION_POLICY,
  initialExpiry,
  evaluateSession,
  shouldTouchLastSeen,
  LAST_SEEN_WRITE_INTERVAL_SECONDS,
  type SessionState,
} from './session';

const NOW = new Date('2027-01-15T08:30:00Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const ahead = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const state = (over: Partial<SessionState> = {}): SessionState => ({
  issuedAt: ago(60),
  lastSeenAt: ago(60),
  expiresAt: ahead(3600),
  revokedAt: null,
  ...over,
});

describe('initialExpiry', () => {
  it('gives guardians a longer absolute life than staff', () => {
    const staff = initialExpiry(NOW, 'staff').getTime() - NOW.getTime();
    const guardian = initialExpiry(NOW, 'guardian').getTime() - NOW.getTime();
    expect(guardian).toBeGreaterThan(staff);
    expect(staff).toBe(SESSION_POLICY.staff.absoluteSeconds * 1000);
  });
});

describe('evaluateSession', () => {
  it('accepts a fresh session', () => {
    expect(evaluateSession(state(), 'staff', NOW)).toEqual({ kind: 'active' });
  });

  // Revocation must take effect within 60 s (NFR §4.6), which is only possible
  // because the check is a database read rather than a token signature.
  it('reports revoked before anything else', () => {
    const s = state({ revokedAt: ago(1), expiresAt: ago(1) });
    expect(evaluateSession(s, 'staff', NOW)).toEqual({ kind: 'revoked' });
  });

  it('expires exactly at the boundary', () => {
    const expiresAt = ahead(10);
    const s = state({ expiresAt });
    expect(evaluateSession(s, 'staff', new Date(expiresAt.getTime() - 1))).toEqual({
      kind: 'active',
    });
    expect(evaluateSession(s, 'staff', expiresAt)).toEqual({ kind: 'expired' });
  });

  it('applies the staff idle timeout', () => {
    const idle = SESSION_POLICY.staff.idleSeconds;
    expect(evaluateSession(state({ lastSeenAt: ago(idle - 1) }), 'staff', NOW)).toEqual({
      kind: 'active',
    });
    expect(evaluateSession(state({ lastSeenAt: ago(idle) }), 'staff', NOW)).toEqual({
      kind: 'idle_timeout',
    });
  });

  // A guardian visits twice a year; timing them out on the staff schedule would
  // cost an SMS every single visit.
  it('does not idle out a guardian on the staff schedule', () => {
    const s = state({ lastSeenAt: ago(SESSION_POLICY.staff.idleSeconds + 60) });
    expect(evaluateSession(s, 'staff', NOW)).toEqual({ kind: 'idle_timeout' });
    expect(evaluateSession(s, 'guardian', NOW)).toEqual({ kind: 'active' });
  });
});

describe('shouldTouchLastSeen', () => {
  // Every authenticated request touches the session row; writing on each one
  // turns a read-mostly table into the hottest write in the system.
  it('throttles the write to once per interval', () => {
    expect(shouldTouchLastSeen(state({ lastSeenAt: ago(10) }), NOW)).toBe(false);
    expect(
      shouldTouchLastSeen(
        state({ lastSeenAt: ago(LAST_SEEN_WRITE_INTERVAL_SECONDS) }),
        NOW,
      ),
    ).toBe(true);
  });
});
