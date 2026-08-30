/**
 * A guardian's own children. The read the whole household surface is built on.
 *
 * `listStudents` and `getStudent` answer for any student in the tenant to
 * anyone holding `student.read` — correct for staff, who legitimately need the
 * whole roster, and wrong for a guardian, who must see only their own. Rather
 * than adding a personId-shaped exception to those two, this is a SEPARATE
 * read that never accepts a student id as input at all: the only id it takes
 * is `ctx.personId`, and the set of children returned is entirely determined
 * by `guardian_link` rows already on file. There is nothing in the request
 * that could be tampered with to see a different family.
 *
 * The `isHouseholdOnly` guard on every (staff) page (§ auth-context.ts) is the
 * other half of this: it stops a guardian from reaching the pages that call
 * `listStudents` in the first place. This function is what those pages should
 * be showing that guardian instead.
 */

import { withTenantReadonly } from '../../../db/rls';
import { type Result, ok, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { Relationship } from '../domain/guardians';
import type { StudentStatus } from '../domain/studentStatus';
import { directory } from '../infrastructure/repositories';

export interface MyChild {
  studentId: string;
  studentCode: string;
  status: StudentStatus;
  nameBn: string;
  nameEn: string;
  classNameEn: string | null;
  sectionNameEn: string | null;
  rollNo: number | null;
  relationship: Relationship;
  isBillingGuardian: boolean;
  isPrimaryContact: boolean;
}

export async function listMyChildren(ctx: AuthContext): Promise<Result<MyChild[], DomainError>> {
  authorize(ctx, 'student.read');

  return withTenantReadonly(ctx, async (tx) => {
    const rows = await directory.childrenOf(tx, ctx.personId);

    return ok(
      rows.map((r) => ({
        studentId: r.id,
        studentCode: r.studentCode,
        status: r.status as StudentStatus,
        nameBn: r.nameBn,
        nameEn: r.nameEn,
        classNameEn: r.classNameEn,
        sectionNameEn: r.sectionNameEn,
        rollNo: r.rollNo,
        relationship: r.relationship as Relationship,
        isBillingGuardian: r.isBillingGuardian,
        isPrimaryContact: r.isPrimaryContact,
      })),
    );
  });
}
