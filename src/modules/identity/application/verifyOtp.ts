/**
 * Verify a login code and open a session. §8.2, §8.4.
 *
 * UNAUTHENTICATED, like requestOtp, and for the same reason: this is where the
 * account's tenants are discovered. Runs on the platform pool.
 */

import { withPlatform } from '../../../db/rls';
import { recordAuthEvent } from '../../../db/audit';
import {
  type Result,
  ok,
  err,
  type DomainError,
  defineErrors,
} from '../../../shared/result';
import { normaliseIdentifier } from '../domain/phone';
import { verifyChallenge } from '../domain/otp';
import { initialExpiry, type SessionAudience } from '../domain/session';
import type { CodeHasher, TokenGenerator } from '../domain/ports';
import {
  accounts,
  credentials,
  memberships,
  otpChallenges,
  sessions,
} from '../infrastructure/repositories';

/**
 * One error for every failed-login reason.
 *
 * `INVALID_CODE` covers an unknown identifier, a wrong code, an expired
 * challenge and a disabled account alike. Distinguishing them would turn this
 * endpoint into a tool for discovering which phone numbers are enrolled.
 */
export const IdentityErrors = defineErrors({
  INVALID_CODE: {
    code: 'INVALID_CODE',
    messageKey: 'auth.error.invalidCode',
    httpStatus: 401,
  },
  ACCOUNT_LOCKED: {
    code: 'ACCOUNT_LOCKED',
    messageKey: 'auth.error.accountLocked',
    httpStatus: 423,
  },
  NO_MEMBERSHIP: {
    code: 'NO_MEMBERSHIP',
    messageKey: 'auth.error.noMembership',
    httpStatus: 403,
  },
});

export interface VerifyOtpInput {
  identifier: string;
  code: string;
  ip?: string;
  userAgent?: string;
  requestId?: string | undefined;
}

export interface VerifyOtpDeps {
  codeHasher: CodeHasher;
  tokens: TokenGenerator;
  now?: () => Date;
}

export interface ResolvedContext {
  membershipId: string;
  tenantId: string;
  personId: string;
}

export interface VerifyOtpResult {
  sessionToken: string;
  expiresAt: Date;
  contexts: ResolvedContext[];
  /** >1 means the switcher is shown; 1 activates immediately (§8.4). */
  contextCount: number;
}

export async function verifyOtp(
  input: VerifyOtpInput,
  deps: VerifyOtpDeps,
): Promise<Result<VerifyOtpResult, DomainError>> {
  const now = deps.now?.() ?? new Date();

  const identifier = normaliseIdentifier(input.identifier);
  // Same error as a wrong code: a malformed identifier must not be
  // distinguishable from an unknown one.
  if (!identifier.ok) return err(IdentityErrors.INVALID_CODE);

  const meta = { requestId: input.requestId, ip: input.ip, userAgent: input.userAgent };

  return withPlatform('login: verify an OTP challenge and open a session', async (tx) => {
    /*
     * Every rejection is recorded, and all of them return the same neutral
     * error to the caller. The audit trail is where the difference lives —
     * "wrong code" and "unknown number" are the same 400 to an attacker and
     * two very different rows to an investigator.
     */
    const refuse = async (
      reason: string,
      extra: { accountId?: string; credentialId?: string } = {},
    ): Promise<void> => {
      await recordAuthEvent(tx, {
        ...meta,
        ...extra,
        type: 'otp.verified',
        outcome: 'failure',
        identifier: identifier.value.value,
        reason,
      });
    };

    const cred = await credentials.byIdentifier(
      tx,
      identifier.value.kind,
      identifier.value.value,
    );
    if (!cred) {
      await refuse('unknown_identifier');
      return err(IdentityErrors.INVALID_CODE);
    }

    const ids = { accountId: cred.accountId, credentialId: cred.id };

    const acct = await accounts.byId(tx, cred.accountId);
    if (!acct || acct.status !== 'active') {
      await refuse('account_inactive', ids);
      return err(IdentityErrors.INVALID_CODE);
    }
    if (acct.lockedUntil && acct.lockedUntil.getTime() > now.getTime()) {
      await refuse('account_locked', ids);
      return err(IdentityErrors.ACCOUNT_LOCKED);
    }

    const live = await otpChallenges.liveFor(tx, cred.id, now);
    if (!live) {
      await refuse('no_live_challenge', ids);
      return err(IdentityErrors.INVALID_CODE);
    }

    const verdict = verifyChallenge(
      {
        codeHash: live.codeHash.toString('hex'),
        expiresAt: live.expiresAt,
        attempts: live.attempts,
        consumedAt: live.consumedAt,
      },
      deps.codeHasher.hash(input.code),
      now,
      (a, b) => deps.codeHasher.equals(a, b),
    );

    if (verdict.kind !== 'valid') {
      // The attempt is recorded even for an expired or consumed challenge, so
      // the counter cannot be reset by racing a stale one.
      await otpChallenges.recordAttempt(tx, live.id);
      await refuse(`challenge_${verdict.kind}`, ids);
      return err(IdentityErrors.INVALID_CODE);
    }

    // Single use, consumed before the session exists: a crash after this point
    // costs the user a resend rather than leaving a reusable code.
    await otpChallenges.consume(tx, live.id);

    const contexts = await memberships.contextsForAccount(tx, cred.accountId);
    if (contexts.length === 0) {
      // The account exists but belongs nowhere. A neutral 403 — there is
      // nothing for this person to be shown.
      await refuse('no_membership', ids);
      return err(IdentityErrors.NO_MEMBERSHIP);
    }

    // Guardians get long rolling sessions; staff sessions are short because
    // they sit on a shared office desktop. Audience is refined once the
    // person's roles are known; the conservative default is `staff`.
    const audience: SessionAudience = 'staff';
    const { token, hash } = deps.tokens.newSessionToken();
    const expiresAt = initialExpiry(now, audience);

    const created = await sessions.create(tx, {
      accountId: cred.accountId,
      tokenHash: hash,
      expiresAt,
      ...(input.ip !== undefined ? { ip: input.ip } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });

    // A single context activates immediately; several show the switcher.
    const only = contexts.length === 1 ? contexts[0] : undefined;
    if (created && only) {
      await sessions.setActiveMembership(tx, created.id, only.membershipId);
    }

    await accounts.recordSuccessfulLogin(tx, cred.accountId);

    await recordAuthEvent(tx, {
      ...meta,
      ...ids,
      type: 'session.created',
      outcome: 'success',
      sessionId: created?.id,
      identifier: identifier.value.value,
      detail: { method: 'otp', autoActivated: Boolean(only), contexts: contexts.length },
    });

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
