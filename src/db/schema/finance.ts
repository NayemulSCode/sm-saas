/**
 * Drizzle definitions for the finance tables (migration 0014).
 *
 * SQL migrations are the source of truth; these mirror them for typed access.
 * `pnpm db:check` guards the two against drift. CHECK constraints live only in
 * SQL — Postgres enforces them regardless of what TypeScript believes, which
 * is the point: `amount_minor >= 0` holds even against a hand-run `UPDATE`.
 *
 * No use case imports this yet (§13's schema ships ahead of its use cases,
 * matching how migrations 0001–0002 preceded the first tenant table) — it
 * exists so the next increment starts from typed columns instead of writing
 * them under pressure alongside the first use case.
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, char, customType, integer, jsonb, numeric, pgTable, primaryKey, smallint, text } from 'drizzle-orm/pg-core';
import { instant, localDate, moneyMinor, ulidCol } from '../types';
import { tenantColumns } from './columns';

/** Same local definition as `schema/identity.ts` — `bytea` has no shared home
 *  in `../types.ts` yet, so each file that needs it defines it once. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// ── shared kernel gap: idempotency ──────────────────────────────────────────

/**
 * Specified in §3.1 alongside `audit_log`, never migrated until this module
 * needed it (`POST /payments` requires an Idempotency-Key by contract — a
 * retried request after a dropped connection must replay the original
 * receipt, never mint a second one).
 *
 * Deliberately NOT `tenantColumns`: this row is a request-response cache
 * entry with its own expiry, not a domain record with an actor, a version or
 * a soft delete.
 */
export const idempotencyKey = pgTable('idempotency_key', {
  tenantId: ulidCol<'tenant'>('tenant_id').notNull().default(sql`app.current_tenant_id()`),
  key: text('key').notNull(),
  endpoint: text('endpoint').notNull(),
  requestHash: bytea('request_hash').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt: instant('created_at').notNull().defaultNow(),
  expiresAt: instant('expires_at').notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.key] })]);

// ── 13.1 fee definition ──────────────────────────────────────────────────────

export const feeHead = pgTable('fee_head', {
  ...tenantColumns<'feeHead'>(),
  code: text('code').notNull(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  frequency: text('frequency', { enum: ['one_time', 'monthly', 'term', 'annual'] }).notNull(),
  isRefundable: boolean('is_refundable').notNull().default(false),
  glCode: text('gl_code'),
  sequence: integer('sequence').notNull().default(0),
});

export const feeStructure = pgTable('fee_structure', {
  ...tenantColumns<'feeStructure'>(),
  academicYearId: ulidCol<'academicYear'>('academic_year_id').notNull(),
  feeHeadId: ulidCol<'feeHead'>('fee_head_id').notNull(),
  /** Exactly one of these is set — enforced in SQL, not here. */
  classLevelId: ulidCol<'classLevel'>('class_level_id'),
  sectionId: ulidCol<'section'>('section_id'),
  amountMinor: moneyMinor('amount_minor').notNull(),
  dueDay: smallint('due_day'),
});

export const feeAssignment = pgTable('fee_assignment', {
  ...tenantColumns<'feeAssignment'>(),
  studentId: ulidCol<'student'>('student_id').notNull(),
  feeHeadId: ulidCol<'feeHead'>('fee_head_id').notNull(),
  academicYearId: ulidCol<'academicYear'>('academic_year_id').notNull(),
  amountMinor: moneyMinor('amount_minor').notNull(),
  reason: text('reason').notNull(),
});

export const discount = pgTable('discount', {
  ...tenantColumns<'discount'>(),
  studentId: ulidCol<'student'>('student_id').notNull(),
  /** NULL = every head. */
  feeHeadId: ulidCol<'feeHead'>('fee_head_id'),
  kind: text('kind', {
    enum: ['sibling', 'staff_child', 'merit', 'need', 'other'],
  }).notNull(),
  /** Exactly one of value/percent is set — enforced in SQL. */
  valueMinor: moneyMinor('value_minor'),
  percent: numeric('percent', { precision: 5, scale: 2 }),
  validFrom: localDate('valid_from').notNull(),
  validTo: localDate('valid_to'),
  reason: text('reason').notNull(),
  requestedBy: ulidCol<'person'>('requested_by'),
  approvedBy: ulidCol<'person'>('approved_by'),
  approvedAt: instant('approved_at'),
  status: text('status', {
    enum: ['pending', 'approved', 'rejected', 'revoked'],
  }).notNull().default('pending'),
});

// ── 13.2 invoicing ───────────────────────────────────────────────────────────

export const invoice = pgTable('invoice', {
  ...tenantColumns<'invoice'>(),
  studentId: ulidCol<'student'>('student_id').notNull(),
  academicYearId: ulidCol<'academicYear'>('academic_year_id').notNull(),
  periodLabel: text('period_label').notNull(),
  issuedOn: localDate('issued_on').notNull(),
  dueDate: localDate('due_date').notNull(),
  totalMinor: moneyMinor('total_minor').notNull().default(0n),
  discountMinor: moneyMinor('discount_minor').notNull().default(0n),
  lateFeeMinor: moneyMinor('late_fee_minor').notNull().default(0n),
  paidMinor: moneyMinor('paid_minor').notNull().default(0n),
  status: text('status', {
    enum: ['draft', 'issued', 'partially_paid', 'paid', 'written_off', 'void'],
  }).notNull().default('draft'),
  /** Arrears across academic years — promotion never clears a balance. */
  carriedForwardFromInvoiceId: ulidCol<'invoice'>('carried_forward_from_invoice_id'),
  source: text('source', { enum: ['system', 'import', 'manual'] }).notNull().default('system'),
});

export const invoiceLine = pgTable('invoice_line', {
  ...tenantColumns<'invoiceLine'>(),
  invoiceId: ulidCol<'invoice'>('invoice_id').notNull(),
  feeHeadId: ulidCol<'feeHead'>('fee_head_id').notNull(),
  description: text('description').notNull(),
  amountMinor: moneyMinor('amount_minor').notNull(),
  discountMinor: moneyMinor('discount_minor').notNull().default(0n),
  paidMinor: moneyMinor('paid_minor').notNull().default(0n),
  glCode: text('gl_code'),
});

// ── 13.3 receipts and payments ──────────────────────────────────────────────

/**
 * The gapless counter. No `id`, no soft delete — a counter, not a domain
 * record. `next_value` is a plain integer count, not a currency amount, so it
 * stays `bigint` rather than `moneyMinor` — the distinction matters even
 * though the SQL type is identical, because `moneyMinor` marks "this is
 * money" for whoever reads the call site next.
 */
export const receiptSequence = pgTable('receipt_sequence', {
  tenantId: ulidCol<'tenant'>('tenant_id').notNull().default(sql`app.current_tenant_id()`),
  schoolId: ulidCol<'school'>('school_id').notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  nextValue: bigint('next_value', { mode: 'bigint' }).notNull().default(1n),
}, (t) => [primaryKey({ columns: [t.tenantId, t.schoolId, t.fiscalYear] })]);

export const collectionSession = pgTable('collection_session', {
  ...tenantColumns<'collectionSession'>(),
  collectorPersonId: ulidCol<'person'>('collector_person_id').notNull(),
  schoolId: ulidCol<'school'>('school_id').notNull(),
  businessDate: localDate('business_date').notNull(),
  openedAt: instant('opened_at').notNull().defaultNow(),
  closedAt: instant('closed_at'),
  expectedMinor: moneyMinor('expected_minor'),
  countedMinor: moneyMinor('counted_minor'),
  varianceMinor: moneyMinor('variance_minor'),
  varianceReason: text('variance_reason'),
  depositReference: text('deposit_reference'),
  status: text('status', { enum: ['open', 'closed', 'verified'] }).notNull().default('open'),
});

export const payment = pgTable('payment', {
  ...tenantColumns<'payment'>(),
  schoolId: ulidCol<'school'>('school_id').notNull(),
  studentId: ulidCol<'student'>('student_id').notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  /** Server-issued under `FOR UPDATE`, never predicted by the client. */
  receiptNo: bigint('receipt_no', { mode: 'bigint' }).notNull(),
  amountMinor: moneyMinor('amount_minor').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('BDT'),
  channel: text('channel', {
    enum: ['cash', 'bank', 'cheque', 'mfs', 'online'],
  }).notNull(),
  /** Required for everything except cash — enforced in SQL. */
  channelRef: text('channel_ref'),
  /** The office enters Saturday's cash on Monday — two separate instants. */
  collectedAt: instant('collected_at').notNull(),
  recordedAt: instant('recorded_at').notNull().defaultNow(),
  collectedBy: ulidCol<'person'>('collected_by').notNull(),
  collectionSessionId: ulidCol<'collectionSession'>('collection_session_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  /** Refunds are reversing rows, never deletes. */
  reversesPaymentId: ulidCol<'payment'>('reverses_payment_id'),
  reversedByPaymentId: ulidCol<'payment'>('reversed_by_payment_id'),
  reversalReason: text('reversal_reason'),
});

export const paymentAllocation = pgTable('payment_allocation', {
  ...tenantColumns<'paymentAllocation'>(),
  paymentId: ulidCol<'payment'>('payment_id').notNull(),
  invoiceLineId: ulidCol<'invoiceLine'>('invoice_line_id').notNull(),
  amountMinor: moneyMinor('amount_minor').notNull(),
});

export const lateFeeAccrual = pgTable('late_fee_accrual', {
  ...tenantColumns<'lateFeeAccrual'>(),
  invoiceId: ulidCol<'invoice'>('invoice_id').notNull(),
  accruedOn: localDate('accrued_on').notNull(),
  amountMinor: moneyMinor('amount_minor').notNull(),
  /** The rule as it stood that day — a later policy change must not rewrite it. */
  ruleSnapshot: jsonb('rule_snapshot').notNull(),
  waivedBy: ulidCol<'person'>('waived_by'),
  waivedAt: instant('waived_at'),
  waiveReason: text('waive_reason'),
  /** A retroactive holiday reverses late fees for those days (§14.5). */
  reversedAt: instant('reversed_at'),
  reversalReason: text('reversal_reason'),
});
