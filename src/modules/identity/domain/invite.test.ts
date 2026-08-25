import { describe, it, expect } from 'vitest';
import {
  INVITE,
  inviteExpiryFrom,
  verifyInvite,
  shouldSetPassword,
  type InviteState,
} from './invite';

const NOW = new Date('2027-01-15T08:30:00Z');
const state = (over: Partial<InviteState> = {}): InviteState => ({
  expiresAt: new Date(NOW.getTime() + 60_000),
  consumedAt: null,
  revokedAt: null,
  ...over,
});

describe('inviteExpiryFrom', () => {
  it('is seven days out', () => {
    expect(inviteExpiryFrom(NOW).getTime() - NOW.getTime()).toBe(INVITE.ttlSeconds * 1000);
  });
});

describe('verifyInvite', () => {
  it('accepts a live invite', () => {
    expect(verifyInvite(state(), NOW)).toEqual({ kind: 'valid' });
  });

  // Single use: whoever holds the link can take the account, so it must die
  // the moment it is used.
  it('refuses a consumed invite', () => {
    expect(verifyInvite(state({ consumedAt: NOW }), NOW)).toEqual({ kind: 'already_used' });
  });

  it('expires exactly at the boundary', () => {
    const expiresAt = new Date(NOW.getTime() + 1000);
    expect(verifyInvite(state({ expiresAt }), new Date(expiresAt.getTime() - 1))).toEqual({
      kind: 'valid',
    });
    expect(verifyInvite(state({ expiresAt }), expiresAt)).toEqual({ kind: 'expired' });
  });

  it('refuses a revoked invite', () => {
    expect(verifyInvite(state({ revokedAt: NOW }), NOW)).toEqual({ kind: 'revoked' });
  });

  // Revoked and expired call for different help-desk actions, so the
  // deliberate cancellation is the one reported.
  it('reports revoked ahead of expired and used', () => {
    const s = state({
      revokedAt: NOW,
      consumedAt: NOW,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    expect(verifyInvite(s, NOW)).toEqual({ kind: 'revoked' });
  });
});

describe('shouldSetPassword', () => {
  it('sets one for a brand-new account', () => {
    expect(shouldSetPassword(null)).toBe(true);
    expect(shouldSetPassword('')).toBe(true);
  });

  // A teacher at School A invited by School B keeps their existing password.
  // Re-setting it from an emailed link would be a takeover vector.
  it('refuses to reset an existing password', () => {
    expect(shouldSetPassword('$argon2id$v=19$...')).toBe(false);
  });
});
