/**
 * Session resolution and context switching. §8.4, §8.5.
 *
 * The security property that matters here: the CLIENT sends a membership id,
 * and the SERVER decides whether it may be activated. The lookup is by
 * (membership id AND account id) — never by id alone — so a client cannot name
 * someone else's membership and be handed their tenant.
 *
 * Runs on the platform pool: resolving which tenants an account belongs to
 * cannot happen inside a tenant session, because the tenant is the answer.
 */

import { withPlatform } from '../../../db/rls';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { evaluateSession, shouldTouchLastSeen, type SessionAudience } from '../domain/session';
import type { TokenGenerator } from '../domain/ports';
import type { AccountId, MembershipId, SessionId } from '../../../shared/ids';
import { memberships, sessions } from '../infrastructure/repositories';

export const SessionErrors = defineErrors({
  SESSION_INVALID: {
    code: 'SESSION_INVALID',
    messageKey: 'auth.error.sessionInvalid',
    httpStatus: 401,
  },
  /**
   * 404, not 403. A 403 would confirm the membership exists and belongs to
   * someone — the same existence-disclosure reasoning as tenant resolution
   * (§7.3).
   */
  CONTEXT_NOT_FOUND: {
    code: 'CONTEXT_NOT_FOUND',
    messageKey: 'auth.error.contextNotFound',
    httpStatus: 404,
  },
  TENANT_UNAVAILABLE: {
    code: 'TENANT_UNAVAILABLE',
    messageKey: 'auth.error.tenantUnavailable',
    httpStatus: 423,
  },
});

export interface SessionDeps {
  tokens: TokenGenerator;
  now?: () => Date;
  audience?: SessionAudience;
}

export interface AvailableContext {
  membershipId: MembershipId;
  tenantId: string;
  tenantSlug: string;
  tenantNameBn: string;
  tenantNameEn: string;
  tenantStatus: string;
  personId: string;
  personNameBn: string;
  personNameEn: string;
  isActive: boolean;
}

export interface ResolvedSession {
  sessionId: SessionId;
  accountId: AccountId;
  activeMembershipId: MembershipId | null;
  /** A suspended tenant resolves but is read-only — invariant 14. */
  readOnly: boolean;
}

/**
 * Token → session. Returns SESSION_INVALID for absent, revoked, expired and
 * idle-timed-out alike: none of them should be distinguishable to a caller.
 */
export async function resolveSession(
  token: string,
  deps: SessionDeps,
): Promise<Result<ResolvedSession, DomainError>> {
  const now = deps.now?.() ?? new Date();
  const audience = deps.audience ?? 'staff';

  return withPlatform('session: resolve a bearer token to its account', async (tx) => {
    const row = await sessions.byTokenHash(tx, deps.tokens.hashToken(token));
    if (!row) return err(SessionErrors.SESSION_INVALID);

    const verdict = evaluateSession(
      {
        issuedAt: row.issuedAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      },
      audience,
      now,
    );
    if (verdict.kind !== 'active') return err(SessionErrors.SESSION_INVALID);

    // Throttled: every authenticated request touches this row, and writing on
    // each one turns a read-mostly table into the hottest write in the system.
    if (
      shouldTouchLastSeen(
        { issuedAt: row.issuedAt, lastSeenAt: row.lastSeenAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt },
        now,
      )
    ) {
      await sessions.touch(tx, row.id);
    }

    let readOnly = false;
    if (row.activeMembershipId) {
      const m = await memberships.forAccount(tx, row.activeMembershipId, row.accountId);
      // The membership was revoked while the session was live.
      if (!m) return err(SessionErrors.SESSION_INVALID);
      readOnly = m.tenantStatus === 'suspended' || m.tenantStatus === 'past_due';
    }

    return ok({
      sessionId: row.id,
      accountId: row.accountId,
      activeMembershipId: row.activeMembershipId ?? null,
      readOnly,
    });
  });
}

/** The switcher list. Built from verified memberships, never from input. */
export async function listContexts(
  token: string,
  deps: SessionDeps,
): Promise<Result<AvailableContext[], DomainError>> {
  const resolved = await resolveSession(token, deps);
  if (!resolved.ok) return resolved;

  return withPlatform('session: list the contexts available to an account', async (tx) => {
    const rows = await memberships.contextsForAccount(tx, resolved.value.accountId);
    return ok(
      rows.map((r) => ({
        ...r,
        isActive: r.membershipId === resolved.value.activeMembershipId,
      })),
    );
  });
}

/**
 * Activates one context on the server side.
 *
 * The client supplies a membership id and nothing else; it cannot supply a
 * tenant. Which tenant the session lands in is derived from the membership,
 * which is looked up by (id AND account_id).
 */
export async function switchContext(
  token: string,
  membershipId: MembershipId,
  deps: SessionDeps,
): Promise<Result<{ membershipId: MembershipId; tenantId: string; tenantSlug: string }, DomainError>> {
  const resolved = await resolveSession(token, deps);
  if (!resolved.ok) return resolved;

  return withPlatform('session: activate a membership context', async (tx) => {
    const m = await memberships.forAccount(tx, membershipId, resolved.value.accountId);
    // Belongs to another account, does not exist, or is suspended — all 404.
    if (!m) return err(SessionErrors.CONTEXT_NOT_FOUND);

    if (m.tenantStatus === 'purged' || m.tenantStatus === 'cancelled') {
      return err(SessionErrors.TENANT_UNAVAILABLE);
    }

    await sessions.setActiveMembership(tx, resolved.value.sessionId, m.membershipId);

    return ok({
      membershipId: m.membershipId,
      tenantId: m.tenantId,
      tenantSlug: m.tenantSlug,
    });
  });
}

/**
 * Revokes one session. Takes effect on the very next request, because the
 * session is server-side state rather than a signed token — which is the whole
 * reason for not using JWTs (NFR §4.6).
 */
export async function revokeSession(sessionId: SessionId): Promise<void> {
  await withPlatform('session: revoke a single session', async (tx) => {
    await sessions.revoke(tx, sessionId);
  });
}

/** Every session for an account — used when a credential is compromised. */
export async function revokeAllSessions(accountId: AccountId): Promise<number> {
  return withPlatform('session: revoke every session for an account', async (tx) =>
    sessions.revokeAllForAccount(tx, accountId),
  );
}
