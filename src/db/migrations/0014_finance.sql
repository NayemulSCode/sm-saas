-- 0014 — finance: fee definition, invoicing, receipts and payments.
--
-- Phase 3b, first slice. §13 of the engineering spec has the full ten-year
-- shape of this module (discounts, per-student overrides, late fees, cash
-- reconciliation, the online gateway); this migration ships the seven tables
-- that make the core loop real — define a fee, generate an invoice, collect a
-- payment with a gapless receipt, allocate it across whatever is owed. The
-- rest is real, named, and deferred to the slice that needs it:
--   fee_assignment, discount    — per-student overrides and the approval
--                                 workflow. invoice/invoice_line already carry
--                                 discount_minor so this is a later migration,
--                                 not a later redesign.
--   late_fee_accrual            — needs the Phase 3c working-day engine
--                                 (retroactive holiday recompute) to be
--                                 correct at all; cannot be built honestly yet.
--   collection_session          — cash-drawer reconciliation. payment has no
--                                 collection_session_id column yet for the
--                                 same reason.
--   payment_gateway_event       — the spec itself marks this "Phase 3b+".
--
-- Every domain-reference FK is composite (tenant_id, col) -> parent
-- (tenant_id, id), per the standing rule at the end of 0009: "every tenant
-- table created from here on must use composite FKs for domain references."
-- There is still no automated guard for that, so it is done by hand here,
-- the same way 0007/0008 did it.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

-- ── fee definition ───────────────────────────────────────────────────────────

CREATE TABLE fee_head (
  id            uuid PRIMARY KEY,
  code          text NOT NULL,
  name_bn       text NOT NULL,
  name_en       text NOT NULL,
  frequency     text NOT NULL
                  CHECK (frequency IN ('one_time', 'monthly', 'term', 'annual')),
  is_refundable boolean NOT NULL DEFAULT false,
  -- The double-entry upgrade path (§13.1) — not read by anything in this
  -- slice, carried now so a later ledger integration is a migration that
  -- fills a column rather than one that adds it.
  gl_code       text,
  sequence      integer NOT NULL DEFAULT 0
);
SELECT app.make_tenant_table('fee_head');
CREATE UNIQUE INDEX fee_head_code_unique ON fee_head (tenant_id, code)
  WHERE deleted_at IS NULL;

-- Price by class, optionally narrowed to a section.
CREATE TABLE fee_structure (
  id                uuid PRIMARY KEY,
  academic_year_id  uuid NOT NULL REFERENCES academic_year(id),
  fee_head_id       uuid NOT NULL REFERENCES fee_head(id),
  class_level_id    uuid REFERENCES class_level(id),
  section_id        uuid REFERENCES section(id),
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),
  due_day           smallint CHECK (due_day BETWEEN 1 AND 31),
  -- Exactly one scope: class-wide OR section-specific, never both, never
  -- neither — a fee that is silently both is a fee nobody can predict.
  CHECK (num_nonnulls(class_level_id, section_id) = 1)
);
SELECT app.make_tenant_table('fee_structure');
CREATE UNIQUE INDEX fee_structure_scope_unique ON fee_structure
  (tenant_id, academic_year_id, fee_head_id, COALESCE(class_level_id, section_id))
  WHERE deleted_at IS NULL;

-- ── invoicing ─────────────────────────────────────────────────────────────────

CREATE TABLE invoice (
  id                uuid PRIMARY KEY,
  student_id        uuid NOT NULL REFERENCES student(id),
  academic_year_id  uuid NOT NULL REFERENCES academic_year(id),
  period_label      text NOT NULL,              -- '2027-03', '2027-T1', 'ADM'
  issued_on         date NOT NULL,
  due_date          date NOT NULL,
  total_minor       bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  discount_minor    bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  late_fee_minor    bigint NOT NULL DEFAULT 0 CHECK (late_fee_minor >= 0),
  paid_minor        bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid',
                                        'written_off', 'void')),
  -- Arrears across academic years. Promotion never clears a balance.
  carried_forward_from_invoice_id uuid REFERENCES invoice(id),
  source            text NOT NULL DEFAULT 'system'
                      CHECK (source IN ('system', 'import', 'manual')),
  CHECK (paid_minor <= total_minor - discount_minor + late_fee_minor)
);
SELECT app.make_tenant_table('invoice');
CREATE INDEX invoice_student_status_idx ON invoice (tenant_id, student_id, status);
CREATE INDEX invoice_due_date_idx ON invoice (tenant_id, due_date) WHERE status <> 'paid';
CREATE INDEX invoice_year_status_idx ON invoice (tenant_id, academic_year_id, status);
-- One invoice per (student, year, period). Not in §13.2's DDL, but §13.6's
-- generation pseudocode assumes it implicitly — "for each head, INSERT
-- invoice_line ON CONFLICT DO NOTHING" only stays idempotent if a repeat run
-- resolves to the SAME invoice_id. Without this, a second run creates a
-- second invoice and the invoice_line guard never engages, because the new
-- invoice's lines have nothing to conflict with.
CREATE UNIQUE INDEX invoice_student_period_unique ON invoice
  (tenant_id, student_id, academic_year_id, period_label) WHERE deleted_at IS NULL;

CREATE TABLE invoice_line (
  id              uuid PRIMARY KEY,
  invoice_id      uuid NOT NULL REFERENCES invoice(id) ON DELETE RESTRICT,
  fee_head_id     uuid NOT NULL REFERENCES fee_head(id),
  description     text NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor >= 0),
  discount_minor  bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  paid_minor      bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  gl_code         text,
  CHECK (discount_minor <= amount_minor),
  CHECK (paid_minor <= amount_minor - discount_minor)
);
SELECT app.make_tenant_table('invoice_line');
CREATE INDEX invoice_line_invoice_idx ON invoice_line (tenant_id, invoice_id);
-- The idempotency guard for invoice generation IS this index (§13.6) — a
-- concurrent double-run cannot double-bill, because the second INSERT for the
-- same (invoice, fee_head) pair simply conflicts.
CREATE UNIQUE INDEX invoice_line_head_unique ON invoice_line
  (tenant_id, invoice_id, fee_head_id) WHERE deleted_at IS NULL;

-- ── receipts and payments ────────────────────────────────────────────────────

-- Gapless per school per fiscal year. NOT a PostgreSQL SEQUENCE — a sequence
-- does not roll back with its transaction, so it is not gapless, and a missing
-- receipt serial reads as theft to a school (invariant 1). No soft-delete or
-- audit columns: this is a counter, not an auditable entity, so it does not go
-- through app.make_tenant_table — RLS is applied directly below.
CREATE TABLE receipt_sequence (
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant_id()
                REFERENCES tenant(id) ON DELETE RESTRICT,
  school_id   uuid NOT NULL REFERENCES school(id),
  fiscal_year integer NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (tenant_id, school_id, fiscal_year)
);
SELECT app.enable_tenant_rls('receipt_sequence');
SELECT app.grant_table_access('receipt_sequence');

CREATE TABLE payment (
  id              uuid PRIMARY KEY,
  school_id       uuid NOT NULL REFERENCES school(id),
  student_id      uuid NOT NULL REFERENCES student(id),
  fiscal_year     integer NOT NULL,
  receipt_no      bigint NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        char(3) NOT NULL DEFAULT 'BDT',
  channel         text NOT NULL
                    CHECK (channel IN ('cash', 'bank', 'cheque', 'mfs', 'online')),
  channel_ref     text,                          -- deposit slip, cheque no, trx id
  -- The office enters Saturday's cash on Monday. Reports use collected_at;
  -- the audit trail keeps both. Collapsing them makes every daily report wrong.
  collected_at    timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  -- Who physically took the money — derived server-side from ctx.personId,
  -- never from the request body, so this stays a simple FK per the line drawn
  -- in 0009 (framework-derived references keep simple FKs; ones set from
  -- request payloads get tenantized).
  collected_by    uuid NOT NULL REFERENCES person(id),
  -- collection_session_id is deliberately absent: cash-drawer reconciliation
  -- is out of scope for this slice (see the file header).
  idempotency_key text NOT NULL,
  -- Refunds are REVERSING rows, never deletes. A deleted payment is an
  -- unexplainable gap in a gapless sequence.
  reverses_payment_id    uuid REFERENCES payment(id),
  reversed_by_payment_id uuid REFERENCES payment(id),
  reversal_reason text,
  CHECK (reverses_payment_id IS NULL OR reversal_reason IS NOT NULL)
);
SELECT app.make_tenant_table('payment');
-- Both reference tenant_id, so — same as every other tenant-scoped unique
-- constraint in this file — they are added AFTER make_tenant_table adds the
-- column, not inline in CREATE TABLE.
CREATE UNIQUE INDEX payment_receipt_unique ON payment
  (tenant_id, school_id, fiscal_year, receipt_no) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX payment_idempotency_unique ON payment
  (tenant_id, idempotency_key) WHERE deleted_at IS NULL;
CREATE INDEX payment_collected_at_idx ON payment (tenant_id, collected_at DESC);
CREATE INDEX payment_student_collected_idx ON payment (tenant_id, student_id, collected_at DESC);

-- Many-to-many. A guardian hands over ৳3,000 against ৳5,200 owed across four
-- heads and three months. A payment.invoice_id column would make the normal
-- case in this market unrepresentable.
CREATE TABLE payment_allocation (
  id              uuid PRIMARY KEY,
  payment_id      uuid NOT NULL REFERENCES payment(id) ON DELETE RESTRICT,
  invoice_line_id uuid NOT NULL REFERENCES invoice_line(id),
  amount_minor    bigint NOT NULL CHECK (amount_minor <> 0)
);
SELECT app.make_tenant_table('payment_allocation');
CREATE UNIQUE INDEX payment_allocation_unique ON payment_allocation
  (tenant_id, payment_id, invoice_line_id) WHERE deleted_at IS NULL;
CREATE INDEX payment_allocation_line_idx ON payment_allocation (tenant_id, invoice_line_id);

-- ── composite tenant foreign keys ────────────────────────────────────────────
-- Phase 1: tables this migration adds that something else references need
-- (tenant_id, id) unique before a composite FK can point at them.

SELECT app.add_tenant_id_unique('fee_head');
SELECT app.add_tenant_id_unique('invoice');
SELECT app.add_tenant_id_unique('invoice_line');
SELECT app.add_tenant_id_unique('payment');

-- Phase 2: every domain-reference FK, upgraded to carry the tenant.

SELECT app.tenantize_fk('fee_structure', 'academic_year_id', 'academic_year');
SELECT app.tenantize_fk('fee_structure', 'fee_head_id',       'fee_head');
SELECT app.tenantize_fk('fee_structure', 'class_level_id',    'class_level');
SELECT app.tenantize_fk('fee_structure', 'section_id',        'section');

SELECT app.tenantize_fk('invoice', 'student_id',        'student');
SELECT app.tenantize_fk('invoice', 'academic_year_id',  'academic_year');
-- Self-reference: a carry-forward invoice must chain to one in the SAME
-- tenant, the same argument as person.merged_into_person_id in 0009.
SELECT app.tenantize_fk('invoice', 'carried_forward_from_invoice_id', 'invoice');

SELECT app.tenantize_fk('invoice_line', 'invoice_id',  'invoice');
SELECT app.tenantize_fk('invoice_line', 'fee_head_id', 'fee_head');

SELECT app.tenantize_fk('receipt_sequence', 'school_id', 'school');

SELECT app.tenantize_fk('payment', 'school_id',  'school');
SELECT app.tenantize_fk('payment', 'student_id', 'student');
-- Self-references: a reversal must point within the same tenant.
SELECT app.tenantize_fk('payment', 'reverses_payment_id',    'payment');
SELECT app.tenantize_fk('payment', 'reversed_by_payment_id', 'payment');

SELECT app.tenantize_fk('payment_allocation', 'payment_id',      'payment');
SELECT app.tenantize_fk('payment_allocation', 'invoice_line_id', 'invoice_line');
