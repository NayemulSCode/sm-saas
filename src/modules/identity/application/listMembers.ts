/**
 * Who works at this school, and what each of them may do.
 *
 * The screen behind every "who can see the fee reports?" conversation, so it
 * shows the ROLES rather than the permissions: a principal thinks in
 * "Accountant", not in `fee.reconcile`. The permission list belongs on the role
 * screen, where changing it is a deliberate act.
 *
 * Pending invites appear here too. An invited person is already a member —
 * their membership exists the moment the invite is issued — and hiding them
 * until they accept means inviting the same teacher twice.
 */

import { withTenantReadonly } from '../../../db/rls';
import { type Result, ok, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { MembershipId, PersonId, RoleId } from '../../../shared/ids';
import { members } from '../infrastructure/memberRepository';

export interface MemberRow {
  membershipId: MembershipId;
  personId: PersonId;
  nameBn: string;
  nameEn: string;
  status: string;
  /** Their login identifier, for telling two people with one name apart. */
  identifier: string | null;
  roles: Array<{ id: RoleId; code: string }>;
  /** True while an invite is outstanding: issued, not yet accepted. */
  invitePending: boolean;
  /** True for the caller's own membership — the one they may not edit. */
  isSelf: boolean;
}

export async function listMembers(
  ctx: AuthContext,
): Promise<Result<MemberRow[], DomainError>> {
  authorize(ctx, 'staff.read');

  return withTenantReadonly(ctx, async (tx) => {
    const rows = await members.all(tx);

    /*
     * Roles arrive as one row per (membership, role) from the join. Grouping
     * here rather than in SQL keeps the query one statement and readable; the
     * list is a school's staff, which is tens of rows, not thousands.
     */
    const byMembership = new Map<string, MemberRow>();
    for (const r of rows) {
      const existing = byMembership.get(r.membershipId);
      const entry: MemberRow = existing ?? {
        membershipId: r.membershipId,
        personId: r.personId,
        nameBn: r.nameBn,
        nameEn: r.nameEn,
        status: r.status,
        identifier: r.identifier,
        roles: [],
        invitePending: r.invitePending,
        // Marked here so the UI can hide the controls the server would refuse:
        // nobody edits their own access (§9.5).
        isSelf: r.membershipId === ctx.membershipId,
      };
      if (r.roleId && r.roleCode && !entry.roles.some((x) => x.id === r.roleId)) {
        entry.roles.push({ id: r.roleId, code: r.roleCode });
      }
      byMembership.set(r.membershipId, entry);
    }

    return ok(
      [...byMembership.values()].sort((a, b) => a.nameEn.localeCompare(b.nameEn)),
    );
  });
}
