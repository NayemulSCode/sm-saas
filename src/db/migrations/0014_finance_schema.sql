-- 0014 — finance: fee definition, invoicing, receipts and payments.
--
-- §13 calls this "the beachhead module": a school switches vendors because fee
-- collection is painful, and the exit criterion for Phase 3b is that the
-- accountant TRUSTS THE NUMBERS. Every constraint below exists because a
-- number that can drift is a number nobody trusts, however small the drift.
--
-- SCOPE OF THIS MIGRATION. Schema only — no use case, no API route, no job
-- queue wiring yet. `payment_gateway_event` is deliberately NOT here: the spec
-- marks it "Phase 3b+ (gateway ships after cash)", and building it before the
-- cash-collection use cases exist to test it against is how its contract gets
-- guessed wrong. `domain_event` is also not here — it was specified in the
-- original shared kernel (§3.1) alongside `idempotency_key` below but never
-- migrated in Phase 3a; it is a broader observability concern than the money
-- invariants this migration exists to protect, and is tracked separately.
--
-- WHY idempotency_key IS IN A "FINANCE" MIGRATION. It isn't finance-specific —
-- §3.1 specified it as shared kernel from the start, alongside audit_log,
-- which WAS built in Phase 3a (migration 0011). This one was missed. Finance
-- is the module that cannot function without it — `POST /payments` requires
-- an Idempotency-Key by contract (§13.7), because a retried request after a
-- dropped connection must replay the original receipt, never mint a second
-- one — so it ships here rather than waiting for a dedicated migration to
-- notice the gap first.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

-- ── shared kernel gap: idempotency ──────────────────────────────────────────

-- [T] Invariant: money and bulk endpoints are idempotent. §3.1 (phase-2a),
-- specified alongside audit_log but never migrated until now.
CREATE TABLE idempotency_key (
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenant(id),
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    bytea NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idempotency_key_expires_idx ON idempotency_key (expires_at);
SELECT app.enable_tenant_rls('idempotency_key');
SELECT app.grant_table_access('idempotency_key');

-- ── 13.1 fee definition ──────────────────────────────────────────────────────

CREATE TABLE fee_head (
  id            uuid PRIMARY KEY,
  code          text NOT NULL,
  name_bn       text NOT NULL,
  name_en       text NOT NULL,
  frequency     text NOT NULL
                  CHECK (frequency IN ('one_time','monthly','term','annual')),
  is_refundable boolean NOT NULL DEFAULT false,
  -- The double-entry upgrade path (§13, not built yet) — optional so nothing
  -- here depends on a ledger existing.
  gl_code       text,
  sequence      integer NOT NULL DEFAULT 0
);
SELECT app.make_tenant_table('fee_head');
SELECT app.add_tenant_id_unique('fee_head');
ALTER TABLE fee_head ADD CONSTRAINT fee_head_code_unique UNIQUE (tenant_id, code);

-- Price by class, optionally narrowed to a section.
CREATE TABLE fee_structure (
  id                uuid PRIMARY KEY,
  academic_year_id  uuid NOT NULL,
  fee_head_id       uuid NOT NULL,
  class_level_id    uuid,
  section_id        uuid,
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),
  due_day           smallint CHECK (due_day BETWEEN 1 AND 31),
  -- Exactly one scope: class-wide OR section-specific, never both, never
  -- neither — an unscoped price has no student it could apply to.
  CONSTRAINT fee_structure_exactly_one_scope
    CHECK (num_nonnulls(class_level_id, section_id) = 1)
);
SELECT app.make_tenant_table('fee_structure');
SELECT app.tenantize_fk('fee_structure', 'academic_year_id', 'academic_year');
SELECT app.tenantize_fk('fee_structure', 'fee_head_id',      'fee_head');
SELECT app.tenantize_fk('fee_structure', 'class_level_id',   'class_level');
SELECT app.tenantize_fk('fee_structure', 'section_id',       'section');
CREATE UNIQUE INDEX fee_structure_one_price_idx ON fee_structure
  (tenant_id, academic_year_id, fee_head_id,
   COALESCE(class_level_id, section_id))
  WHERE deleted_at IS NULL;

-- Per-student override. Beats fee_structure — a scholarship or a negotiated
-- rate for one child, not a whole class.
CREATE TABLE fee_assignment (
  id                uuid PRIMARY KEY,
  student_id        uuid NOT NULL,
  fee_head_id       uuid NOT NULL,
  academic_year_id  uuid NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),
  reason            text NOT NULL
);
SELECT app.make_tenant_table('fee_assignment');
SELECT app.tenantize_fk('fee_assignment', 'student_id',       'student');
SELECT app.tenantize_fk('fee_assignment', 'fee_head_id',      'fee_head');
SELECT app.tenantize_fk('fee_assignment', 'academic_year_id', 'academic_year');
ALTER TABLE fee_assignment ADD CONSTRAINT fee_assignment_one_per_head
  UNIQUE (tenant_id, student_id, fee_head_id, academic_year_id);

CREATE TABLE discount (
  id            uuid PRIMARY KEY,
  student_id    uuid NOT NULL,
  -- NULL = every head. A sibling discount is not tied to one fee.
  fee_head_id   uuid,
  kind          text NOT NULL
                  CHECK (kind IN ('sibling','staff_child','merit','need','other')),
  value_minor   bigint CHECK (value_minor IS NULL OR value_minor >= 0),
  percent       numeric(5,2) CHECK (percent IS NULL OR percent BETWEEN 0 AND 100),
  valid_from    date NOT NULL,
  valid_to      date,
  reason        text NOT NULL,
  requested_by  uuid REFERENCES person(id),
  approved_by   uuid REFERENCES person(id),
  approved_at   timestamptz,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','revoked')),
  -- Fixed amount OR percent, never both, never neither.
  CONSTRAINT discount_exactly_one_value
    CHECK (num_nonnulls(value_minor, percent) = 1),
  -- Load-bearing: an approved discount without an approver is unrepresentable,
  -- so the approval workflow cannot be bypassed by a direct write.
  CONSTRAINT discount_approved_has_approver
    CHECK (status <> 'approved' OR approved_by IS NOT NULL)
);
SELECT app.make_tenant_table('discount');
SELECT app.tenantize_fk('discount', 'student_id',  'student');
SELECT app.tenantize_fk('discount', 'fee_head_id', 'fee_head');
CREATE INDEX discount_student_status_idx ON discount (tenant_id, student_id, status);

-- ── 13.2 invoicing ───────────────────────────────────────────────────────────

CREATE TABLE invoice (
  id                uuid PRIMARY KEY,
  student_id        uuid NOT NULL,
  academic_year_id  uuid NOT NULL,
  -- '2027-03', '2027-T1', 'ADM' — free text because the period shape differs
  -- by fee_head.frequency (monthly vs. term vs. one_time).
  period_label      text NOT NULL,
  issued_on         date NOT NULL,
  due_date          date NOT NULL,
  total_minor       bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  discount_minor    bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  late_fee_minor    bigint NOT NULL DEFAULT 0 CHECK (late_fee_minor >= 0),
  paid_minor        bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','issued','partially_paid','paid',
                                        'written_off','void')),
  -- Arrears across academic years. Promotion never clears a balance (FR-8.7) —
  -- the same non-negotiable that makes `enrolment.promotion_batch_id` (0013)
  -- point at what CREATED a row, this points at what an unpaid balance
  -- carried FROM.
  carried_forward_from_invoice_id uuid,
  source            text NOT NULL DEFAULT 'system'
                      CHECK (source IN ('system','import','manual')),
  CONSTRAINT invoice_paid_within_bounds
    CHECK (paid_minor <= total_minor - discount_minor + late_fee_minor)
);
SELECT app.make_tenant_table('invoice');
SELECT app.add_tenant_id_unique('invoice');
SELECT app.tenantize_fk('invoice', 'student_id',                       'student');
SELECT app.tenantize_fk('invoice', 'academic_year_id',                 'academic_year');
SELECT app.tenantize_fk('invoice', 'carried_forward_from_invoice_id',  'invoice');
CREATE INDEX invoice_student_status_idx ON invoice (tenant_id, student_id, status);
CREATE INDEX invoice_due_date_idx ON invoice (tenant_id, due_date) WHERE status <> 'paid';
CREATE INDEX invoice_year_status_idx ON invoice (tenant_id, academic_year_id, status);

CREATE TABLE invoice_line (
  id              uuid PRIMARY KEY,
  invoice_id      uuid NOT NULL,
  fee_head_id     uuid NOT NULL,
  description     text NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor >= 0),
  discount_minor  bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  paid_minor      bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  gl_code         text,
  CONSTRAINT invoice_line_discount_within_amount
    CHECK (discount_minor <= amount_minor),
  CONSTRAINT invoice_line_paid_within_bounds
    CHECK (paid_minor <= amount_minor - discount_minor)
);
SELECT app.make_tenant_table('invoice_line');
SELECT app.add_tenant_id_unique('invoice_line');
SELECT app.tenantize_fk('invoice_line', 'invoice_id',  'invoice', 'RESTRICT');
SELECT app.tenantize_fk('invoice_line', 'fee_head_id', 'fee_head');
CREATE INDEX invoice_line_invoice_idx ON invoice_line (tenant_id, invoice_id);

-- Idempotent generation: this unique index IS the guard (§13.6) — a
-- concurrent double-run of invoice generation cannot double-bill a head,
-- because the second INSERT ... ON CONFLICT DO NOTHING has nowhere to land.
CREATE UNIQUE INDEX invoice_line_one_head_idx ON invoice_line
  (tenant_id, invoice_id, fee_head_id) WHERE deleted_at IS NULL;

-- ── 13.3 receipts and payments ──────────────────────────────────────────────

/*
 * Gapless per school per fiscal year. NOT a PostgreSQL SEQUENCE — a sequence
 * does not roll back on a failed transaction, so it is not gapless, and a
 * missing receipt serial reads as theft to a school (invariant 3). The row is
 * locked with FOR UPDATE and incremented inside the same transaction that
 * writes the payment (§13.4), so the counter moves only when a receipt
 * actually exists to match it.
 *
 * No `id` column, no soft-delete: this is a counter, not a domain record —
 * `app.make_tenant_table` assumes both, so RLS is applied directly.
 */
CREATE TABLE receipt_sequence (
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenant(id),
  school_id   uuid NOT NULL,
  fiscal_year integer NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (tenant_id, school_id, fiscal_year)
);
SELECT app.tenantize_fk('receipt_sequence', 'school_id', 'school');
SELECT app.enable_tenant_rls('receipt_sequence');
SELECT app.grant_table_access('receipt_sequence');

CREATE TABLE collection_session (
  id                    uuid PRIMARY KEY,
  collector_person_id   uuid NOT NULL REFERENCES person(id),
  school_id             uuid NOT NULL,
  business_date         date NOT NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  expected_minor        bigint,
  counted_minor         bigint,
  variance_minor        bigint,
  variance_reason       text,
  deposit_reference     text,
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','closed','verified')),
  -- Variance is RECORDED, never silently absorbed. A ৳50 shortfall the system
  -- rounds away is how trust in every report is lost.
  CONSTRAINT collection_session_variance_has_reason
    CHECK (variance_minor IS NULL OR variance_minor = 0 OR variance_reason IS NOT NULL)
);
SELECT app.make_tenant_table('collection_session');
SELECT app.add_tenant_id_unique('collection_session');
SELECT app.tenantize_fk('collection_session', 'school_id', 'school');
ALTER TABLE collection_session ADD CONSTRAINT collection_session_one_per_day
  UNIQUE (tenant_id, collector_person_id, business_date);

CREATE TABLE payment (
  id                      uuid PRIMARY KEY,
  school_id               uuid NOT NULL,
  student_id              uuid NOT NULL,
  fiscal_year             integer NOT NULL,
  receipt_no              bigint NOT NULL,
  amount_minor            bigint NOT NULL CHECK (amount_minor > 0),
  currency                char(3) NOT NULL DEFAULT 'BDT',
  channel                 text NOT NULL
                            CHECK (channel IN ('cash','bank','cheque','mfs','online')),
  -- Deposit slip, cheque number, transaction id — required for everything
  -- except cash, enforced below rather than by NOT NULL.
  channel_ref             text,
  -- The office enters Saturday's cash on Monday. Reports use collected_at;
  -- the audit uses both. Collapsing them makes every daily report wrong.
  collected_at            timestamptz NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  collected_by            uuid NOT NULL REFERENCES person(id),
  collection_session_id   uuid,
  idempotency_key         text NOT NULL,
  -- Refunds are REVERSING rows, never deletes. A deleted payment is an
  -- unexplainable gap in a gapless sequence.
  reverses_payment_id     uuid,
  reversed_by_payment_id  uuid,
  reversal_reason         text,
  CONSTRAINT payment_reversal_has_reason
    CHECK (reverses_payment_id IS NULL OR reversal_reason IS NOT NULL)
);
SELECT app.make_tenant_table('payment');
SELECT app.add_tenant_id_unique('payment');
SELECT app.tenantize_fk('payment', 'school_id',              'school');
SELECT app.tenantize_fk('payment', 'student_id',             'student');
SELECT app.tenantize_fk('payment', 'collection_session_id',  'collection_session');
SELECT app.tenantize_fk('payment', 'reverses_payment_id',    'payment');
SELECT app.tenantize_fk('payment', 'reversed_by_payment_id', 'payment');
ALTER TABLE payment ADD CONSTRAINT payment_receipt_no_unique
  UNIQUE (tenant_id, school_id, fiscal_year, receipt_no);
ALTER TABLE payment ADD CONSTRAINT payment_idempotency_key_unique
  UNIQUE (tenant_id, idempotency_key);
CREATE INDEX payment_collected_at_idx ON payment (tenant_id, collected_at DESC);
CREATE INDEX payment_student_collected_idx
  ON payment (tenant_id, student_id, collected_at DESC);
CREATE INDEX payment_session_idx ON payment (tenant_id, collection_session_id);

-- Many-to-many. A guardian hands over ৳3,000 against ৳5,200 owed across four
-- heads and three months. A `payment.invoice_id` column would make the normal
-- case in this market unrepresentable.
CREATE TABLE payment_allocation (
  id               uuid PRIMARY KEY,
  payment_id       uuid NOT NULL,
  invoice_line_id  uuid NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor <> 0)
);
SELECT app.make_tenant_table('payment_allocation');
SELECT app.tenantize_fk('payment_allocation', 'payment_id',      'payment', 'RESTRICT');
SELECT app.tenantize_fk('payment_allocation', 'invoice_line_id', 'invoice_line');
ALTER TABLE payment_allocation ADD CONSTRAINT payment_allocation_one_per_line
  UNIQUE (tenant_id, payment_id, invoice_line_id);
CREATE INDEX payment_allocation_line_idx ON payment_allocation (tenant_id, invoice_line_id);

CREATE TABLE late_fee_accrual (
  id              uuid PRIMARY KEY,
  invoice_id      uuid NOT NULL,
  accrued_on      date NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  -- The rule as it stood that day — a later change to the late-fee policy
  -- must not silently rewrite what was already accrued.
  rule_snapshot   jsonb NOT NULL,
  waived_by       uuid REFERENCES person(id),
  waived_at       timestamptz,
  waive_reason    text,
  -- A retroactive holiday reverses late fees for those days (§14.5).
  reversed_at     timestamptz,
  reversal_reason text,
  CONSTRAINT late_fee_accrual_waive_has_reason
    CHECK (waived_by IS NULL OR waive_reason IS NOT NULL)
);
SELECT app.make_tenant_table('late_fee_accrual');
SELECT app.tenantize_fk('late_fee_accrual', 'invoice_id', 'invoice');
ALTER TABLE late_fee_accrual ADD CONSTRAINT late_fee_accrual_one_per_day
  UNIQUE (tenant_id, invoice_id, accrued_on);

-- ── channel_ref is required for everything except cash ──────────────────────

ALTER TABLE payment ADD CONSTRAINT payment_channel_ref_required
  CHECK (channel = 'cash' OR channel_ref IS NOT NULL);
