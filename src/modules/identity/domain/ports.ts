/**
 * Ports — interfaces the identity domain needs someone else to implement.
 *
 * The domain layer imports no framework, no ORM and no SDK (ADR-0001), so
 * hashing, randomness and the clock arrive through these. That is also what
 * makes every rule in this module unit-testable with no database and no
 * cryptography.
 */

import type { AccountId, MembershipId, PersonId, TenantId } from '../../../shared/ids.js';
import type { Permission } from '../../../shared/permissions.js';
import type { Scope } from '../../../shared/auth-context.js';

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  /** Must be constant-time and must not throw on a malformed hash. */
  verify(hash: string, plain: string): Promise<boolean>;
}

export interface CodeHasher {
  /** OTP codes are hashed at rest; a database leak must not yield live codes. */
  hash(code: string): string;
  equals(a: string, b: string): boolean;
}

export interface TokenGenerator {
  /** 32 bytes of CSPRNG, base64url. Stored as sha256(token). */
  newSessionToken(): { token: string; hash: Buffer };
  hashToken(token: string): Buffer;
}

export interface RandomSource {
  int(maxExclusive: number): number;
}

/** One resolved login context: this account, in this tenant, as this person. */
export interface AuthenticationContext {
  readonly membershipId: MembershipId;
  readonly tenantId: TenantId;
  readonly tenantSlug: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly personId: PersonId;
  readonly personName: string;
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
  readonly scope: Scope;
}

export interface ContextResolver {
  /**
   * Cross-tenant by necessity: it is resolving WHICH tenants the account
   * belongs to, so it cannot run inside a tenant session. Runs on the
   * sm_platform pool, narrow (by account_id) and read-only (§8.4).
   */
  forAccount(accountId: AccountId): Promise<AuthenticationContext[]>;
}

/**
 * Delivery of the OTP code.
 *
 * The notification module owns SMS (Phase 3b). Identity only states the intent;
 * in Phase 3b this becomes a pg-boss enqueue INSIDE the login transaction, so
 * a code can never be sent for a challenge that rolled back (invariant 9).
 */
export interface OtpDispatcher {
  send(to: { kind: CredentialKind; value: string }, code: string): Promise<void>;
}

export type CredentialKind = 'phone' | 'email';
