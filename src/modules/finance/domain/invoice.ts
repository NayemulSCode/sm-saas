/**
 * Invoice totals and status. Pure — no IO.
 *
 * `discountMinor`/`lateFeeMinor` stay at zero everywhere in this slice (the
 * `discount` and `late_fee_accrual` tables that populate them are a later
 * slice — see the migration header) but the arithmetic already accounts for
 * them, so adding those tables later is a repository change, not a rewrite
 * of what "paid in full" means.
 */

import { Money } from '../../../shared/money';

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'written_off' | 'void';

export interface InvoiceLineAmounts {
  amountMinor: Money;
  discountMinor: Money;
  paidMinor: Money;
}

export interface InvoiceTotals {
  totalMinor: Money;
  discountMinor: Money;
  lateFeeMinor: Money;
  paidMinor: Money;
}

/** Sums a set of lines into the invoice-level totals — one place `Σ lines` happens. */
export function sumLines(lines: readonly InvoiceLineAmounts[]): Omit<InvoiceTotals, 'lateFeeMinor'> {
  return lines.reduce(
    (acc, l) => ({
      totalMinor: Money.add(acc.totalMinor, l.amountMinor),
      discountMinor: Money.add(acc.discountMinor, l.discountMinor),
      paidMinor: Money.add(acc.paidMinor, l.paidMinor),
    }),
    { totalMinor: Money.zero(), discountMinor: Money.zero(), paidMinor: Money.zero() },
  );
}

/**
 * Derives status from the numbers alone. `draft`, `written_off` and `void`
 * are never returned here — they are set by a distinct action (finalising,
 * writing off, voiding), not derived from a balance, so this function leaves
 * them exactly as it found them.
 */
export function recomputeStatus(totals: InvoiceTotals, current: InvoiceStatus): InvoiceStatus {
  if (current === 'draft' || current === 'written_off' || current === 'void') return current;

  const owed = Money.add(Money.sub(totals.totalMinor, totals.discountMinor), totals.lateFeeMinor);
  if (Money.compare(totals.paidMinor, owed) >= 0) return 'paid';
  if (!Money.isZero(totals.paidMinor)) return 'partially_paid';
  return 'issued';
}
