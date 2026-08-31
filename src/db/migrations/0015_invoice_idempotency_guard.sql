-- 0015 — the other half of §13.6's idempotency guard.
--
-- §13.6 calls `invoice_line`'s unique index "the idempotency guard" for a
-- re-run of invoice generation — and migration 0014 built exactly that:
-- `UNIQUE (tenant_id, invoice_id, fee_head_id) WHERE deleted_at IS NULL`.
--
-- But that only guards LINES within an invoice already found. Nothing in
-- 0014 stopped two runs — or one retried request racing itself — from
-- creating two SEPARATE `invoice` rows for the same (student, year, period)
-- in the first place, before either ever reaches a line. §13.9's first
-- acceptance test is "generate a month's invoices twice → no duplicate
-- lines", and that promise needs this index just as much as the other one.
--
-- Scoped to `source = 'system'` on purpose: a manual correction invoice
-- (`source = 'manual'`, e.g. an ad hoc adjustment an accountant enters by
-- hand) is a deliberate, one-off human action that never goes through
-- `generateInvoices` at all, and nothing about it should collide with a
-- system-generated invoice for the same period.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

CREATE UNIQUE INDEX invoice_system_one_per_period_idx ON invoice
  (tenant_id, student_id, academic_year_id, period_label)
  WHERE deleted_at IS NULL AND source = 'system';
