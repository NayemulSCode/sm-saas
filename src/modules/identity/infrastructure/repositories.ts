/**
 * Drizzle repositories — the ONLY place Drizzle appears in this module.
 *
 * Every function takes a `Tx` as its first argument and never opens its own
 * transaction: the use case owns the transaction boundary (§6.3).
 */

import { and, eq, gt, isNull, notInArray, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import {
  account,
  credential,
  membership,
  membershipRole,
  otpChallenge,
  role,
  rolePermission,
  session,
} from '../../../db/schema/identity';
import { tenant } from '../../../db/schema/platform';
import { person } from '../../../db/schema/directory';
import type { AccountId, CredentialId, MembershipId, SessionId } from '../../../shared/ids';
import { Ids } from '../../../shared/ids';

export interface CredentialRow {
  id: CredentialId;
  accountId: AccountId;
  kind: 'phone' | 'email';
  value: string;
  passwordHash: string | null;
  verifiedAt: Date | null;
}

export const credentials = {
  async byIdentifier(
    tx: Tx,
    kind: 'phone' | 'email',
    value: string,
  ): Promise<CredentialRow | undefined> {
    const [row] = await tx
      .select({
        id: credential.id,
        accountId: credential.accountId,
        kind: credential.kind,
        value: credential.value,
        passwordHash: credential.passwordHash,
        verifiedAt: credential.verifiedAt,
      })
      .from(credential)
      .where(and(eq(credential.kind, kind), eq(credential.value, value)))
      .limit(1);
    return row;
  },
};

export const accounts = {
  async byId(tx: Tx, id: AccountId) {
    const [row] = await tx.select().from(account).where(eq(account.id, id)).limit(1);
    return row;
  },

  async recordSuccessfulLogin(tx: Tx, id: AccountId): Promise<void> {
    await tx
      .update(account)
      .set({ lastLoginAt: new Date(), failedAttempts: 0, lockedUntil: null })
      .where(eq(account.id, id));
  },

  async recordFailedAttempt(tx: Tx, id: AccountId, lockAfter: number, lockFor: number) {
    const [row] = await tx
      .update(account)
      .set({ failedAttempts: sql`${account.failedAttempts} + 1` })
      .where(eq(account.id, id))
      .returning({ failedAttempts: account.failedAttempts });

    if (row && row.failedAttempts >= lockAfter) {
      await tx
        .update(account)
        .set({ lockedUntil: new Date(Date.now() + lockFor * 1000) })
        .where(eq(account.id, id));
    }
    return row?.failedAttempts ?? 0;
  },
};

export const otpChallenges = {
  /** The newest live challenge for a credential, if any. */
  async liveFor(tx: Tx, credentialId: CredentialId, now: Date) {
    const [row] = await tx
      .select()
      .from(otpChallenge)
      .where(
        and(
          eq(otpChallenge.credentialId, credentialId),
          isNull(otpChallenge.consumedAt),
          gt(otpChallenge.expiresAt, now),
        ),
      )
      .orderBy(sql`${otpChallenge.createdAt} DESC`)
      .limit(1);
    return row;
  },

  async countSince(tx: Tx, credentialId: CredentialId, since: Date): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(otpChallenge)
      .where(
        and(
          eq(otpChallenge.credentialId, credentialId),
          gt(otpChallenge.createdAt, since),
        ),
      );
    return row?.n ?? 0;
  },

  async create(
    tx: Tx,
    input: {
      credentialId: CredentialId;
      codeHash: Buffer;
      purpose: 'login' | 'verify' | 'reset' | 'step_up';
      expiresAt: Date;
    },
  ) {
    const [row] = await tx
      .insert(otpChallenge)
      .values({ id: Ids.generate<'otpChallenge'>(), ...input })
      .returning();
    return row;
  },

  async recordAttempt(tx: Tx, id: string): Promise<void> {
    await tx
      .update(otpChallenge)
      .set({ attempts: sql`${otpChallenge.attempts} + 1` })
      .where(eq(otpChallenge.id, id as never));
  },

  async consume(tx: Tx, id: string): Promise<void> {
    await tx
      .update(otpChallenge)
      .set({ consumedAt: new Date() })
      .where(eq(otpChallenge.id, id as never));
  },
};

export const sessions = {
  async create(
    tx: Tx,
    input: {
      accountId: AccountId;
      tokenHash: Buffer;
      expiresAt: Date;
      ip?: string;
      userAgent?: string;
    },
  ) {
    const [row] = await tx
      .insert(session)
      .values({ id: Ids.generate<'session'>(), ...input })
      .returning();
    return row;
  },

  async byTokenHash(tx: Tx, tokenHash: Buffer) {
    const [row] = await tx
      .select()
      .from(session)
      .where(and(eq(session.tokenHash, tokenHash), isNull(session.revokedAt)))
      .limit(1);
    return row;
  },

  async touch(tx: Tx, id: SessionId): Promise<void> {
    await tx.update(session).set({ lastSeenAt: new Date() }).where(eq(session.id, id));
  },

  async revoke(tx: Tx, id: SessionId): Promise<void> {
    await tx.update(session).set({ revokedAt: new Date() }).where(eq(session.id, id));
  },

  /** Used when a credential is compromised: every session, within 60 s. */
  async revokeAllForAccount(tx: Tx, accountId: AccountId): Promise<number> {
    const rows = await tx
      .update(session)
      .set({ revokedAt: new Date() })
      .where(and(eq(session.accountId, accountId), isNull(session.revokedAt)))
      .returning({ id: session.id });
    return rows.length;
  },

  async setActiveMembership(tx: Tx, id: SessionId, membershipId: string): Promise<void> {
    await tx
      .update(session)
      .set({ activeMembershipId: membershipId as never })
      .where(eq(session.id, id));
  },
};

export const memberships = {
  /**
   * Cross-tenant by necessity — it resolves WHICH tenants an account belongs
   * to, so it cannot run inside a tenant session. Narrow (by account_id) and
   * read-only, on the sm_platform pool (§8.4).
   */
  async contextsForAccount(tx: Tx, accountId: AccountId) {
    return tx
      .select({
        membershipId: membership.id,
        tenantId: membership.tenantId,
        tenantSlug: tenant.slug,
        tenantNameBn: tenant.nameBn,
        tenantNameEn: tenant.nameEn,
        tenantStatus: tenant.status,
        personId: membership.personId,
        personNameBn: person.nameBn,
        personNameEn: person.nameEn,
      })
      .from(membership)
      .innerJoin(tenant, eq(tenant.id, membership.tenantId))
      .innerJoin(person, eq(person.id, membership.personId))
      .where(
        and(
          eq(membership.accountId, accountId),
          eq(membership.status, 'active'),
          isNull(membership.deletedAt),
          // A purged or cancelled tenant is not a context anyone can enter.
          notInArray(tenant.status, ['purged', 'cancelled']),
        ),
      );
  },

  /**
   * Verifies a membership belongs to THIS account.
   *
   * The client sends a membership id when switching context. Without this
   * check it could name any membership and be handed another tenant's session
   * — which is why the lookup is by (id AND account_id), never by id alone
   * (§8.4).
   */
  async forAccount(tx: Tx, membershipId: MembershipId, accountId: AccountId) {
    const [row] = await tx
      .select({
        membershipId: membership.id,
        tenantId: membership.tenantId,
        tenantSlug: tenant.slug,
        tenantStatus: tenant.status,
        personId: membership.personId,
        status: membership.status,
      })
      .from(membership)
      .innerJoin(tenant, eq(tenant.id, membership.tenantId))
      .where(
        and(
          eq(membership.id, membershipId),
          eq(membership.accountId, accountId),
          eq(membership.status, 'active'),
          isNull(membership.deletedAt),
        ),
      )
      .limit(1);
    return row;
  },

  async permissionsFor(tx: Tx, membershipId: string) {
    return tx
      .select({
        roleCode: role.code,
        permissionKey: rolePermission.permissionKey,
        scope: membershipRole.scope,
      })
      .from(membershipRole)
      .innerJoin(role, eq(role.id, membershipRole.roleId))
      .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
      .where(
        and(
          eq(membershipRole.membershipId, membershipId as never),
          isNull(membershipRole.deletedAt),
        ),
      );
  },
};
