/**
 * Request a login code. §8.2.
 *
 * UNAUTHENTICATED — there is no AuthContext yet, and no tenant either: the
 * whole point of login is to discover which tenants this account belongs to.
 * It therefore runs on the platform pool rather than through `withTenant`,
 * which is one of the few documented exceptions (§5.4).
 *
 * The response is IDENTICAL whether or not the account exists. An endpoint that
 * distinguishes them is a tool for discovering which phone numbers are enrolled
 * at a school.
 */

import { withPlatform } from '../../../db/rls';
import { recordAuthEvent } from '../../../db/audit';
import { type Result, ok } from '../../../shared/result';
import { normaliseIdentifier } from '../domain/phone';
import {
  OTP,
  expiryFrom,
  generateCode,
  shouldReuseChallenge,
} from '../domain/otp';
import type { CodeHasher, OtpDispatcher, RandomSource } from '../domain/ports';
import { credentials, otpChallenges } from '../infrastructure/repositories';

export interface RequestOtpInput {
  identifier: string;
  purpose?: 'login' | 'verify' | 'reset' | 'step_up';
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface RequestOtpDeps {
  codeHasher: CodeHasher;
  random: RandomSource;
  dispatcher: OtpDispatcher;
  now?: () => Date;
}

/** Deliberately uniform: it carries no signal about whether the account exists. */
export interface RequestOtpResult {
  accepted: true;
  expiresInSeconds: number;
}

export async function requestOtp(
  input: RequestOtpInput,
  deps: RequestOtpDeps,
): Promise<Result<RequestOtpResult, never>> {
  const now = deps.now?.() ?? new Date();
  const uniform: RequestOtpResult = { accepted: true, expiresInSeconds: OTP.ttlSeconds };

  const meta = { requestId: input.requestId, ip: input.ip, userAgent: input.userAgent };

  const identifier = normaliseIdentifier(input.identifier);
  // A malformed identifier gets the same answer as an unknown one.
  if (!identifier.ok) return ok(uniform);

  await withPlatform('login: resolve credential and issue an OTP challenge', async (tx) => {
    const cred = await credentials.byIdentifier(
      tx,
      identifier.value.kind,
      identifier.value.value,
    );
    if (!cred) {
      /*
       * Recorded even though the RESPONSE is uniform. The uniformity exists to
       * stop an outsider discovering who is enrolled; it was never meant to
       * hide a number-sweeping attack from us. An event in every branch also
       * keeps the branches similar in wall-clock time.
       */
      await recordAuthEvent(tx, {
        ...meta,
        type: 'otp.requested',
        outcome: 'failure',
        identifier: identifier.value.value,
        reason: 'unknown_identifier',
      });
      return;
    }

    // Rate limit per identifier. Each OTP is a billable SMS, so this is a spend
    // control as much as a security one. Per-IP limiting is applied at the
    // transport edge, where the IP actually lives.
    const windowStart = new Date(now.getTime() - OTP.requestWindowSeconds * 1000);
    const recent = await otpChallenges.countSince(tx, cred.id, windowStart);
    if (recent >= OTP.maxRequestsPerWindow) {
      await recordAuthEvent(tx, {
        ...meta,
        type: 'otp.requested',
        outcome: 'failure',
        accountId: cred.accountId,
        credentialId: cred.id,
        identifier: identifier.value.value,
        reason: 'rate_limited',
      });
      return;
    }

    // A resend reuses the live challenge rather than minting a second code:
    // two valid codes double both the guessing surface and the SMS bill.
    const live = await otpChallenges.liveFor(tx, cred.id, now);
    if (
      shouldReuseChallenge(
        live
          ? {
              codeHash: live.codeHash.toString('hex'),
              expiresAt: live.expiresAt,
              attempts: live.attempts,
              consumedAt: live.consumedAt,
            }
          : null,
        now,
      )
    ) {
      // The stored hash cannot be reversed, so a reused challenge cannot be
      // re-sent. The user waits for the original message or for it to expire.
      await recordAuthEvent(tx, {
        ...meta,
        type: 'otp.requested',
        outcome: 'success',
        accountId: cred.accountId,
        credentialId: cred.id,
        identifier: identifier.value.value,
        reason: 'reused_live_challenge',
        detail: { dispatched: false },
      });
      return;
    }

    const code = generateCode((max) => deps.random.int(max));
    await otpChallenges.create(tx, {
      credentialId: cred.id,
      codeHash: Buffer.from(deps.codeHasher.hash(code), 'hex'),
      purpose: input.purpose ?? 'login',
      expiresAt: expiryFrom(now),
    });

    // Phase 3b replaces this with a pg-boss enqueue in THIS transaction, so a
    // rolled-back challenge cannot produce a delivered code (invariant 9).
    await deps.dispatcher.send(identifier.value, code);

    await recordAuthEvent(tx, {
      ...meta,
      type: 'otp.requested',
      outcome: 'success',
      accountId: cred.accountId,
      credentialId: cred.id,
      identifier: identifier.value.value,
      detail: { dispatched: true },
    });
  });

  return ok(uniform);
}
