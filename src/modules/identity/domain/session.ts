/**
 * Session policy — pure. §8.5.
 *
 * Opaque server-side tokens, not JWTs: NFR §4.6 requires a compromised session
 * to be revocable within 60 seconds, and a stateless token cannot do that
 * without a revocation list, which is a session table with worse ergonomics.
 */

/**
 * Guardians get long rolling sessions because re-authenticating costs an SMS
 * and they visit rarely. Staff get short idle timeouts because they work on a
 * shared office desktop.
 */
export const SESSION_POLICY = {
  staff: { idleSeconds: 12 * 60 * 60, absoluteSeconds: 30 * 24 * 60 * 60 },
  guardian: { idleSeconds: 30 * 24 * 60 * 60, absoluteSeconds: 90 * 24 * 60 * 60 },
} as const;

export type SessionAudience = keyof typeof SESSION_POLICY;

export interface SessionState {
  readonly issuedAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export type SessionVerdict =
  | { kind: 'active' }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'idle_timeout' };

export function initialExpiry(now: Date, audience: SessionAudience): Date {
  return new Date(now.getTime() + SESSION_POLICY[audience].absoluteSeconds * 1000);
}

export function evaluateSession(
  state: SessionState,
  audience: SessionAudience,
  now: Date,
): SessionVerdict {
  if (state.revokedAt !== null) return { kind: 'revoked' };
  if (now.getTime() >= state.expiresAt.getTime()) return { kind: 'expired' };

  const idleLimit = SESSION_POLICY[audience].idleSeconds * 1000;
  if (now.getTime() - state.lastSeenAt.getTime() >= idleLimit) {
    return { kind: 'idle_timeout' };
  }
  return { kind: 'active' };
}

/**
 * `last_seen_at` is written at most once every five minutes.
 *
 * Every authenticated request touches the session row; writing on each one
 * turns a read-mostly table into the hottest write in the system for no
 * behavioural gain.
 */
export const LAST_SEEN_WRITE_INTERVAL_SECONDS = 5 * 60;

export function shouldTouchLastSeen(state: SessionState, now: Date): boolean {
  return (
    now.getTime() - state.lastSeenAt.getTime() >=
    LAST_SEEN_WRITE_INTERVAL_SECONDS * 1000
  );
}
