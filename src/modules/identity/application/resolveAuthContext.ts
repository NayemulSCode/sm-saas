/**
 * Session token → full AuthContext.
 *
 * This is the last link in the tenancy chain: everything downstream —
 * `authorize()`, `withTenant()`, the RLS session variable — is driven by the
 * object this function returns.
 *
 * It is built ENTIRELY from verified database state. Nothing here comes from
 * request input except the opaque token, which is looked up rather than
 * trusted (§8.6).
 *
 * §6.4 shows this happening in middleware. Next middleware runs on the edge
 * runtime and cannot use `pg`, so it happens here instead and middleware stays
 * edge-light doing host → surface routing. Same guarantees, different layer.
 */

import { withPlatform } from '../../../db/rls';
import { type Result, ok, err, type DomainError } from '../../../shared/result';
import type { AuthContext } from '../../../shared/auth-context';
import { isPermission, type Permission } from '../../../shared/permissions';
import { mergeScopes } from '../domain/scope';
import { evaluateSession, shouldTouchLastSeen } from '../domain/session';
import type { TokenGenerator } from '../domain/ports';
import { memberships, sessions } from '../infrastructure/repositories';
import { SessionErrors } from './switchContext';

export const AuthContextErrors = {
  ...SessionErrors,
  /** Authenticated, but no school is active — the switcher must run first. */
  NO_ACTIVE_CONTEXT: {
    code: 'NO_ACTIVE_CONTEXT',
    messageKey: 'auth.error.noActiveContext',
    httpStatus: 409,
  } as DomainError,
} as const;

export interface AuthContextDeps {
  tokens: TokenGenerator;
  now?: () => Date;
  requestId?: string;
}

export async function resolveAuthContext(
  token: string,
  deps: AuthContextDeps,
): Promise<Result<AuthContext, DomainError>> {
  const now = deps.now?.() ?? new Date();

  return withPlatform('auth: resolve a session into a full tenant context', async (tx) => {
    const session = await sessions.byTokenHash(tx, deps.tokens.hashToken(token));
    if (!session) return err(SessionErrors.SESSION_INVALID);

    const verdict = evaluateSession(
      {
        issuedAt: session.issuedAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
      },
      'staff',
      now,
    );
    if (verdict.kind !== 'active') return err(SessionErrors.SESSION_INVALID);

    if (!session.activeMembershipId) return err(AuthContextErrors.NO_ACTIVE_CONTEXT);

    // Re-verified on every request: a membership revoked mid-session must stop
    // working immediately, not at expiry.
    const membership = await memberships.forAccount(
      tx,
      session.activeMembershipId,
      session.accountId,
    );
    if (!membership) return err(SessionErrors.SESSION_INVALID);

    const grants = await memberships.permissionsFor(tx, membership.membershipId);

    // Unknown keys are DROPPED rather than trusted. A permission removed from
    // the TypeScript union must stop working even if a stale row survives.
    const permissions = new Set<Permission>();
    for (const g of grants) {
      if (isPermission(g.permissionKey)) permissions.add(g.permissionKey);
    }

    // One scope per ROLE, not per permission row — a role with ten permissions
    // must not have its scope counted ten times.
    const scopeByRole = new Map(grants.map((g) => [g.roleCode, g.scope]));
    const scope = mergeScopes([...scopeByRole.values()]);

    if (
      shouldTouchLastSeen(
        {
          issuedAt: session.issuedAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          revokedAt: session.revokedAt,
        },
        now,
      )
    ) {
      await sessions.touch(tx, session.id);
    }

    return ok({
      accountId: session.accountId,
      sessionId: session.id,
      // A single tenant. Several only for an organization-level role, which is
      // a later increment; the list is never taken from input either way.
      tenantIds: [membership.tenantId],
      activeTenantId: membership.tenantId,
      personId: membership.personId,
      membershipId: membership.membershipId,
      permissions,
      scope,
      locale: 'bn',
      requestId: deps.requestId ?? 'unknown',
      // Invariant 14: a suspended tenant resolves but cannot write.
      readOnly:
        membership.tenantStatus === 'suspended' || membership.tenantStatus === 'past_due',
    } satisfies AuthContext);
  });
}
