/**
 * Reading the people in a school.
 *
 * Tenant-scoped by RLS, like everything else — except `credential`, which is
 * global. That join is the one place this file reaches outside the tenant, and
 * it is narrow on purpose: an identifier, nothing else.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import { credential, membership, membershipRole, role } from '../../../db/schema/identity';
import { staffInvite } from '../../../db/schema/invite';
import { person } from '../../../db/schema/directory';
import type { MembershipId, PersonId, RoleId } from '../../../shared/ids';

export const members = {
  async all(tx: Tx): Promise<
    Array<{
      membershipId: MembershipId;
      personId: PersonId;
      nameBn: string;
      nameEn: string;
      status: string;
      identifier: string | null;
      roleId: RoleId | null;
      roleCode: string | null;
      invitePending: boolean;
    }>
  > {
    return tx
      .select({
        membershipId: membership.id,
        personId: membership.personId,
        nameBn: person.nameBn,
        nameEn: person.nameEn,
        status: membership.status,
        /*
         * The PRIMARY credential only. An account may have several — a phone
         * and an email — and showing all of them turns a staff list into a
         * contact dump nobody asked for.
         */
        identifier: sql<string | null>`(
          SELECT c.value FROM ${credential} c
          WHERE c.account_id = ${membership.accountId} AND c.is_primary
          LIMIT 1
        )`,
        roleId: role.id,
        roleCode: role.code,
        /*
         * An invite that is neither consumed nor revoked. `EXISTS` rather than
         * a join, so a person with two historical invites does not appear
         * twice in the staff list.
         */
        invitePending: sql<boolean>`EXISTS (
          SELECT 1 FROM ${staffInvite} si
          WHERE si.membership_id = ${membership.id}
            AND si.consumed_at IS NULL
            AND si.revoked_at IS NULL
            AND si.deleted_at IS NULL
        )`,
      })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .leftJoin(
        membershipRole,
        and(eq(membershipRole.membershipId, membership.id), isNull(membershipRole.deletedAt)),
      )
      .leftJoin(role, and(eq(role.id, membershipRole.roleId), isNull(role.deletedAt)))
      .where(isNull(membership.deletedAt));
  },
};
