/**
 * Password login, for staff. §8.3.
 *
 * Guardians never reach this path — they have no password at all, which is
 * also how credential distribution to thousands of them is solved (§8.2).
 *
 * UNAUTHENTICATED and cross-tenant, like OTP login: discovering which tenants
 * the account belongs to is the point. Runs on the platform pool.
 */

import { withPlatform } from '../../../db/rls';
import { recordAuthEvent } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { normaliseIdentifier } from '../domain/phone';
import { gateLogin, hasPassword, shouldLock, lockUntil, LOCKOUT } from '../domain/password';
import { initialExpiry, type SessionAudience } from '../domain/session';
import type { PasswordHasher, TokenGenerator } from '../domain/ports';
import { accounts, credentials, memberships, sessions } from '../infrastructure/repositories';
import type { ResolvedContext } from './verifyOtp';

export const PasswordErrors = defineErrors({
  /**
   * One error for every reason a password login fails: unknown identifier,
   * wrong password, no password set, disabled account. Distinguishing them
   * turns the endpoint into an account-enumeration oracle.
   */
  INVALID_CREDENTIALS: {
    code: 'INVALID_CREDENTIALS',
    messageKey: 'auth.error.invalidCredentials',
    httpStatus: 401,
  },
  /**
   * Lockout IS disclosed, deliberately. The user must be told why they cannot
   * get in, and by this point an attacker has already proven the account
   * exists by tripping the lock.
   */
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

export interface PasswordLoginInput {
  identifier: string;
  password: string;
  ip?: string;
  userAgent?: string;
  requestId?: string | undefined;
}

export interface PasswordLoginDeps {
  hasher: PasswordHasher;
  tokens: TokenGenerator;
  now?: () => Date;
}

export interface PasswordLoginResult {
  sessionToken: string;
  expiresAt: Date;
  contexts: ResolvedContext[];
  contextCount: number;
}

/**
 * A real Argon2id hash of a value nobody knows.
 *
 * Verified against when the identifier is unknown or has no password, so the
 * response takes comparable time either way. Without this, "unknown user"
 * returns in microseconds while "wrong password" takes ~50ms, and the
 * difference is a reliable oracle for which phone numbers are registered.
 *
 * Generated lazily once, from the real hasher, so it tracks the configured
 * cost parameters rather than drifting from them.
 */
let dummyHash: string | undefined;
async function burnComparableTime(hasher: PasswordHasher, password: string): Promise<void> {
  dummyHash ??= await hasher.hash('a password nobody will ever use: ' + Math.random());
  await hasher.verify(dummyHash, password);
}

export async function authenticatePassword(
  input: PasswordLoginInput,
  deps: PasswordLoginDeps,
): Promise<Result<PasswordLoginResult, DomainError>> {
  const now = deps.now?.() ?? new Date();

  const identifier = normaliseIdentifier(input.identifier);
  if (!identifier.ok) {
    await burnComparableTime(deps.hasher, input.password);
    return err(PasswordErrors.INVALID_CREDENTIALS);
  }

  const meta = { requestId: input.requestId, ip: input.ip, userAgent: input.userAgent };

  return withPlatform('login: verify a password and open a session', async (tx) => {
    /*
     * Password failures all answer INVALID_CREDENTIALS and all burn the same
     * amount of time, so the endpoint gives nothing away. The reason still has
     * to be written down somewhere, or nobody can tell a forgotten password
     * from a credential-stuffing run.
     */
    const refuse = async (
      reason: string,
      extra: { accountId?: string; credentialId?: string } = {},
    ): Promise<void> => {
      await recordAuthEvent(tx, {
        ...meta,
        ...extra,
        type: 'password.attempted',
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
      await burnComparableTime(deps.hasher, input.password);
      await refuse('unknown_identifier');
      return err(PasswordErrors.INVALID_CREDENTIALS);
    }

    const ids = { accountId: cred.accountId, credentialId: cred.id };

    const acct = await accounts.byId(tx, cred.accountId);
    if (!acct) {
      await burnComparableTime(deps.hasher, input.password);
      await refuse('no_account', ids);
      return err(PasswordErrors.INVALID_CREDENTIALS);
    }

    // Checked before the hash comparison: a locked account costs no work, and
    // a lockout cannot be worn down by brute force.
    const gate = gateLogin(
      {
        status: acct.status,
        failedAttempts: acct.failedAttempts,
        lockedUntil: acct.lockedUntil,
      },
      now,
    );
    if (gate.kind === 'locked') {
      await refuse('account_locked', ids);
      return err(PasswordErrors.ACCOUNT_LOCKED);
    }
    if (gate.kind === 'disabled') {
      await burnComparableTime(deps.hasher, input.password);
      await refuse('account_disabled', ids);
      return err(PasswordErrors.INVALID_CREDENTIALS);
    }

    // An OTP-only guardian: a normal state, not an error. Same cost, same
    // answer as a wrong password.
    if (!hasPassword(cred.passwordHash)) {
      await burnComparableTime(deps.hasher, input.password);
      await refuse('no_password_set', ids);
      return err(PasswordErrors.INVALID_CREDENTIALS);
    }

    const valid = await deps.hasher.verify(cred.passwordHash!, input.password);
    if (!valid) {
      const attempts = await accounts.recordFailedAttempt(
        tx,
        cred.accountId,
        LOCKOUT.maxAttempts,
        LOCKOUT.lockSeconds,
      );
      // The lock is applied by the repository when the threshold is reached;
      // the caller still sees INVALID_CREDENTIALS for this attempt, and
      // ACCOUNT_LOCKED only on the next one.
      void lockUntil(now);
      await refuse('wrong_password', ids);
      // The lock crossing its threshold is its own event: it is the row an
      // investigation looks for, and it must not be buried in a stream of
      // ordinary failures.
      if (shouldLock(attempts)) {
        await recordAuthEvent(tx, {
          ...meta,
          ...ids,
          type: 'account.locked',
          outcome: 'failure',
          identifier: identifier.value.value,
          reason: 'too_many_failed_attempts',
          detail: { attempts },
        });
      }
      return err(PasswordErrors.INVALID_CREDENTIALS);
    }

    const contexts = await memberships.contextsForAccount(tx, cred.accountId);
    if (contexts.length === 0) {
      await refuse('no_membership', ids);
      return err(PasswordErrors.NO_MEMBERSHIP);
    }

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

    const only = contexts.length === 1 ? contexts[0] : undefined;
    if (created && only) {
      await sessions.setActiveMembership(tx, created.id, only.membershipId);
    }

    // Clears failed_attempts and any stale lock.
    await accounts.recordSuccessfulLogin(tx, cred.accountId);

    await recordAuthEvent(tx, {
      ...meta,
      ...ids,
      type: 'session.created',
      outcome: 'success',
      sessionId: created?.id,
      identifier: identifier.value.value,
      detail: { method: 'password', autoActivated: Boolean(only), contexts: contexts.length },
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
