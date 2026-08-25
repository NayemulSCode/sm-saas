import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import { account, credential, membership, membershipRole } from '../../../db/schema/identity';
import { staffInvite } from '../../../db/schema/invite';
import { Ids } from '../../../shared/ids';
import type { AccountId, CredentialId, MembershipId, PersonId, RoleId } from '../../../shared/ids';
import type { CredentialRow } from './repositories';

export const invites = {
  /** Creates the global account + credential for someone with no login yet. */
  async createLogin(
    tx: Tx,
    kind: 'phone' | 'email',
    value: string,
  ): Promise<CredentialRow> {
    const accountId = Ids.generate<'account'>();
    await tx.insert(account).values({ id: accountId, status: 'active', locale: 'bn' });

    const [row] = await tx
      .insert(credential)
      .values({
        id: Ids.generate<'credential'>(),
        accountId,
        kind,
        value,
        // No password: the invitee sets one by accepting. Nothing to transmit.
        isPrimary: true,
      })
      .returning({
        id: credential.id,
        accountId: credential.accountId,
        kind: credential.kind,
        value: credential.value,
        passwordHash: credential.passwordHash,
        verifiedAt: credential.verifiedAt,
      });

    if (!row) throw new Error('failed to create credential');
    return row;
  },

  async membershipExists(tx: Tx, accountId: AccountId, personId: PersonId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(membership)
      .where(
        and(
          eq(membership.accountId, accountId),
          eq(membership.personId, personId),
          isNull(membership.deletedAt),
        ),
      );
    return (row?.n ?? 0) > 0;
  },

  async createMembership(
    tx: Tx,
    input: {
      id: MembershipId;
      accountId: AccountId;
      personId: PersonId;
      roleIds: RoleId[];
      actorId: PersonId;
    },
  ): Promise<void> {
    await tx.insert(membership).values({
      id: input.id,
      accountId: input.accountId,
      personId: input.personId,
      status: 'active',
      createdBy: input.actorId,
    });

    if (input.roleIds.length > 0) {
      await tx.insert(membershipRole).values(
        input.roleIds.map((roleId) => ({
          id: Ids.generate<'membershipRole'>(),
          membershipId: input.id,
          roleId,
          createdBy: input.actorId,
        })),
      );
    }
  },

  async create(
    tx: Tx,
    input: {
      accountId: AccountId;
      credentialId: CredentialId;
      membershipId: MembershipId;
      personId: PersonId;
      tokenHash: Buffer;
      expiresAt: Date;
      invitedBy: PersonId;
    },
  ): Promise<void> {
    await tx.insert(staffInvite).values({
      id: Ids.generate<'staffInvite'>(),
      ...input,
      createdBy: input.invitedBy,
    });
  },

  /** Token lookup runs BEFORE any tenant is known, so it is not tenant-scoped. */
  async byTokenHash(tx: Tx, tokenHash: Buffer) {
    const [row] = await tx
      .select()
      .from(staffInvite)
      .where(eq(staffInvite.tokenHash, tokenHash))
      .limit(1);
    return row;
  },

  async consume(tx: Tx, id: string): Promise<void> {
    await tx
      .update(staffInvite)
      .set({ consumedAt: new Date() })
      .where(eq(staffInvite.id, id as never));
  },

  async setPassword(tx: Tx, credentialId: CredentialId, hash: string): Promise<void> {
    await tx
      .update(credential)
      .set({ passwordHash: hash, verifiedAt: new Date() })
      .where(eq(credential.id, credentialId));
  },

  async revokeForMembership(
    tx: Tx,
    membershipId: MembershipId,
    reason: string,
    actorId: PersonId,
  ): Promise<number> {
    const rows = await tx
      .update(staffInvite)
      .set({ revokedAt: new Date(), revokeReason: reason, updatedBy: actorId })
      .where(
        and(
          eq(staffInvite.membershipId, membershipId),
          isNull(staffInvite.consumedAt),
          isNull(staffInvite.revokedAt),
        ),
      )
      .returning({ id: staffInvite.id });
    return rows.length;
  },
};
