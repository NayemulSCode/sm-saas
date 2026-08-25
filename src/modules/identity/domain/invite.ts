/**
 * Staff invitation policy — pure. §8.4.
 *
 * An invite is a bearer credential: whoever holds the link can set a password
 * and take the account. So it is single-use, short-lived, hashed at rest, and
 * revocable — the same discipline as an OTP code, for the same reason.
 */

export const INVITE = {
  /** Long enough to survive a weekend, short enough that a leaked link dies. */
  ttlSeconds: 7 * 24 * 60 * 60,
  /** 32 bytes of CSPRNG, like a session token. */
  tokenBytes: 32,
  minPasswordLength: 8,
  maxPasswordLength: 200,
} as const;

export interface InviteState {
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
}

export type InviteVerdict =
  | { kind: 'valid' }
  | { kind: 'expired' }
  | { kind: 'already_used' }
  | { kind: 'revoked' };

export function inviteExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITE.ttlSeconds * 1000);
}

/**
 * Revoked is reported first: an invite that was deliberately cancelled should
 * say so even if it has also expired, because the two call for different
 * actions from whoever is helping the user.
 */
export function verifyInvite(state: InviteState, now: Date): InviteVerdict {
  if (state.revokedAt !== null) return { kind: 'revoked' };
  if (state.consumedAt !== null) return { kind: 'already_used' };
  if (now.getTime() >= state.expiresAt.getTime()) return { kind: 'expired' };
  return { kind: 'valid' };
}

/**
 * Whether accepting this invite should set a password.
 *
 * A teacher at School A invited by School B already has an account and a
 * password; the invite grants them a second membership, not a new identity
 * (ADR-0006). Re-setting their password from an emailed link would be a
 * takeover vector, so it is refused.
 */
export function shouldSetPassword(existingPasswordHash: string | null): boolean {
  return existingPasswordHash === null || existingPasswordHash.length === 0;
}
