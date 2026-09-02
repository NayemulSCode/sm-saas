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

import { and, asc, desc, eq, gte, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import {
  collectionSession,
  discount,
  feeAssignment,
  feeHead,
  feeStructure,
  invoice,
  invoiceLine,
  payment,
  paymentAllocation,
  receiptSequence,
} from '../../../db/schema/finance';
import { academicYear, classLevel, school, section } from '../../../db/schema/structure';
import { student } from '../../../db/schema/directoryStudents';
import { enrolment } from '../../../db/schema/directory';
import { Ids } from '../../../shared/ids';
import { LocalDate } from '../../../shared/date';
import type {
  AcademicYearId,
  ClassLevelId,
  CollectionSessionId,
  DiscountId,
  FeeAssignmentId,
  FeeHeadId,
  FeeStructureId,
  InvoiceId,
  InvoiceLineId,
  PaymentId,
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

export interface ActiveEnrolment {
  studentId: StudentId;
  classLevelId: ClassLevelId;
  sectionId: SectionId;
}

/** A `fee_structure` row in scope for one (class, section) pair. `scope`
 *  tells `priceStudentFees` (domain/rules/price.ts) which one it is —
 *  section beats class for the same head. */
export interface FeeStructureCandidate {
  feeHeadId: FeeHeadId;
  amountMinor: bigint;
  scope: 'class' | 'section';
}

export interface AssignmentOverrideRecord {
  feeHeadId: FeeHeadId;
  amountMinor: bigint;
}

export interface ApprovedDiscountRecord {
  feeHeadId: FeeHeadId | null;
  valueMinor: bigint | null;
  percent: string | null;
}

/** One invoice_line a student still owes on. §13.3, §13.5. */
export interface OutstandingLineRecord {
  invoiceLineId: InvoiceLineId;
  invoiceId: InvoiceId;
  feeHeadId: FeeHeadId;
  outstandingMinor: bigint;
  dueDate: LocalDate;
  /** `fee_head.sequence` — the tiebreaker `oldest_first` uses after `dueDate`. */
  feeHeadSequence: number;
}

export interface PaymentRecord {
  id: PaymentId;
  schoolId: SchoolId;
  studentId: StudentId;
  amountMinor: bigint;
  channel: 'cash' | 'bank' | 'cheque' | 'mfs' | 'online';
  channelRef: string | null;
  reversedByPaymentId: PaymentId | null;
}

export interface CollectionSessionRecord {
  id: CollectionSessionId;
  schoolId: SchoolId;
  collectorPersonId: PersonId;
  businessDate: LocalDate;
  status: 'open' | 'closed' | 'verified';
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

  // ── invoice generation reads (§13.6) ─────────────────────────────────────

  /**
   * The cohort a generation run prices. `enrolment.outcome IS NULL` is the
   * same "still live this year" filter `directory.candidatesIn` uses for
   * promotion — an enrolment with an outcome has already been superseded.
   * `student.status = 'active'` excludes withdrawn and alumni unconditionally
   * and on-leave BY DEFAULT — §13.6 calls the on-leave rule per-tenant
   * configuration, which does not exist yet (flagged in this PR, not
   * silently guessed at).
   */
  async activeEnrolmentsFor(
    tx: Tx,
    input: { schoolId: SchoolId; academicYearId: AcademicYearId },
  ): Promise<ActiveEnrolment[]> {
    return tx
      .select({
        studentId: enrolment.studentId,
        sectionId: enrolment.sectionId,
        classLevelId: section.classLevelId,
      })
      .from(enrolment)
      .innerJoin(section, eq(section.id, enrolment.sectionId))
      .innerJoin(classLevel, eq(classLevel.id, section.classLevelId))
      .innerJoin(student, eq(student.id, enrolment.studentId))
      .where(
        and(
          eq(enrolment.academicYearId, input.academicYearId),
          eq(classLevel.schoolId, input.schoolId),
          isNull(enrolment.deletedAt),
          isNull(enrolment.outcome),
          eq(student.status, 'active'),
          isNull(student.deletedAt),
        ),
      );
  },

  /** Every `fee_structure` row that could apply to this (class, section) —
   *  both scopes, so the use case (via `priceStudentFees`) can let the more
   *  specific one win rather than this query silently picking one. */
  async structureCandidatesFor(
    tx: Tx,
    input: { academicYearId: AcademicYearId; classLevelId: ClassLevelId; sectionId: SectionId },
  ): Promise<FeeStructureCandidate[]> {
    const rows = await tx
      .select({
        feeHeadId: feeStructure.feeHeadId,
        amountMinor: feeStructure.amountMinor,
        classLevelId: feeStructure.classLevelId,
        sectionId: feeStructure.sectionId,
      })
      .from(feeStructure)
      .where(
        and(
          eq(feeStructure.academicYearId, input.academicYearId),
          or(
            eq(feeStructure.classLevelId, input.classLevelId),
            eq(feeStructure.sectionId, input.sectionId),
          ),
          isNull(feeStructure.deletedAt),
        ),
      );
    return rows.map((r) => ({
      feeHeadId: r.feeHeadId,
      amountMinor: r.amountMinor,
      scope: r.classLevelId !== null ? ('class' as const) : ('section' as const),
    }));
  },

  async assignmentOverridesFor(
    tx: Tx,
    input: { studentId: StudentId; academicYearId: AcademicYearId },
  ): Promise<AssignmentOverrideRecord[]> {
    return tx
      .select({ feeHeadId: feeAssignment.feeHeadId, amountMinor: feeAssignment.amountMinor })
      .from(feeAssignment)
      .where(
        and(
          eq(feeAssignment.studentId, input.studentId),
          eq(feeAssignment.academicYearId, input.academicYearId),
          isNull(feeAssignment.deletedAt),
        ),
      );
  },

  /** Approved, and valid ON the period's start date — §13.6: "approved
   *  discounts valid on period start". */
  async approvedDiscountsFor(
    tx: Tx,
    input: { studentId: StudentId; onDate: LocalDate },
  ): Promise<ApprovedDiscountRecord[]> {
    return tx
      .select({
        feeHeadId: discount.feeHeadId,
        valueMinor: discount.valueMinor,
        percent: discount.percent,
      })
      .from(discount)
      .where(
        and(
          eq(discount.studentId, input.studentId),
          eq(discount.status, 'approved'),
          isNull(discount.deletedAt),
          lte(discount.validFrom, input.onDate),
          or(isNull(discount.validTo), gte(discount.validTo, input.onDate)),
        ),
      );
  },

  /**
   * Idempotent lookup-or-create. Migration 0015's partial unique index
   * (`tenant_id, student_id, academic_year_id, period_label WHERE ... source
   * = 'system'`) is the actual guard — this is a fast-path SELECT first
   * (the overwhelmingly common case on a re-run: nothing to insert at all),
   * then an `ON CONFLICT DO NOTHING` insert for the genuinely-new case, then
   * a final re-SELECT for the race a concurrent caller could still win.
   * Raw SQL because Drizzle's query builder has no way to name a PARTIAL
   * index's predicate on an insert's conflict target.
   */
  async findOrCreateInvoice(
    tx: Tx,
    input: {
      studentId: StudentId;
      academicYearId: AcademicYearId;
      periodLabel: string;
      issuedOn: LocalDate;
      dueDate: LocalDate;
      actorId: PersonId;
    },
  ): Promise<{ invoiceId: InvoiceId; created: boolean }> {
    const existingCond = and(
      eq(invoice.studentId, input.studentId),
      eq(invoice.academicYearId, input.academicYearId),
      eq(invoice.periodLabel, input.periodLabel),
      eq(invoice.source, 'system'),
      isNull(invoice.deletedAt),
    );

    const [existing] = await tx.select({ id: invoice.id }).from(invoice).where(existingCond).limit(1);
    if (existing) return { invoiceId: existing.id, created: false };

    const id = Ids.generate<'invoice'>();
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO invoice
        (id, tenant_id, student_id, academic_year_id, period_label, issued_on, due_date, source, created_by)
      VALUES
        (${Ids.toUuid(id)}, app.current_tenant_id(), ${Ids.toUuid(input.studentId)},
         ${Ids.toUuid(input.academicYearId)}, ${input.periodLabel},
         ${LocalDate.toISO(input.issuedOn)}, ${LocalDate.toISO(input.dueDate)},
         'system', ${Ids.toUuid(input.actorId)})
      ON CONFLICT (tenant_id, student_id, academic_year_id, period_label)
        WHERE deleted_at IS NULL AND source = 'system'
        DO NOTHING
      RETURNING id
    `);
    if (inserted.rows[0]) return { invoiceId: id, created: true };

    // Lost the race — a concurrent caller's insert won between the SELECT
    // above and this one.
    const [winner] = await tx.select({ id: invoice.id }).from(invoice).where(existingCond).limit(1);
    if (!winner) {
      throw new Error(
        'findOrCreateInvoice: insert conflicted but no row was found — the unique index and this query have drifted apart',
      );
    }
    return { invoiceId: winner.id, created: false };
  },

  /** `ON CONFLICT DO NOTHING` against `invoice_line`'s own unique index —
   *  §13.6's own words for it: "the idempotency guard" for a re-run. Same
   *  raw-SQL reasoning as `findOrCreateInvoice`. */
  async insertInvoiceLineIfAbsent(
    tx: Tx,
    input: {
      invoiceId: InvoiceId;
      feeHeadId: FeeHeadId;
      description: string;
      amountMinor: bigint;
      discountMinor: bigint;
      actorId: PersonId;
    },
  ): Promise<boolean> {
    const id = Ids.generate<'invoiceLine'>();
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO invoice_line
        (id, tenant_id, invoice_id, fee_head_id, description, amount_minor, discount_minor, created_by)
      VALUES
        (${Ids.toUuid(id)}, app.current_tenant_id(), ${Ids.toUuid(input.invoiceId)},
         ${Ids.toUuid(input.feeHeadId)}, ${input.description}, ${input.amountMinor},
         ${input.discountMinor}, ${Ids.toUuid(input.actorId)})
      ON CONFLICT (tenant_id, invoice_id, fee_head_id) WHERE deleted_at IS NULL
        DO NOTHING
      RETURNING id
    `);
    return inserted.rows.length > 0;
  },

  /** Sums `invoice_line` back onto `invoice.total_minor`/`discount_minor`
   *  and marks it `issued` — there is no draft-editing workflow yet, so
   *  generation is the only path to `issued` and skips `draft` entirely. */
  async recomputeInvoiceTotals(
    tx: Tx,
    invoiceId: InvoiceId,
    actorId: PersonId,
  ): Promise<{ totalMinor: bigint; discountMinor: bigint }> {
    const [totals] = await tx
      .select({
        total: sql<string>`coalesce(sum(${invoiceLine.amountMinor}), 0)`,
        discount: sql<string>`coalesce(sum(${invoiceLine.discountMinor}), 0)`,
      })
      .from(invoiceLine)
      .where(and(eq(invoiceLine.invoiceId, invoiceId), isNull(invoiceLine.deletedAt)));

    const totalMinor = BigInt(totals?.total ?? '0');
    const discountMinor = BigInt(totals?.discount ?? '0');

    await tx
      .update(invoice)
      .set({ totalMinor, discountMinor, status: 'issued', updatedBy: actorId })
      .where(eq(invoice.id, invoiceId));

    return { totalMinor, discountMinor };
  },

  // ── payment recording reads and writes (§13.3, §13.4) ────────────────────

  /** Which school a student belongs to right now, via their CURRENT-year
   *  enrolment — same derivation `activeEnrolmentsFor` uses for invoice
   *  generation. Also the school's own fiscal-year start month, since a
   *  payment's fiscal year depends on it. */
  async studentCurrentSchool(
    tx: Tx,
    studentId: StudentId,
  ): Promise<{ schoolId: SchoolId; fiscalYearStartMonth: number } | undefined> {
    const [row] = await tx
      .select({ schoolId: school.id, fiscalYearStartMonth: school.fiscalYearStartMonth })
      .from(enrolment)
      .innerJoin(section, eq(section.id, enrolment.sectionId))
      .innerJoin(classLevel, eq(classLevel.id, section.classLevelId))
      .innerJoin(school, eq(school.id, classLevel.schoolId))
      .innerJoin(
        academicYear,
        and(eq(academicYear.id, enrolment.academicYearId), eq(academicYear.isCurrent, true)),
      )
      .where(and(eq(enrolment.studentId, studentId), isNull(enrolment.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * Every line this student still owes on, across every non-void,
   * non-written-off invoice — `oldest_first` needs `dueDate` and
   * `feeHeadSequence` to sort by (§13.5's own ordering table); `manual` needs
   * the full set regardless, to validate against.
   *
   * The subtraction happens in JS, not SQL: the set is a handful of rows per
   * student, and three plain bigint columns read out are simpler to reason
   * about than a raw arithmetic expression inside the query.
   */
  async outstandingLinesFor(tx: Tx, studentId: StudentId): Promise<OutstandingLineRecord[]> {
    const rows = await tx
      .select({
        invoiceLineId: invoiceLine.id,
        invoiceId: invoiceLine.invoiceId,
        feeHeadId: invoiceLine.feeHeadId,
        amountMinor: invoiceLine.amountMinor,
        discountMinor: invoiceLine.discountMinor,
        paidMinor: invoiceLine.paidMinor,
        dueDate: invoice.dueDate,
        feeHeadSequence: feeHead.sequence,
      })
      .from(invoiceLine)
      .innerJoin(invoice, eq(invoice.id, invoiceLine.invoiceId))
      .innerJoin(feeHead, eq(feeHead.id, invoiceLine.feeHeadId))
      .where(
        and(
          eq(invoice.studentId, studentId),
          isNull(invoiceLine.deletedAt),
          isNull(invoice.deletedAt),
          notInArray(invoice.status, ['void', 'written_off']),
        ),
      );

    return rows
      .map((r) => ({
        invoiceLineId: r.invoiceLineId,
        invoiceId: r.invoiceId,
        feeHeadId: r.feeHeadId,
        outstandingMinor: r.amountMinor - r.discountMinor - r.paidMinor,
        dueDate: r.dueDate,
        feeHeadSequence: r.feeHeadSequence,
      }))
      .filter((r) => r.outstandingMinor > 0n);
  },

  /**
   * The gapless counter. §13.4's own transaction sketch, verbatim: lock the
   * row, read it, increment it — all before the payment that consumes the
   * number exists, so a rollback (a later step in the same transaction
   * failing) returns the counter with it. A `SEQUENCE` cannot do this; it does
   * not roll back, which is exactly why `receipt_sequence` is a plain table.
   *
   * The seed insert handles a school's first receipt of a fiscal year — there
   * is no row to lock yet, so one is created at `next_value = 1` first.
   */
  async nextReceiptNo(
    tx: Tx,
    input: { schoolId: SchoolId; fiscalYear: number },
  ): Promise<bigint> {
    await tx
      .insert(receiptSequence)
      .values({ schoolId: input.schoolId, fiscalYear: input.fiscalYear })
      .onConflictDoNothing();

    const locked = await tx.execute<{ next_value: string }>(sql`
      SELECT next_value FROM receipt_sequence
       WHERE tenant_id = app.current_tenant_id()
         AND school_id = ${Ids.toUuid(input.schoolId)}
         AND fiscal_year = ${input.fiscalYear}
       FOR UPDATE
    `);
    const current = BigInt(locked.rows[0]?.next_value ?? '1');

    await tx
      .update(receiptSequence)
      .set({ nextValue: current + 1n })
      .where(
        and(eq(receiptSequence.schoolId, input.schoolId), eq(receiptSequence.fiscalYear, input.fiscalYear)),
      );

    return current;
  },

  async createPayment(
    tx: Tx,
    input: {
      schoolId: SchoolId;
      studentId: StudentId;
      fiscalYear: number;
      receiptNo: bigint;
      amountMinor: bigint;
      channel: 'cash' | 'bank' | 'cheque' | 'mfs' | 'online';
      channelRef: string | null;
      collectedAt: Date;
      /** Explicit rather than the column's own `defaultNow()` — a use case
       *  under an injected test clock needs its OWN idea of "now" to reach
       *  the stored row, the same reasoning `audit()` takes its timestamp
       *  from the caller rather than the database. */
      recordedAt: Date;
      collectedBy: PersonId;
      idempotencyKey: string;
      actorId: PersonId;
      /** Set together, or not at all — a REVERSING payment (§13.3's own
       *  words: "refunds are reversing rows, never deletes"). The CHECK
       *  `reverses_payment_id IS NULL OR reversal_reason IS NOT NULL` is the
       *  same rule enforced a second time, in SQL. */
      reversesPaymentId?: PaymentId | undefined;
      reversalReason?: string | undefined;
      /** The collector's own open cash-drawer session, if one exists and
       *  this is cash — §13.3: `expected_minor` is "Σ cash payments in
       *  session", so only cash payments are ever attached. Left `null`
       *  when the collector has no session open; sessions are opt-in. */
      collectionSessionId?: CollectionSessionId | undefined;
    },
  ): Promise<PaymentId> {
    const id = Ids.generate<'payment'>();
    await tx.insert(payment).values({
      id,
      schoolId: input.schoolId,
      studentId: input.studentId,
      fiscalYear: input.fiscalYear,
      receiptNo: input.receiptNo,
      amountMinor: input.amountMinor,
      channel: input.channel,
      channelRef: input.channelRef,
      collectedAt: input.collectedAt,
      recordedAt: input.recordedAt,
      collectedBy: input.collectedBy,
      idempotencyKey: input.idempotencyKey,
      reversesPaymentId: input.reversesPaymentId ?? null,
      reversalReason: input.reversalReason ?? null,
      collectionSessionId: input.collectionSessionId ?? null,
      createdBy: input.actorId,
    });
    return id;
  },

  async createPaymentAllocation(
    tx: Tx,
    input: {
      paymentId: PaymentId;
      invoiceLineId: InvoiceLineId;
      amountMinor: bigint;
      actorId: PersonId;
    },
  ): Promise<void> {
    await tx.insert(paymentAllocation).values({
      id: Ids.generate<'paymentAllocation'>(),
      paymentId: input.paymentId,
      invoiceLineId: input.invoiceLineId,
      amountMinor: input.amountMinor,
      createdBy: input.actorId,
    });
  },

  async addPaidToLine(
    tx: Tx,
    invoiceLineId: InvoiceLineId,
    amountMinor: bigint,
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(invoiceLine)
      .set({ paidMinor: sql`${invoiceLine.paidMinor} + ${amountMinor}`, updatedBy: actorId })
      .where(eq(invoiceLine.id, invoiceLineId));
  },

  /** Sums the invoice's own lines back onto `invoice.paid_minor` and derives
   *  `status` — `paid` once nothing remains, `partially_paid` once something
   *  has landed, `issued` (unchanged) otherwise. Never touches `draft`,
   *  `written_off` or `void` — a payment against one of those is refused
   *  before this is ever called. */
  async recomputeInvoicePaidStatus(
    tx: Tx,
    invoiceId: InvoiceId,
    actorId: PersonId,
  ): Promise<{ paidMinor: bigint; status: string }> {
    const [sums] = await tx
      .select({ paid: sql<string>`coalesce(sum(${invoiceLine.paidMinor}), 0)` })
      .from(invoiceLine)
      .where(and(eq(invoiceLine.invoiceId, invoiceId), isNull(invoiceLine.deletedAt)));
    const paidMinor = BigInt(sums?.paid ?? '0');

    const [inv] = await tx
      .select({ totalMinor: invoice.totalMinor, discountMinor: invoice.discountMinor })
      .from(invoice)
      .where(eq(invoice.id, invoiceId))
      .limit(1);
    if (!inv) {
      throw new Error(`recomputeInvoicePaidStatus: invoice ${invoiceId} not found`);
    }

    const netDue = inv.totalMinor - inv.discountMinor;
    const status = paidMinor >= netDue ? 'paid' : paidMinor > 0n ? 'partially_paid' : 'issued';

    await tx.update(invoice).set({ paidMinor, status, updatedBy: actorId }).where(eq(invoice.id, invoiceId));

    return { paidMinor, status };
  },

  // ── payment reversal (§13.3) ─────────────────────────────────────────────

  async paymentById(tx: Tx, id: PaymentId): Promise<PaymentRecord | undefined> {
    const [row] = await tx
      .select({
        id: payment.id,
        schoolId: payment.schoolId,
        studentId: payment.studentId,
        amountMinor: payment.amountMinor,
        channel: payment.channel,
        channelRef: payment.channelRef,
        reversedByPaymentId: payment.reversedByPaymentId,
      })
      .from(payment)
      .where(and(eq(payment.id, id), isNull(payment.deletedAt)))
      .limit(1);
    return row;
  },

  /** Newest first — the order a person scanning for "the one I just took"
   *  or "the one from last week" actually wants. `id DESC` breaks ties on
   *  `recordedAt`, which two payments genuinely can share (a fixed test
   *  clock; two rows recorded in the same instant in production) — the
   *  ULID's own ordering is exactly the "strict, not merely millisecond
   *  granular" guarantee `shared/ids.ts` built the monotonic factory for. */
  async paymentsForStudent(
    tx: Tx,
    studentId: StudentId,
  ): Promise<
    Array<{
      id: PaymentId;
      receiptNo: bigint;
      amountMinor: bigint;
      channel: 'cash' | 'bank' | 'cheque' | 'mfs' | 'online';
      channelRef: string | null;
      collectedAt: Date;
      recordedAt: Date;
      reversesPaymentId: PaymentId | null;
      reversedByPaymentId: PaymentId | null;
      reversalReason: string | null;
    }>
  > {
    return tx
      .select({
        id: payment.id,
        receiptNo: payment.receiptNo,
        amountMinor: payment.amountMinor,
        channel: payment.channel,
        channelRef: payment.channelRef,
        collectedAt: payment.collectedAt,
        recordedAt: payment.recordedAt,
        reversesPaymentId: payment.reversesPaymentId,
        reversedByPaymentId: payment.reversedByPaymentId,
        reversalReason: payment.reversalReason,
      })
      .from(payment)
      .where(and(eq(payment.studentId, studentId), isNull(payment.deletedAt)))
      .orderBy(desc(payment.recordedAt), desc(payment.id));
  },

  async schoolFiscalYearStartMonth(tx: Tx, schoolId: SchoolId): Promise<number | undefined> {
    const [row] = await tx
      .select({ fiscalYearStartMonth: school.fiscalYearStartMonth })
      .from(school)
      .where(eq(school.id, schoolId))
      .limit(1);
    return row?.fiscalYearStartMonth;
  },

  /** The original payment's own allocations, joined through to each line's
   *  invoice and fee head — everything a reversal needs to mirror them with
   *  negated amounts, and everything the response view needs to describe
   *  what got undone. */
  async paymentAllocationsFor(
    tx: Tx,
    paymentId: PaymentId,
  ): Promise<
    Array<{
      invoiceLineId: InvoiceLineId;
      invoiceId: InvoiceId;
      feeHeadId: FeeHeadId;
      amountMinor: bigint;
    }>
  > {
    return tx
      .select({
        invoiceLineId: paymentAllocation.invoiceLineId,
        invoiceId: invoiceLine.invoiceId,
        feeHeadId: invoiceLine.feeHeadId,
        amountMinor: paymentAllocation.amountMinor,
      })
      .from(paymentAllocation)
      .innerJoin(invoiceLine, eq(invoiceLine.id, paymentAllocation.invoiceLineId))
      .where(and(eq(paymentAllocation.paymentId, paymentId), isNull(paymentAllocation.deletedAt)));
  },

  async markPaymentReversed(
    tx: Tx,
    originalPaymentId: PaymentId,
    reversingPaymentId: PaymentId,
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(payment)
      .set({ reversedByPaymentId: reversingPaymentId, updatedBy: actorId })
      .where(eq(payment.id, originalPaymentId));
  },

  // ── collection sessions (§13.3) ──────────────────────────────────────────

  /**
   * The collector's session for one business date, whatever its status.
   * `(tenant_id, collector_person_id, business_date)` is UNIQUE — a person
   * runs at most one cash drawer on a given day, tenant-wide, not
   * per-school, which is why this takes no `schoolId`.
   */
  async collectorSessionFor(
    tx: Tx,
    input: { collectorPersonId: PersonId; businessDate: LocalDate },
  ): Promise<CollectionSessionRecord | undefined> {
    const [row] = await tx
      .select({
        id: collectionSession.id,
        schoolId: collectionSession.schoolId,
        collectorPersonId: collectionSession.collectorPersonId,
        businessDate: collectionSession.businessDate,
        status: collectionSession.status,
      })
      .from(collectionSession)
      .where(
        and(
          eq(collectionSession.collectorPersonId, input.collectorPersonId),
          eq(collectionSession.businessDate, input.businessDate),
          isNull(collectionSession.deletedAt),
        ),
      )
      .limit(1);
    return row;
  },

  async collectionSessionById(
    tx: Tx,
    id: CollectionSessionId,
  ): Promise<CollectionSessionRecord | undefined> {
    const [row] = await tx
      .select({
        id: collectionSession.id,
        schoolId: collectionSession.schoolId,
        collectorPersonId: collectionSession.collectorPersonId,
        businessDate: collectionSession.businessDate,
        status: collectionSession.status,
      })
      .from(collectionSession)
      .where(and(eq(collectionSession.id, id), isNull(collectionSession.deletedAt)))
      .limit(1);
    return row;
  },

  async createCollectionSession(
    tx: Tx,
    input: {
      collectorPersonId: PersonId;
      schoolId: SchoolId;
      businessDate: LocalDate;
      actorId: PersonId;
    },
  ): Promise<CollectionSessionId> {
    const id = Ids.generate<'collectionSession'>();
    await tx.insert(collectionSession).values({
      id,
      collectorPersonId: input.collectorPersonId,
      schoolId: input.schoolId,
      businessDate: input.businessDate,
      createdBy: input.actorId,
    });
    return id;
  },

  /**
   * "Σ cash payments in session" (§13.3) — net of any reversal also attached
   * to it. Every row this sums is cash by construction (`recordPayment` and
   * `reversePayment` only ever attach cash), so the sign is the only thing
   * that needs deciding: a reversal subtracts, an ordinary payment adds.
   */
  async sessionCashTotal(tx: Tx, sessionId: CollectionSessionId): Promise<bigint> {
    const [row] = await tx
      .select({
        total: sql<string>`coalesce(sum(
          case when ${payment.reversesPaymentId} is null
               then ${payment.amountMinor}
               else -${payment.amountMinor}
          end
        ), 0)`,
      })
      .from(payment)
      .where(and(eq(payment.collectionSessionId, sessionId), isNull(payment.deletedAt)));
    return BigInt(row?.total ?? '0');
  },

  async closeCollectionSession(
    tx: Tx,
    input: {
      sessionId: CollectionSessionId;
      expectedMinor: bigint;
      countedMinor: bigint;
      varianceMinor: bigint;
      varianceReason: string | null;
      closedAt: Date;
      actorId: PersonId;
    },
  ): Promise<void> {
    await tx
      .update(collectionSession)
      .set({
        status: 'closed',
        closedAt: input.closedAt,
        expectedMinor: input.expectedMinor,
        countedMinor: input.countedMinor,
        varianceMinor: input.varianceMinor,
        varianceReason: input.varianceReason,
        updatedBy: input.actorId,
      })
      .where(eq(collectionSession.id, input.sessionId));
  },

  async verifyCollectionSession(
    tx: Tx,
    input: { sessionId: CollectionSessionId; depositReference: string | null; actorId: PersonId },
  ): Promise<void> {
    await tx
      .update(collectionSession)
      .set({ status: 'verified', depositReference: input.depositReference, updatedBy: input.actorId })
      .where(eq(collectionSession.id, input.sessionId));
  },
};
