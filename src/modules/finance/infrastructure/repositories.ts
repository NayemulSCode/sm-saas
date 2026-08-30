/**
 * Finance reads and writes.
 *
 * Every query runs inside `withTenant`, so RLS narrows it to the caller's
 * school and a row from another tenant is simply absent rather than
 * forbidden — same discipline as every other module's repository.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import {
  feeHead,
  feeStructure,
  invoice,
  invoiceLine,
  payment,
  paymentAllocation,
  receiptSequence,
} from '../../../db/schema/finance';
import { enrolment } from '../../../db/schema/directory';
import { student } from '../../../db/schema/directoryStudents';
import { school, section } from '../../../db/schema/structure';
import { Ids } from '../../../shared/ids';
import type {
  AcademicYearId,
  ClassLevelId,
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
import type { InvoiceStatus } from '../domain/invoice';

export interface FeeHeadRow {
  id: FeeHeadId;
  code: string;
  nameBn: string;
  nameEn: string;
  frequency: 'one_time' | 'monthly' | 'term' | 'annual';
  isRefundable: boolean;
  sequence: number;
}

export const feeHeads = {
  async create(
    tx: Tx,
    input: {
      code: string;
      nameBn: string;
      nameEn: string;
      frequency: 'one_time' | 'monthly' | 'term' | 'annual';
      isRefundable: boolean;
      sequence: number;
    },
  ): Promise<FeeHeadId> {
    const id = Ids.generate<'feeHead'>();
    await tx.insert(feeHead).values({ id, ...input });
    return id;
  },

  async byCode(tx: Tx, code: string): Promise<FeeHeadRow | undefined> {
    const [row] = await tx
      .select()
      .from(feeHead)
      .where(and(eq(feeHead.code, code), isNull(feeHead.deletedAt)));
    return row;
  },

  async list(tx: Tx): Promise<FeeHeadRow[]> {
    return tx
      .select()
      .from(feeHead)
      .where(isNull(feeHead.deletedAt))
      .orderBy(feeHead.sequence);
  },
};

export interface FeeStructureRow {
  id: FeeStructureId;
  academicYearId: AcademicYearId;
  feeHeadId: FeeHeadId;
  classLevelId: ClassLevelId | null;
  sectionId: SectionId | null;
  amountMinor: bigint;
  dueDay: number | null;
}

export const feeStructures = {
  async create(
    tx: Tx,
    input: {
      academicYearId: AcademicYearId;
      feeHeadId: FeeHeadId;
      classLevelId?: ClassLevelId;
      sectionId?: SectionId;
      amountMinor: bigint;
      dueDay?: number;
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
    });
    return id;
  },

  async list(tx: Tx, academicYearId: AcademicYearId): Promise<FeeStructureRow[]> {
    return tx
      .select()
      .from(feeStructure)
      .where(and(eq(feeStructure.academicYearId, academicYearId), isNull(feeStructure.deletedAt)));
  },

  /** What applies to one enrolment: its section's own structures, falling
   *  back to its class-wide ones. A section-specific row always exists
   *  alongside, never instead of, the class-wide one at the data level —
   *  callers merge by fee_head, section winning ties (§13.1's scope CHECK
   *  guarantees at most one row per (fee_head, class-or-section)). */
  async forEnrolment(
    tx: Tx,
    academicYearId: AcademicYearId,
    classLevelId: ClassLevelId,
    sectionId: SectionId,
  ): Promise<FeeStructureRow[]> {
    return tx
      .select()
      .from(feeStructure)
      .where(
        and(
          eq(feeStructure.academicYearId, academicYearId),
          isNull(feeStructure.deletedAt),
          // `or(eq(...), eq(...))`, not a raw `sql` fragment: a ulidCol's
          // toDriver (ULID -> uuid) only runs through the typed builder.
          // Interpolating a branded id straight into `sql` skips it and
          // hands Postgres 26 Crockford-base32 characters where it wants a
          // uuid.
          or(eq(feeStructure.classLevelId, classLevelId), eq(feeStructure.sectionId, sectionId)),
        ),
      );
  },
};

export interface ActiveEnrolment {
  studentId: StudentId;
  sectionId: SectionId;
  classLevelId: ClassLevelId;
}

export const enrolments = {
  /**
   * Active enrolments for a year, ready for invoicing.
   *
   * Only `student.status = 'active'` is billed. §13.6 notes the on-leave
   * exclusion is meant to be per-tenant configuration (some schools keep
   * charging tuition through medical leave); reading that from
   * `school.settings` is not built in this slice, so on-leave students are
   * excluded — the safer default, and a one-line change once the setting
   * exists, not a reshape.
   */
  async activeFor(tx: Tx, academicYearId: AcademicYearId): Promise<ActiveEnrolment[]> {
    const rows = await tx
      .select({
        studentId: enrolment.studentId,
        sectionId: enrolment.sectionId,
        classLevelId: section.classLevelId,
      })
      .from(enrolment)
      .innerJoin(section, eq(section.id, enrolment.sectionId))
      .innerJoin(student, eq(student.id, enrolment.studentId))
      .where(
        and(
          eq(enrolment.academicYearId, academicYearId),
          isNull(enrolment.leftOn),
          isNull(enrolment.deletedAt),
          eq(student.status, 'active'),
        ),
      );
    return rows;
  },
};

export interface InvoiceRow {
  id: InvoiceId;
  studentId: StudentId;
  academicYearId: AcademicYearId;
  status: InvoiceStatus;
  totalMinor: bigint;
  discountMinor: bigint;
  lateFeeMinor: bigint;
  paidMinor: bigint;
}

export interface OutstandingRow {
  invoiceLineId: InvoiceLineId;
  invoiceId: InvoiceId;
  feeHeadName: string;
  feeHeadSequence: number;
  dueDate: string;
  outstandingMinor: bigint;
}

export const invoices = {
  async create(
    tx: Tx,
    input: {
      studentId: StudentId;
      academicYearId: AcademicYearId;
      periodLabel: string;
      issuedOn: string;
      dueDate: string;
      source: 'system' | 'import' | 'manual';
    },
  ): Promise<InvoiceId> {
    const id = Ids.generate<'invoice'>();
    // Get-or-create on (student, year, period): `DO UPDATE SET id = id` is a
    // no-op write that exists only so a conflict still RETURNs the existing
    // row — `DO NOTHING` returns nothing on conflict, which would silently
    // hand the caller an id that was never actually created. This, not the
    // generated id above, is what keeps a repeat generation resolving to the
    // SAME invoice (§13.6).
    const [row] = await tx
      .insert(invoice)
      .values({ id, status: 'issued', ...input })
      .onConflictDoUpdate({
        target: [invoice.tenantId, invoice.studentId, invoice.academicYearId, invoice.periodLabel],
        // Matches the partial unique index's own predicate — Postgres will
        // not infer a partial index as the ON CONFLICT arbiter otherwise
        // ("no unique or exclusion constraint matching the specification").
        targetWhere: isNull(invoice.deletedAt),
        set: { id: sql`${invoice.id}` },
      })
      .returning({ id: invoice.id });
    return row!.id;
  },

  /** The idempotency guard IS this unique index (§13.6) — a concurrent
   *  double-run of generation cannot double-bill. */
  async insertLineIfAbsent(
    tx: Tx,
    input: {
      invoiceId: InvoiceId;
      feeHeadId: FeeHeadId;
      description: string;
      amountMinor: bigint;
    },
  ): Promise<boolean> {
    const id = Ids.generate<'invoiceLine'>();
    const result = await tx
      .insert(invoiceLine)
      .values({ id, ...input })
      .onConflictDoNothing({
        target: [invoiceLine.tenantId, invoiceLine.invoiceId, invoiceLine.feeHeadId],
        // Same partial-index arbiter requirement as invoices.create above.
        where: isNull(invoiceLine.deletedAt),
      });
    return (result.rowCount ?? 0) > 0;
  },

  async linesFor(tx: Tx, invoiceId: InvoiceId): Promise<
    Array<{ id: InvoiceLineId; amountMinor: bigint; discountMinor: bigint; paidMinor: bigint }>
  > {
    return tx
      .select({
        id: invoiceLine.id,
        amountMinor: invoiceLine.amountMinor,
        discountMinor: invoiceLine.discountMinor,
        paidMinor: invoiceLine.paidMinor,
      })
      .from(invoiceLine)
      .where(and(eq(invoiceLine.invoiceId, invoiceId), isNull(invoiceLine.deletedAt)));
  },

  async updateTotals(
    tx: Tx,
    invoiceId: InvoiceId,
    totals: { totalMinor: bigint; discountMinor: bigint; paidMinor: bigint; status: InvoiceStatus },
  ): Promise<void> {
    await tx
      .update(invoice)
      .set({
        totalMinor: totals.totalMinor,
        discountMinor: totals.discountMinor,
        paidMinor: totals.paidMinor,
        status: totals.status,
      })
      .where(eq(invoice.id, invoiceId));
  },

  async byId(tx: Tx, id: InvoiceId): Promise<InvoiceRow | undefined> {
    const [row] = await tx.select().from(invoice).where(and(eq(invoice.id, id), isNull(invoice.deletedAt)));
    return row as InvoiceRow | undefined;
  },

  /** Aged outstanding lines for a student — what the collection screen
   *  (not built in this slice) and `recordPayment`'s auto-allocation read. */
  async outstandingFor(tx: Tx, studentId: StudentId): Promise<OutstandingRow[]> {
    const rows = await tx
      .select({
        invoiceLineId: invoiceLine.id,
        invoiceId: invoiceLine.invoiceId,
        feeHeadName: feeHead.nameEn,
        feeHeadSequence: feeHead.sequence,
        dueDate: invoice.dueDate,
        outstandingMinor: sql<string>`${invoiceLine.amountMinor} - ${invoiceLine.discountMinor} - ${invoiceLine.paidMinor}`,
      })
      .from(invoiceLine)
      .innerJoin(invoice, eq(invoice.id, invoiceLine.invoiceId))
      .innerJoin(feeHead, eq(feeHead.id, invoiceLine.feeHeadId))
      .where(
        and(
          eq(invoice.studentId, studentId),
          isNull(invoiceLine.deletedAt),
          isNull(invoice.deletedAt),
          sql`${invoiceLine.amountMinor} - ${invoiceLine.discountMinor} - ${invoiceLine.paidMinor} > 0`,
        ),
      );
    return rows.map((r) => ({ ...r, outstandingMinor: BigInt(r.outstandingMinor) }));
  },

  async applyPaymentToLine(tx: Tx, lineId: InvoiceLineId, amountMinor: bigint): Promise<void> {
    await tx
      .update(invoiceLine)
      .set({ paidMinor: sql`${invoiceLine.paidMinor} + ${amountMinor}` })
      .where(eq(invoiceLine.id, lineId));
  },
};

export const receiptSequences = {
  /**
   * The gapless issuance path (§13.4). `SELECT ... FOR UPDATE` serialises
   * concurrent payments for the same (school, fiscal year) — affordable at a
   * few hundred receipts a day, and on rollback the counter returns with the
   * transaction, which is exactly why this is a row, not a SEQUENCE.
   */
  async nextAndIncrement(tx: Tx, schoolId: SchoolId, fiscalYear: number): Promise<bigint> {
    // A single atomic upsert, not SELECT ... FOR UPDATE then branch: FOR
    // UPDATE can only lock a row that already exists, so the FIRST payment
    // of a school's fiscal year — no row yet — let concurrent transactions
    // race each other into the same INSERT and collide on the primary key
    // (caught by the concurrency test this repository exists to satisfy).
    // INSERT ... ON CONFLICT DO UPDATE is one statement Postgres serialises
    // against the unique key itself, so there is no gap between "does a row
    // exist" and "create or increment it" for two transactions to land in.
    const [row] = await tx
      .insert(receiptSequence)
      .values({ schoolId, fiscalYear, nextValue: 2n })
      .onConflictDoUpdate({
        target: [receiptSequence.tenantId, receiptSequence.schoolId, receiptSequence.fiscalYear],
        set: { nextValue: sql`${receiptSequence.nextValue} + 1` },
      })
      .returning({ nextValue: receiptSequence.nextValue });
    // The value issued is always one less than whatever next_value became —
    // true whether this call just created the row (2 - 1 = 1) or
    // incremented an existing one (old + 1 - 1 = old).
    return row!.nextValue - 1n;
  },
};

export interface PaymentRow {
  id: PaymentId;
  receiptNo: bigint;
  amountMinor: bigint;
  fiscalYear: number;
}

export const payments = {
  async byIdempotencyKey(tx: Tx, key: string): Promise<PaymentRow | undefined> {
    const [row] = await tx
      .select({
        id: payment.id,
        receiptNo: payment.receiptNo,
        amountMinor: payment.amountMinor,
        fiscalYear: payment.fiscalYear,
      })
      .from(payment)
      .where(eq(payment.idempotencyKey, key));
    return row;
  },

  async byId(tx: Tx, id: PaymentId): Promise<
    | (PaymentRow & {
        schoolId: SchoolId;
        studentId: StudentId;
        channel: 'cash' | 'bank' | 'cheque' | 'mfs' | 'online';
        reversedByPaymentId: PaymentId | null;
      })
    | undefined
  > {
    const [row] = await tx
      .select({
        id: payment.id,
        schoolId: payment.schoolId,
        studentId: payment.studentId,
        receiptNo: payment.receiptNo,
        amountMinor: payment.amountMinor,
        fiscalYear: payment.fiscalYear,
        channel: payment.channel,
        reversedByPaymentId: payment.reversedByPaymentId,
      })
      .from(payment)
      .where(and(eq(payment.id, id), isNull(payment.deletedAt)));
    return row;
  },

  async create(
    tx: Tx,
    input: {
      schoolId: SchoolId;
      studentId: StudentId;
      fiscalYear: number;
      receiptNo: bigint;
      amountMinor: bigint;
      channel: 'cash' | 'bank' | 'cheque' | 'mfs' | 'online';
      channelRef?: string | undefined;
      collectedAt: Date;
      collectedBy: PersonId;
      idempotencyKey: string;
      reversesPaymentId?: PaymentId | undefined;
      reversalReason?: string | undefined;
    },
  ): Promise<PaymentId> {
    const id = Ids.generate<'payment'>();
    await tx.insert(payment).values({ id, ...input });
    return id;
  },

  async markReversedBy(tx: Tx, originalId: PaymentId, reversalId: PaymentId): Promise<void> {
    await tx.update(payment).set({ reversedByPaymentId: reversalId }).where(eq(payment.id, originalId));
  },

  async allocationsFor(
    tx: Tx,
    paymentId: PaymentId,
  ): Promise<Array<{ invoiceLineId: InvoiceLineId; amountMinor: bigint }>> {
    return tx
      .select({ invoiceLineId: paymentAllocation.invoiceLineId, amountMinor: paymentAllocation.amountMinor })
      .from(paymentAllocation)
      .where(eq(paymentAllocation.paymentId, paymentId));
  },

  async recordAllocations(
    tx: Tx,
    paymentId: PaymentId,
    lines: ReadonlyArray<{ invoiceLineId: InvoiceLineId; amountMinor: bigint }>,
  ): Promise<void> {
    if (lines.length === 0) return;
    await tx.insert(paymentAllocation).values(
      lines.map((l) => ({
        id: Ids.generate<'paymentAllocation'>(),
        paymentId,
        invoiceLineId: l.invoiceLineId,
        amountMinor: l.amountMinor,
      })),
    );
  },

  /** The invoices touched by a set of allocations — so a reversal knows which
   *  invoice totals to recompute without the caller tracking it separately. */
  async invoicesForLines(tx: Tx, lineIds: readonly InvoiceLineId[]): Promise<InvoiceId[]> {
    if (lineIds.length === 0) return [];
    const rows = await tx
      .selectDistinct({ invoiceId: invoiceLine.invoiceId })
      .from(invoiceLine)
      .where(inArray(invoiceLine.id, lineIds));
    return rows.map((r) => r.invoiceId);
  },
};

export const schools = {
  /** `school.fiscal_year_start_month` — structure's table, read directly the
   *  same way `enrolments.activeFor` reaches into directory's. A module's
   *  infrastructure layer may query any table; only reaching into another
   *  module's `domain`/`infrastructure` FOLDER is what the boundary forbids. */
  async fiscalYearStartMonth(tx: Tx, schoolId: SchoolId): Promise<number> {
    const [row] = await tx
      .select({ fiscalYearStartMonth: school.fiscalYearStartMonth })
      .from(school)
      .where(eq(school.id, schoolId));
    return row?.fiscalYearStartMonth ?? 1;
  },
};
