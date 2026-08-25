# 13. Finance — schema and contracts (Phase 3b)

The beachhead module. A school switches vendors because fee collection is
painful ([§2.2](../../architecture/phase-1a/02-domain-analysis.md)), and the
exit criterion for 3b is that *the accountant trusts the numbers*.

Conventions from [§3.1](../phase-2a/03-schema-platform-identity.md); `-- + std`
is the standard column set. Every table is `[T]` and gets RLS from the template
in [§5.3](../phase-2a/05-rls-and-isolation-harness.md).

## 13.1 Fee definition

```sql
CREATE TABLE fee_head (
  -- + std
  code       text NOT NULL,
  name_bn    text NOT NULL,
  name_en    text NOT NULL,
  frequency  text NOT NULL
               CHECK (frequency IN ('one_time','monthly','term','annual')),
  is_refundable boolean NOT NULL DEFAULT false,
  gl_code    text,                      -- optional; the double-entry upgrade path
  sequence   integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, code)
);

-- Price by class, optionally narrowed to a section.
CREATE TABLE fee_structure (
  -- + std
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  fee_head_id      uuid NOT NULL REFERENCES fee_head(id),
  class_level_id   uuid REFERENCES class_level(id),
  section_id       uuid REFERENCES section(id),
  amount_minor     bigint NOT NULL CHECK (amount_minor >= 0),
  due_day          smallint CHECK (due_day BETWEEN 1 AND 31),
  -- Exactly one scope: class-wide OR section-specific, never both, never neither.
  CHECK (num_nonnulls(class_level_id, section_id) = 1)
);
CREATE UNIQUE INDEX ON fee_structure
  (tenant_id, academic_year_id, fee_head_id,
   COALESCE(class_level_id, section_id))
  WHERE deleted_at IS NULL;

-- Per-student override. Beats fee_structure.
CREATE TABLE fee_assignment (
  -- + std
  student_id       uuid NOT NULL REFERENCES student(id),
  fee_head_id      uuid NOT NULL REFERENCES fee_head(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  amount_minor     bigint NOT NULL CHECK (amount_minor >= 0),
  reason           text NOT NULL,
  UNIQUE (tenant_id, student_id, fee_head_id, academic_year_id)
);

CREATE TABLE discount (
  -- + std
  student_id   uuid NOT NULL REFERENCES student(id),
  fee_head_id  uuid REFERENCES fee_head(id),      -- NULL = all heads
  kind         text NOT NULL
                 CHECK (kind IN ('sibling','staff_child','merit','need','other')),
  value_minor  bigint CHECK (value_minor IS NULL OR value_minor >= 0),
  percent      numeric(5,2) CHECK (percent IS NULL OR percent BETWEEN 0 AND 100),
  valid_from   date NOT NULL,
  valid_to     date,
  reason       text NOT NULL,
  requested_by uuid REFERENCES person(id),
  approved_by  uuid REFERENCES person(id),
  approved_at  timestamptz,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','revoked')),
  -- Fixed amount OR percent, never both, never neither.
  CHECK (num_nonnulls(value_minor, percent) = 1),
  CHECK (status <> 'approved' OR approved_by IS NOT NULL)
);
CREATE INDEX ON discount (tenant_id, student_id, status);
```

The last `CHECK` is small and load-bearing: an approved discount without an
approver is unrepresentable, so the approval workflow cannot be bypassed by a
direct write.

## 13.2 Invoicing

```sql
CREATE TABLE invoice (
  -- + std
  student_id       uuid NOT NULL REFERENCES student(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  period_label     text NOT NULL,               -- '2027-03', '2027-T1', 'ADM'
  issued_on        date NOT NULL,
  due_date         date NOT NULL,
  total_minor      bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  discount_minor   bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  late_fee_minor   bigint NOT NULL DEFAULT 0 CHECK (late_fee_minor >= 0),
  paid_minor       bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','issued','partially_paid','paid',
                                       'written_off','void')),
  -- Arrears across academic years. Promotion never clears a balance (FR-8.7).
  carried_forward_from_invoice_id uuid REFERENCES invoice(id),
  source           text NOT NULL DEFAULT 'system'
                     CHECK (source IN ('system','import','manual')),
  CHECK (paid_minor <= total_minor - discount_minor + late_fee_minor)
);
CREATE INDEX ON invoice (tenant_id, student_id, status);
CREATE INDEX ON invoice (tenant_id, due_date) WHERE status <> 'paid';
CREATE INDEX ON invoice (tenant_id, academic_year_id, status);

CREATE TABLE invoice_line (
  -- + std
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
CREATE INDEX ON invoice_line (tenant_id, invoice_id);

-- Idempotent generation: the unique index IS the guard (§13.6).
CREATE UNIQUE INDEX ON invoice_line
  (tenant_id, invoice_id, fee_head_id) WHERE deleted_at IS NULL;
```

`source = 'import'` matters: opening dues imported in December become
carry-forward invoices structurally identical to system-generated ones
([§16](16-import-templates.md)), so every fee report treats them the same.

## 13.3 Receipts and payments

```sql
-- Gapless per school per fiscal year. NOT a PostgreSQL sequence — sequences do
-- not roll back, so they are not gapless, and a missing receipt serial reads as
-- theft to a school. Invariant 3.
CREATE TABLE receipt_sequence (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  school_id   uuid NOT NULL REFERENCES school(id),
  fiscal_year integer NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (tenant_id, school_id, fiscal_year)
);

CREATE TABLE payment (
  -- + std
  school_id       uuid NOT NULL REFERENCES school(id),
  student_id      uuid NOT NULL REFERENCES student(id),
  fiscal_year     integer NOT NULL,
  receipt_no      bigint NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        char(3) NOT NULL DEFAULT 'BDT',
  channel         text NOT NULL
                    CHECK (channel IN ('cash','bank','cheque','mfs','online')),
  channel_ref     text,                         -- deposit slip, cheque no, trx id
  -- The office enters Saturday's cash on Monday. Reports use collected_at;
  -- the audit uses both. Collapsing them makes every daily report wrong.
  collected_at    timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  collected_by    uuid NOT NULL REFERENCES person(id),
  collection_session_id uuid REFERENCES collection_session(id),
  idempotency_key text NOT NULL,
  -- Refunds are REVERSING rows, never deletes. A deleted payment is an
  -- unexplainable gap in a gapless sequence.
  reverses_payment_id  uuid REFERENCES payment(id),
  reversed_by_payment_id uuid REFERENCES payment(id),
  reversal_reason text,
  UNIQUE (tenant_id, school_id, fiscal_year, receipt_no),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (reverses_payment_id IS NULL OR reversal_reason IS NOT NULL)
);
CREATE INDEX ON payment (tenant_id, collected_at DESC);
CREATE INDEX ON payment (tenant_id, student_id, collected_at DESC);
CREATE INDEX ON payment (tenant_id, collection_session_id);

-- Many-to-many. A guardian hands over ৳3,000 against ৳5,200 owed across four
-- heads and three months. A payment.invoice_id column would make the normal
-- case in this market unrepresentable.
CREATE TABLE payment_allocation (
  -- + std
  payment_id      uuid NOT NULL REFERENCES payment(id) ON DELETE RESTRICT,
  invoice_line_id uuid NOT NULL REFERENCES invoice_line(id),
  amount_minor    bigint NOT NULL CHECK (amount_minor <> 0),
  UNIQUE (tenant_id, payment_id, invoice_line_id)
);
CREATE INDEX ON payment_allocation (tenant_id, invoice_line_id);

CREATE TABLE late_fee_accrual (
  -- + std
  invoice_id   uuid NOT NULL REFERENCES invoice(id),
  accrued_on   date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  rule_snapshot jsonb NOT NULL,                 -- the rule as it was that day
  waived_by    uuid REFERENCES person(id),
  waived_at    timestamptz,
  waive_reason text,
  reversed_at  timestamptz,                     -- retroactive holiday (§14.5)
  reversal_reason text,
  UNIQUE (tenant_id, invoice_id, accrued_on),
  CHECK (waived_by IS NULL OR waive_reason IS NOT NULL)
);

CREATE TABLE collection_session (
  -- + std
  collector_person_id uuid NOT NULL REFERENCES person(id),
  school_id      uuid NOT NULL REFERENCES school(id),
  business_date  date NOT NULL,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  expected_minor bigint,                        -- Σ cash payments in session
  counted_minor  bigint,                        -- what was in the drawer
  variance_minor bigint,
  variance_reason text,
  deposit_reference text,
  status         text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','closed','verified')),
  UNIQUE (tenant_id, collector_person_id, business_date),
  -- Variance is recorded, never silently absorbed. A ৳50 shortfall the system
  -- rounds away is how trust in every report is lost.
  CHECK (variance_minor IS NULL OR variance_minor = 0
         OR variance_reason IS NOT NULL)
);

-- Phase 3b+ (gateway ships after cash). The unique key IS the replay protection.
CREATE TABLE payment_gateway_event (
  -- + std
  provider           text NOT NULL,
  provider_ref       text NOT NULL,
  event_type         text NOT NULL,
  signature_verified boolean NOT NULL,
  payload            jsonb NOT NULL,            -- raw: disputes are settled by it
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  payment_id         uuid REFERENCES payment(id),
  state              text NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('initiated','pending','succeeded','failed',
                                        'unknown','settled','disputed')),
  UNIQUE (tenant_id, provider, provider_ref, event_type)
);
```

`state` includes **`unknown`** as a first-class value
([ADR-0020](../../architecture/adr/0020-payment-provider-abstraction.md)) — the
"money taken, callback lost" case, resolved by a `queryStatus` reconciliation
job, then a settlement-file match, then manual repair.

## 13.4 Receipt issuance

```sql
BEGIN;
  SET LOCAL synchronous_commit = 'remote_write';   -- financial RPO 0

  INSERT INTO idempotency_key (tenant_id, key, endpoint, request_hash, expires_at)
    VALUES (...);                                   -- conflict ⇒ replay original

  SELECT next_value FROM receipt_sequence
   WHERE tenant_id = $1 AND school_id = $2 AND fiscal_year = $3
     FOR UPDATE;                                    -- serialises per school
  UPDATE receipt_sequence SET next_value = next_value + 1 WHERE ...;

  INSERT INTO payment (..., receipt_no) VALUES (..., $next);
  INSERT INTO payment_allocation ...;
  UPDATE invoice_line SET paid_minor = paid_minor + ...;
  UPDATE invoice SET paid_minor = ..., status = ...;

  SELECT pgboss.send('sms.payment_receipt', ...);   -- SAME transaction
COMMIT;
```

Serialisation is affordable: a school issues hundreds of receipts a day, not
thousands a second. On rollback the counter returns with the transaction, which
is exactly why a `SEQUENCE` cannot be used here.

## 13.5 Allocation — the pure function

```ts
// modules/finance/domain/rules/allocate.ts — PURE, no IO, exhaustively tested
export function allocatePayment(
  amount: Money,
  outstanding: OutstandingLine[],      // pre-sorted by policy
  policy: AllocationOrder,
): Result<Allocation[], FinanceError> {
  // Total-preserving: Σ allocations === amount, always.
  // Uses Money.allocateByWeights for `proportional` so no poisha is invented
  // or lost (§2.1).
}
```

| Policy | Order |
|---|---|
| `oldest_first` *(default)* | Ascending `due_date`, then `fee_head.sequence` |
| `head_priority` | Configured head order — clears the exam fee first when an admit card is gated on it |
| `proportional` | Weighted by outstanding amount |
| `manual` | Collector chooses per line |

**Property tests**, not just examples: allocations always sum to the payment;
never exceed a line's outstanding; never produce a negative; are deterministic
for the same inputs.

## 13.6 Invoice generation — idempotent by construction

```
generateInvoices(school, academicYear, period):
  for each ACTIVE enrolment in academicYear:
      heads   = fee_structure(class, section) ∪ fee_assignment overrides
      applied = approved discounts valid on period start
      for each head:
          INSERT invoice_line ... ON CONFLICT (tenant_id, invoice_id, fee_head_id)
                                   DO NOTHING          ← the idempotency guard
      recompute invoice totals
      emit InvoiceGenerated
```

The guard is a **unique index**, not the job's own bookkeeping, so a concurrent
double-run cannot double-bill. Withdrawn and on-leave students are excluded; the
on-leave rule is per-tenant configuration, because some schools continue charging
tuition during medical leave and some do not.

## 13.7 API contracts

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET`/`POST` | `/api/v1/fee-heads` | `fee.read` / `fee.structure.manage` | |
| `GET`/`POST` | `/api/v1/fee-structures` | `fee.structure.manage` | |
| `POST` | `/api/v1/invoices:generate` | `fee.structure.manage` | **Idempotency-Key**; async job |
| `GET` | `/api/v1/students/:id/outstanding` | `fee.read` | Aged; drives the collection screen |
| `POST` | `/api/v1/payments` | `fee.collect` | **Idempotency-Key required** |
| `POST` | `/api/v1/payments/:id:reverse` | `fee.refund` | Reason required |
| `POST` | `/api/v1/discounts` | `fee.read` | Creates `pending` |
| `POST` | `/api/v1/discounts/:id:approve` | `fee.waive` | Reason required |
| `POST` | `/api/v1/late-fees/:id:waive` | `fee.waive` | Reason required |
| `POST` | `/api/v1/collection-sessions` | `fee.collect` | Opens a session |
| `POST` | `/api/v1/collection-sessions/:id:close` | `fee.collect` | Variance reason if non-zero |
| `POST` | `/api/v1/collection-sessions/:id:verify` | `fee.reconcile` | |
| `GET` | `/api/v1/reports/collection` | `report.financial.read` | |
| `GET` | `/api/v1/reports/outstanding` | `report.financial.read` | Aged buckets |
| `GET` | `/api/v1/reports/defaulters` | `report.financial.read` | Feeds SMS campaigns |

```ts
export const RecordPaymentSchema = z.object({
  studentId:   zUlid<'student'>(),
  amountMinor: zMoney,                          // STRING on the wire
  channel:     z.enum(['cash','bank','cheque','mfs','online']),
  channelRef:  z.string().max(64).optional(),
  collectedAt: zLocalDate,                      // may be backdated
  allocation:  z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('auto') }),
    z.object({ mode: z.literal('manual'),
               lines: z.array(z.object({ invoiceLineId: zUlid<'invoiceLine'>(),
                                         amountMinor: zMoney })).min(1) }),
  ]).default({ mode: 'auto' }),
  note: z.string().max(280).optional(),
}).refine(v => v.channel === 'cash' || !!v.channelRef,
          { message: 'errors.payment.referenceRequired', path: ['channelRef'] });

export const PaymentView = z.object({
  id: zUlid<'payment'>(),
  receiptNo: z.number().int(),                  // server-issued, never predicted
  amountMinor: z.string(),
  collectedAt: z.string(), recordedAt: z.string(),
  allocations: z.array(z.object({ invoiceLineId: z.string(),
                                  feeHeadName: z.string(),
                                  amountMinor: z.string() })),
  remainingDueMinor: z.string(),
  receiptDocumentUrl: z.string().optional(),    // signed, short-lived
});
```

Errors: `INVOICE_ALREADY_PAID` (409), `ALLOCATION_EXCEEDS_OUTSTANDING` (422),
`BACKDATE_NOT_PERMITTED` (403), `SESSION_CLOSED` (423),
`IDEMPOTENCY_KEY_REUSED` (409).

## 13.8 Events

| Event | Consumers |
|---|---|
| `InvoiceGenerated` | notification |
| `PaymentRecorded` | notification (receipt SMS), documents (receipt PDF), reporting |
| `PaymentReversed` | notification, reporting |
| `LateFeeAccrued` | notification (per-tenant opt-in) |
| `DiscountApproved` | notification, audit |
| `CollectionSessionClosed` | reporting |

All enqueued **inside** the transaction that caused them (invariant 9).

## 13.9 Acceptance for Phase 3b

1. Generate a month's invoices twice → no duplicate lines.
2. 200 concurrent payments in one school → receipt numbers `1..200`, **no gaps,
   no duplicates**.
3. Partial payment across 4 heads and 3 months allocates per policy and sums
   exactly.
4. Refund creates a reversing row; the original receipt number stays consumed.
5. Arrears survive promotion into the next academic year.
6. A retroactive holiday reverses late fees for those days
   ([§14.5](14-calendar-attendance.md)).
7. Daily reconciliation with a ৳50 variance requires and records a reason.
8. Receipt PDF prints with correct Bangla and amount-in-words.
