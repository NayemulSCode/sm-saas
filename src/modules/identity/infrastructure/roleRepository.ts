/**
 * Role reads and writes. All tenant-scoped — every query runs inside
 * `withTenant`, so RLS narrows them to the caller's school and a role from
 * another tenant is simply not there.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import { membership, membershipRole, role, rolePermission } from '../../../db/schema/identity';
import { Ids } from '../../../shared/ids';
import type { MembershipId, PersonId, RoleId } from '../../../shared/ids';
import { isPermission, type Permission } from '../../../shared/permissions';

export const roles = {
  async membershipExists(tx: Tx, membershipId: MembershipId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(membership)
      .where(and(eq(membership.id, membershipId), isNull(membership.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  /** A role and everything it confers — the input to the subset rule. */
  async byId(
    tx: Tx,
    roleId: RoleId,
  ): Promise<{ id: RoleId; code: string; permissions: Permission[] } | undefined> {
    const [found] = await tx
      .select({ id: role.id, code: role.code })
      .from(role)
      .where(and(eq(role.id, roleId), isNull(role.deletedAt)))
      .limit(1);
    if (!found) return undefined;

    const granted = await tx
      .select({ key: rolePermission.permissionKey })
      .from(rolePermission)
      .where(and(eq(rolePermission.roleId, roleId), isNull(rolePermission.deletedAt)));

    /*
     * Unknown keys are DROPPED, exactly as resolveAuthContext drops them. If a
     * stale row survived here it would be counted against the granter's
     * permissions, and since they cannot hold a key that is not in the union,
     * every grant of that role would be refused for a reason nobody could act
     * on.
     */
    return {
      ...found,
      permissions: granted.map((g) => g.key).filter((k): k is Permission => isPermission(k)),
    };
  },

  async all(tx: Tx): Promise<Array<{ id: RoleId; code: string; permissions: Permission[] }>> {
    const rows = await tx
      .select({ id: role.id, code: role.code, key: rolePermission.permissionKey })
      .from(role)
      .leftJoin(
        rolePermission,
        and(eq(rolePermission.roleId, role.id), isNull(rolePermission.deletedAt)),
      )
      .where(isNull(role.deletedAt));

    const byRole = new Map<RoleId, { id: RoleId; code: string; permissions: Permission[] }>();
    for (const r of rows) {
      const entry = byRole.get(r.id) ?? { id: r.id, code: r.code, permissions: [] };
      if (r.key !== null && isPermission(r.key)) entry.permissions.push(r.key);
      byRole.set(r.id, entry);
    }
    return [...byRole.values()].sort((a, b) => a.code.localeCompare(b.code));
  },

  async isGranted(tx: Tx, membershipId: MembershipId, roleId: RoleId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(membershipRole)
      .where(
        and(
          eq(membershipRole.membershipId, membershipId),
          eq(membershipRole.roleId, roleId),
          isNull(membershipRole.deletedAt),
        ),
      );
    return (row?.n ?? 0) > 0;
  },

  async grant(
    tx: Tx,
    input: {
      membershipId: MembershipId;
      roleId: RoleId;
      scope: Record<string, readonly string[]>;
      actorId: PersonId;
    },
  ): Promise<string> {
    const id = Ids.generate<'membershipRole'>();
    await tx.insert(membershipRole).values({
      id,
      membershipId: input.membershipId,
      roleId: input.roleId,
      scope: input.scope,
      createdBy: input.actorId,
    });
    return id;
  },

  /**
   * Soft delete. Nothing is hard-deleted (non-negotiable 1), and the row is
   * what shows a role was once held — which matters when reconstructing who
   * could do what on the day something went wrong.
   */
  async revoke(
    tx: Tx,
    membershipId: MembershipId,
    roleId: RoleId,
    actorId: PersonId,
  ): Promise<number> {
    const rows = await tx
      .update(membershipRole)
      .set({ deletedAt: new Date(), deletedBy: actorId, updatedBy: actorId })
      .where(
        and(
          eq(membershipRole.membershipId, membershipId),
          eq(membershipRole.roleId, roleId),
          isNull(membershipRole.deletedAt),
        ),
      )
      .returning({ id: membershipRole.id });
    return rows.length;
  },
};
