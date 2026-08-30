/**
 * Finance tables (migration 0014). All tenant-owned, all RLS, except
 * `receiptSequence` which mirrors its hand-built counterpart (a counter, not
 * an auditable entity — see the migration).
 *
 * SQL migrations are the source of truth; these mirror them for typed access.
 */

import { bigint, boolean, char, date, index, integer, pgTable, smallint, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { instant, moneyMinor, ulidCol } from '../types';
import { tenantColumns } from './columns';

export const feeHead = pgTable(
  'fee_head',
  {
    ...tenantColumns<'feeHead'>(),
    code: text('code').notNull(),
    nameBn: text('name_bn').notNull(),
    nameEn: text('name_en').notNull(),
    frequency: text('frequency', { enum: ['one_time', 'monthly', 'term', 'annual'] }).notNull(),
    isRefundable: boolean('is_refundable').notNull().default(false),
    /** The double-entry upgrade path (§13.1). Not read by anything yet. */
    glCode: text('gl_code'),
    sequence: integer('sequence').notNull().default(0),
  },
  (t) => [uniqueIndex('fee_head_code_unique').on(t.tenantId, t.code)],
);

/** Price by class, optionally narrowed to a section — never both, never neither. */
export const feeStructure = pgTable(
  'fee_structure',
  {
    ...tenantColumns<'feeStructure'>(),
    academicYearId: ulidCol<'academicYear'>('academic_year_id').notNull(),
    feeHeadId: ulidCol<'feeHead'>('fee_head_id').notNull(),
    classLevelId: ulidCol<'classLevel'>('class_level_id'),
    sectionId: ulidCol<'section'>('section_id'),
    amountMinor: moneyMinor('amount_minor').notNull(),
    dueDay: smallint('due_day'),
  },
  (t) => [
    index('fee_structure_year_head_idx').on(t.tenantId, t.academicYearId, t.feeHeadId),
  ],
);

export const invoice = pgTable(
  'invoice',
  {
    ...tenantColumns<'invoice'>(),
    studentId: ulidCol<'student'>('student_id').notNull(),
    academicYearId: ulidCol<'academicYear'>('academic_year_id').notNull(),
    /** '2027-03', '2027-T1', 'ADM' — a label, not a parseable date. */
    periodLabel: text('period_label').notNull(),
    issuedOn: date('issued_on', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    totalMinor: moneyMinor('total_minor').notNull().default(0n),
    discountMinor: moneyMinor('discount_minor').notNull().default(0n),
    lateFeeMinor: moneyMinor('late_fee_minor').notNull().default(0n),
    paidMinor: moneyMinor('paid_minor').notNull().default(0n),
    status: text('status', {
      enum: ['draft', 'issued', 'partially_paid', 'paid', 'written_off', 'void'],
    })
      .notNull()
      .default('draft'),
    /** Arrears across academic years. Promotion never clears a balance. */
    carriedForwardFromInvoiceId: ulidCol<'invoice'>('carried_forward_from_invoice_id'),
    source: text('source', { enum: ['system', 'import', 'manual'] }).notNull().default('system'),
  },
  (t) => [
    index('invoice_student_status_idx').on(t.tenantId, t.studentId, t.status),
    index('invoice_year_status_idx').on(t.tenantId, t.academicYearId, t.status),
    /** One invoice per (student, year, period) — the get-or-create key that
     *  keeps repeat generation idempotent (§13.6; see the migration). */
    uniqueIndex('invoice_student_period_unique').on(t.tenantId, t.studentId, t.academicYearId, t.periodLabel),
  ],
);

export const invoiceLine = pgTable(
  'invoice_line',
  {
    ...tenantColumns<'invoiceLine'>(),
    invoiceId: ulidCol<'invoice'>('invoice_id').notNull(),
    feeHeadId: ulidCol<'feeHead'>('fee_head_id').notNull(),
    description: text('description').notNull(),
    amountMinor: moneyMinor('amount_minor').notNull(),
    discountMinor: moneyMinor('discount_minor').notNull().default(0n),
    paidMinor: moneyMinor('paid_minor').notNull().default(0n),
    glCode: text('gl_code'),
  },
  (t) => [
    index('invoice_line_invoice_idx').on(t.tenantId, t.invoiceId),
    /** The idempotency guard for invoice generation IS this index (§13.6). */
    uniqueIndex('invoice_line_head_unique').on(t.tenantId, t.invoiceId, t.feeHeadId),
  ],
);

/**
 * Gapless per school per fiscal year. Deliberately NOT built from
 * `tenantColumns()` — no soft-delete, no created_by/updated_by, because a
 * counter is not an auditable entity (see the migration). `id` does not
 * exist on this table; the primary key is the natural key.
 */
export const receiptSequence = pgTable(
  'receipt_sequence',
  {
    /** Same default as every other tenant column (columns.ts) — set by the
     *  database from the session, but overridable, matching the migration. */
    tenantId: ulidCol<'tenant'>('tenant_id').notNull().default(sql`app.current_tenant_id()`),
    schoolId: ulidCol<'school'>('school_id').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    /** A counter, not money — plain bigint, not moneyMinor. */
    nextValue: bigint('next_value', { mode: 'bigint' }).notNull().default(1n),
  },
  (t) => [uniqueIndex('receipt_sequence_pk').on(t.tenantId, t.schoolId, t.fiscalYear)],
);

export const payment = pgTable(
  'payment',
  {
    ...tenantColumns<'payment'>(),
    schoolId: ulidCol<'school'>('school_id').notNull(),
    studentId: ulidCol<'student'>('student_id').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    /** Server-issued inside the same transaction as the sequence increment —
     *  never predicted by the client. A counter, not money — plain bigint. */
    receiptNo: bigint('receipt_no', { mode: 'bigint' }).notNull(),
    amountMinor: moneyMinor('amount_minor').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('BDT'),
    channel: text('channel', {
      enum: ['cash', 'bank', 'cheque', 'mfs', 'online'],
    }).notNull(),
    /** Deposit slip, cheque no, transaction id. */
    channelRef: text('channel_ref'),
    /** The office enters Saturday's cash on Monday — collectedAt and
     *  recordedAt are different columns on purpose. */
    collectedAt: instant('collected_at').notNull(),
    recordedAt: instant('recorded_at').notNull().defaultNow(),
    collectedBy: ulidCol<'person'>('collected_by').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Refunds are reversing rows, never deletes. */
    reversesPaymentId: ulidCol<'payment'>('reverses_payment_id'),
    reversedByPaymentId: ulidCol<'payment'>('reversed_by_payment_id'),
    reversalReason: text('reversal_reason'),
  },
  (t) => [
    uniqueIndex('payment_receipt_unique').on(t.tenantId, t.schoolId, t.fiscalYear, t.receiptNo),
    uniqueIndex('payment_idempotency_unique').on(t.tenantId, t.idempotencyKey),
    index('payment_collected_at_idx').on(t.tenantId, t.collectedAt),
    index('payment_student_collected_idx').on(t.tenantId, t.studentId, t.collectedAt),
  ],
);

/**
 * Many-to-many. A guardian hands over ৳3,000 against ৳5,200 owed across four
 * heads and three months — a payment.invoiceId column would make the normal
 * case in this market unrepresentable.
 */
export const paymentAllocation = pgTable(
  'payment_allocation',
  {
    ...tenantColumns<'paymentAllocation'>(),
    paymentId: ulidCol<'payment'>('payment_id').notNull(),
    invoiceLineId: ulidCol<'invoiceLine'>('invoice_line_id').notNull(),
    amountMinor: moneyMinor('amount_minor').notNull(),
  },
  (t) => [
    uniqueIndex('payment_allocation_unique').on(t.tenantId, t.paymentId, t.invoiceLineId),
    index('payment_allocation_line_idx').on(t.tenantId, t.invoiceLineId),
  ],
);
