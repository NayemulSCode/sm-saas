/**
 * Fee definition reads and writes. §13.1.
 *
 * Every query runs inside `withTenant`, so RLS narrows it to the caller's
 * tenant and a row from another tenant is simply absent rather than
 * forbidden — same discipline as every other module's repository.
 *
 * `academicYear`, `classLevel` and `section` are the STRUCTURE module's
 * tables, imported directly rather than through `structure/index.ts`. That is
 * allowed — `boundaries/dependencies` permits `infra` to import `db` freely —
 * and it is the same pattern `structure/infrastructure/repositories.ts`
 * already uses in reverse, reading `enrolment` (directory's table) for its own
 * occupancy count. Reaching into another module's *repository functions*
 * would be forbidden; reaching into the shared schema tables for a plain read
 * is not.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import { discount, feeAssignment, feeHead, feeStructure } from '../../../db/schema/finance';
import { academicYear, classLevel, section } from '../../../db/schema/structure';
import { student } from '../../../db/schema/directoryStudents';
import { Ids } from '../../../shared/ids';
import type { LocalDate } from '../../../shared/date';
import type {
  AcademicYearId,
  ClassLevelId,
  DiscountId,
  FeeAssignmentId,
  FeeHeadId,
  FeeStructureId,
  PersonId,
  SchoolId,
  SectionId,
  StudentId,
} from '../../../shared/ids';

export interface FeeHeadRecord {
  id: FeeHeadId;
  code: string;
  nameBn: string;
  nameEn: string;
  frequency: 'one_time' | 'monthly' | 'term' | 'annual';
  isRefundable: boolean;
  glCode: string | null;
  sequence: number;
}

export interface FeeStructureRecord {
  id: FeeStructureId;
  academicYearId: AcademicYearId;
  feeHeadId: FeeHeadId;
  classLevelId: ClassLevelId | null;
  sectionId: SectionId | null;
  amountMinor: bigint;
  dueDay: number | null;
}

export interface FeeAssignmentRecord {
  id: FeeAssignmentId;
  studentId: StudentId;
  feeHeadId: FeeHeadId;
  academicYearId: AcademicYearId;
  amountMinor: bigint;
  reason: string;
}

export interface DiscountRecord {
  id: DiscountId;
  studentId: StudentId;
  feeHeadId: FeeHeadId | null;
  kind: 'sibling' | 'staff_child' | 'merit' | 'need' | 'other';
  valueMinor: bigint | null;
  percent: string | null;
  validFrom: LocalDate;
  validTo: LocalDate | null;
  reason: string;
  requestedBy: PersonId | null;
  approvedBy: PersonId | null;
  approvedAt: Date | null;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
}

export const finance = {
  // ── fee heads ────────────────────────────────────────────────────────────

  async feeHeadCodeTaken(tx: Tx, code: string): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeHead)
      .where(and(eq(feeHead.code, code), isNull(feeHead.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  async feeHeadExists(tx: Tx, id: FeeHeadId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeHead)
      .where(and(eq(feeHead.id, id), isNull(feeHead.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  async createFeeHead(
    tx: Tx,
    input: {
      code: string;
      nameBn: string;
      nameEn: string;
      frequency: 'one_time' | 'monthly' | 'term' | 'annual';
      isRefundable: boolean;
      glCode: string | null;
      sequence: number;
      actorId: PersonId;
    },
  ): Promise<FeeHeadId> {
    const id = Ids.generate<'feeHead'>();
    await tx.insert(feeHead).values({
      id,
      code: input.code,
      nameBn: input.nameBn,
      nameEn: input.nameEn,
      frequency: input.frequency,
      isRefundable: input.isRefundable,
      glCode: input.glCode,
      sequence: input.sequence,
      createdBy: input.actorId,
    });
    return id;
  },

  async listFeeHeads(tx: Tx): Promise<FeeHeadRecord[]> {
    return tx
      .select({
        id: feeHead.id,
        code: feeHead.code,
        nameBn: feeHead.nameBn,
        nameEn: feeHead.nameEn,
        frequency: feeHead.frequency,
        isRefundable: feeHead.isRefundable,
        glCode: feeHead.glCode,
        sequence: feeHead.sequence,
      })
      .from(feeHead)
      .where(isNull(feeHead.deletedAt))
      .orderBy(asc(feeHead.sequence), asc(feeHead.nameEn));
  },

  // ── the structure module's tables, read directly (see file header) ───────

  async academicYearSchool(
    tx: Tx,
    id: AcademicYearId,
  ): Promise<{ schoolId: SchoolId } | undefined> {
    const [row] = await tx
      .select({ schoolId: academicYear.schoolId })
      .from(academicYear)
      .where(and(eq(academicYear.id, id), isNull(academicYear.deletedAt)))
      .limit(1);
    return row;
  },

  async classLevelSchool(
    tx: Tx,
    id: ClassLevelId,
  ): Promise<{ schoolId: SchoolId } | undefined> {
    const [row] = await tx
      .select({ schoolId: classLevel.schoolId })
      .from(classLevel)
      .where(and(eq(classLevel.id, id), isNull(classLevel.deletedAt)))
      .limit(1);
    return row;
  },

  async sectionSchool(tx: Tx, id: SectionId): Promise<{ schoolId: SchoolId } | undefined> {
    const [row] = await tx
      .select({ schoolId: classLevel.schoolId })
      .from(section)
      .innerJoin(classLevel, eq(classLevel.id, section.classLevelId))
      .where(and(eq(section.id, id), isNull(section.deletedAt)))
      .limit(1);
    return row;
  },

  // ── fee structures ───────────────────────────────────────────────────────

  /**
   * Mirrors the migration's own guard — `UNIQUE (tenant_id, academic_year_id,
   * fee_head_id, COALESCE(class_level_id, section_id)) WHERE deleted_at IS
   * NULL` — as a pre-check, so a collision reads as a friendly `DomainError`
   * rather than a raw constraint violation. Same idiom as
   * `createClassLevel`'s own name-collision check.
   */
  async feeStructureConflict(
    tx: Tx,
    input: { academicYearId: AcademicYearId; feeHeadId: FeeHeadId; scopeId: string },
  ): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeStructure)
      .where(
        and(
          eq(feeStructure.academicYearId, input.academicYearId),
          eq(feeStructure.feeHeadId, input.feeHeadId),
          isNull(feeStructure.deletedAt),
          sql`coalesce(${feeStructure.classLevelId}, ${feeStructure.sectionId}) = ${Ids.toUuid(
            input.scopeId as never,
          )}::uuid`,
        ),
      );
    return (row?.n ?? 0) > 0;
  },

  async createFeeStructure(
    tx: Tx,
    input: {
      academicYearId: AcademicYearId;
      feeHeadId: FeeHeadId;
      classLevelId: ClassLevelId | null;
      sectionId: SectionId | null;
      amountMinor: bigint;
      dueDay: number | null;
      actorId: PersonId;
    },
  ): Promise<FeeStructureId> {
    const id = Ids.generate<'feeStructure'>();
    await tx.insert(feeStructure).values({
      id,
      academicYearId: input.academicYearId,
      feeHeadId: input.feeHeadId,
      classLevelId: input.classLevelId,
      sectionId: input.sectionId,
      amountMinor: input.amountMinor,
      dueDay: input.dueDay,
      createdBy: input.actorId,
    });
    return id;
  },

  async listFeeStructures(
    tx: Tx,
    filter: { academicYearId?: AcademicYearId | undefined },
  ): Promise<FeeStructureRecord[]> {
    const conditions = [isNull(feeStructure.deletedAt)];
    if (filter.academicYearId) {
      conditions.push(eq(feeStructure.academicYearId, filter.academicYearId));
    }
    return tx
      .select({
        id: feeStructure.id,
        academicYearId: feeStructure.academicYearId,
        feeHeadId: feeStructure.feeHeadId,
        classLevelId: feeStructure.classLevelId,
        sectionId: feeStructure.sectionId,
        amountMinor: feeStructure.amountMinor,
        dueDay: feeStructure.dueDay,
      })
      .from(feeStructure)
      .where(and(...conditions));
  },

  // ── students, read directly (see file header) ────────────────────────────

  async studentExists(tx: Tx, id: StudentId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(student)
      .where(and(eq(student.id, id), isNull(student.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  // ── fee assignments ──────────────────────────────────────────────────────

  /** Mirrors `fee_assignment`'s own `UNIQUE (tenant_id, student_id,
   *  fee_head_id, academic_year_id)` as a pre-check. */
  async feeAssignmentConflict(
    tx: Tx,
    input: { studentId: StudentId; feeHeadId: FeeHeadId; academicYearId: AcademicYearId },
  ): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeAssignment)
      .where(
        and(
          eq(feeAssignment.studentId, input.studentId),
          eq(feeAssignment.feeHeadId, input.feeHeadId),
          eq(feeAssignment.academicYearId, input.academicYearId),
          isNull(feeAssignment.deletedAt),
        ),
      );
    return (row?.n ?? 0) > 0;
  },

  async createFeeAssignment(
    tx: Tx,
    input: {
      studentId: StudentId;
      feeHeadId: FeeHeadId;
      academicYearId: AcademicYearId;
      amountMinor: bigint;
      reason: string;
      actorId: PersonId;
    },
  ): Promise<FeeAssignmentId> {
    const id = Ids.generate<'feeAssignment'>();
    await tx.insert(feeAssignment).values({
      id,
      studentId: input.studentId,
      feeHeadId: input.feeHeadId,
      academicYearId: input.academicYearId,
      amountMinor: input.amountMinor,
      reason: input.reason,
      createdBy: input.actorId,
    });
    return id;
  },

  async listFeeAssignments(
    tx: Tx,
    filter: { studentId?: StudentId | undefined },
  ): Promise<FeeAssignmentRecord[]> {
    const conditions = [isNull(feeAssignment.deletedAt)];
    if (filter.studentId) conditions.push(eq(feeAssignment.studentId, filter.studentId));
    return tx
      .select({
        id: feeAssignment.id,
        studentId: feeAssignment.studentId,
        feeHeadId: feeAssignment.feeHeadId,
        academicYearId: feeAssignment.academicYearId,
        amountMinor: feeAssignment.amountMinor,
        reason: feeAssignment.reason,
      })
      .from(feeAssignment)
      .where(and(...conditions));
  },

  // ── discounts ─────────────────────────────────────────────────────────────

  async createDiscount(
    tx: Tx,
    input: {
      studentId: StudentId;
      feeHeadId: FeeHeadId | null;
      kind: 'sibling' | 'staff_child' | 'merit' | 'need' | 'other';
      valueMinor: bigint | null;
      percent: string | null;
      validFrom: LocalDate;
      validTo: LocalDate | null;
      reason: string;
      actorId: PersonId;
    },
  ): Promise<DiscountId> {
    const id = Ids.generate<'discount'>();
    await tx.insert(discount).values({
      id,
      studentId: input.studentId,
      feeHeadId: input.feeHeadId,
      kind: input.kind,
      valueMinor: input.valueMinor,
      percent: input.percent,
      validFrom: input.validFrom,
      validTo: input.validTo,
      reason: input.reason,
      requestedBy: input.actorId,
      createdBy: input.actorId,
    });
    return id;
  },

  async discountById(tx: Tx, id: DiscountId): Promise<DiscountRecord | undefined> {
    const [row] = await tx
      .select({
        id: discount.id,
        studentId: discount.studentId,
        feeHeadId: discount.feeHeadId,
        kind: discount.kind,
        valueMinor: discount.valueMinor,
        percent: discount.percent,
        validFrom: discount.validFrom,
        validTo: discount.validTo,
        reason: discount.reason,
        requestedBy: discount.requestedBy,
        approvedBy: discount.approvedBy,
        approvedAt: discount.approvedAt,
        status: discount.status,
      })
      .from(discount)
      .where(and(eq(discount.id, id), isNull(discount.deletedAt)))
      .limit(1);
    return row;
  },

  async approveDiscount(
    tx: Tx,
    id: DiscountId,
    input: { approvedBy: PersonId; approvedAt: Date },
  ): Promise<void> {
    await tx
      .update(discount)
      .set({
        status: 'approved',
        approvedBy: input.approvedBy,
        approvedAt: input.approvedAt,
        updatedBy: input.approvedBy,
      })
      .where(eq(discount.id, id));
  },

  async listDiscounts(
    tx: Tx,
    filter: { studentId?: StudentId | undefined },
  ): Promise<DiscountRecord[]> {
    const conditions = [isNull(discount.deletedAt)];
    if (filter.studentId) conditions.push(eq(discount.studentId, filter.studentId));
    return tx
      .select({
        id: discount.id,
        studentId: discount.studentId,
        feeHeadId: discount.feeHeadId,
        kind: discount.kind,
        valueMinor: discount.valueMinor,
        percent: discount.percent,
        validFrom: discount.validFrom,
        validTo: discount.validTo,
        reason: discount.reason,
        requestedBy: discount.requestedBy,
        approvedBy: discount.approvedBy,
        approvedAt: discount.approvedAt,
        status: discount.status,
      })
      .from(discount)
      .where(and(...conditions))
      .orderBy(desc(discount.createdAt));
  },
};
