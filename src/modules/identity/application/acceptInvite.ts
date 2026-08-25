/**
 * Accept a staff invitation and set a password. §8.4.
 *
 * UNAUTHENTICATED: the invite token IS the credential. Runs on the platform
 * pool because the tenant is not known until the token is resolved — the same
 * reasoning as login.
 *
 * An invite is a bearer credential, so it is single-use, short-lived, hashed
 * at rest, and revocable.
 */

import { withPlatform } from '../../../db/rls';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { verifyInvite, shouldSetPassword } from '../domain/invite';
import { initialExpiry } from '../domain/session';
import type { PasswordHasher, TokenGenerator } from '../domain/ports';
import { accounts, credentials, memberships, sessions } from '../infrastructure/repositories';
import { invites } from '../infrastructure/inviteRepository';
import type { ResolvedContext } from './verifyOtp';

export const AcceptInviteErrors = defineErrors({
  /**
   * One error for an unknown, expired, consumed or revoked token.
   *
   * Distinguishing them would let a holder of a dead link probe which tokens
   * ever existed. The help-desk path is "ask for a new invite" in every case.
   */
  INVITE_INVALID: {
    code: 'INVITE_INVALID',
    messageKey: 'invite.error.invalid',
    httpStatus: 400,
  },
  /**
   * The account already has a password — they were granted a second school and
   * should sign in normally. Re-setting a password from an emailed link would
   * be a takeover vector (ADR-0006).
   */
  PASSWORD_ALREADY_SET: {
    code: 'PASSWORD_ALREADY_SET',
    messageKey: 'invite.error.passwordAlreadySet',
    httpStatus: 409,
  },
});

export interface AcceptInviteInput {
  token: string;
  password: string;
  ip?: string;
  userAgent?: string;
}

export interface AcceptInviteDeps {
  hasher: PasswordHasher;
  tokens: TokenGenerator;
  now?: () => Date;
}

export interface AcceptInviteResult {
  sessionToken: string;
  expiresAt: Date;
  contexts: ResolvedContext[];
  contextCount: number;
}

export async function acceptInvite(
  input: AcceptInviteInput,
  deps: AcceptInviteDeps,
): Promise<Result<AcceptInviteResult, DomainError>> {
  const now = deps.now?.() ?? new Date();

  return withPlatform('invite: accept a staff invitation and set a password', async (tx) => {
    const invite = await invites.byTokenHash(tx, deps.tokens.hashToken(input.token));
    if (!invite) return err(AcceptInviteErrors.INVITE_INVALID);

    const verdict = verifyInvite(
      {
        expiresAt: invite.expiresAt,
        consumedAt: invite.consumedAt,
        revokedAt: invite.revokedAt,
      },
      now,
    );
    if (verdict.kind !== 'valid') return err(AcceptInviteErrors.INVITE_INVALID);

    const acct = await accounts.byId(tx, invite.accountId);
    if (!acct || acct.status !== 'active') return err(AcceptInviteErrors.INVITE_INVALID);

    // Re-read the credential rather than trusting the invite: the account may
    // have gained a password between the invite being issued and accepted.
    const cred = await credentials.byId(tx, invite.credentialId);
    if (!cred) return err(AcceptInviteErrors.INVITE_INVALID);

    if (!shouldSetPassword(cred.passwordHash)) {
      // Consume it anyway: the membership is already active, and leaving a
      // live link lying around is worse than closing it.
      await invites.consume(tx, invite.id);
      return err(AcceptInviteErrors.PASSWORD_ALREADY_SET);
    }

    await invites.setPassword(tx, cred.id, await deps.hasher.hash(input.password));

    // Consumed before the session exists: a crash after this point costs the
    // user a fresh invite rather than leaving a reusable link.
    await invites.consume(tx, invite.id);

    const contexts = await memberships.contextsForAccount(tx, invite.accountId);
    const { token, hash } = deps.tokens.newSessionToken();
    const expiresAt = initialExpiry(now, 'staff');

    const created = await sessions.create(tx, {
      accountId: invite.accountId,
      tokenHash: hash,
      expiresAt,
      ...(input.ip !== undefined ? { ip: input.ip } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });

    const only = contexts.length === 1 ? contexts[0] : undefined;
    if (created && only) {
      await sessions.setActiveMembership(tx, created.id, only.membershipId);
    }
    await accounts.recordSuccessfulLogin(tx, invite.accountId);

    return ok({
      sessionToken: token,
      expiresAt,
      contexts: contexts.map((c) => ({
        membershipId: c.membershipId,
        tenantId: c.tenantId,
        personId: c.personId,
      })),
      contextCount: contexts.length,
    });
  });
}
