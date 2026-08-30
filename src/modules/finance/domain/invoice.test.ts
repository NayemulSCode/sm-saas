import { describe, it, expect } from 'vitest';
import { Money } from '../../../shared/money';
import { sumLines, recomputeStatus, type InvoiceLineAmounts } from './invoice';

const amounts = (amountMinor: number, discountMinor = 0, paidMinor = 0): InvoiceLineAmounts => ({
  amountMinor: Money.fromMinor(amountMinor),
  discountMinor: Money.fromMinor(discountMinor),
  paidMinor: Money.fromMinor(paidMinor),
});

describe('sumLines', () => {
  it('sums an empty invoice to zero', () => {
    expect(sumLines([])).toEqual({
      totalMinor: Money.zero(),
      discountMinor: Money.zero(),
      paidMinor: Money.zero(),
    });
  });

  it('sums across several lines', () => {
    const totals = sumLines([amounts(1000, 100, 0), amounts(2000, 0, 500)]);
    expect(totals.totalMinor).toEqual(Money.fromMinor(3000));
    expect(totals.discountMinor).toEqual(Money.fromMinor(100));
    expect(totals.paidMinor).toEqual(Money.fromMinor(500));
  });
});

describe('recomputeStatus', () => {
  const totals = (totalMinor: number, paidMinor: number) => ({
    totalMinor: Money.fromMinor(totalMinor),
    discountMinor: Money.zero(),
    lateFeeMinor: Money.zero(),
    paidMinor: Money.fromMinor(paidMinor),
  });

  it('is issued when nothing has been paid', () => {
    expect(recomputeStatus(totals(1000, 0), 'issued')).toBe('issued');
  });

  it('is partially_paid once some but not all is paid', () => {
    expect(recomputeStatus(totals(1000, 400), 'issued')).toBe('partially_paid');
  });

  it('is paid once the full amount owed is covered', () => {
    expect(recomputeStatus(totals(1000, 1000), 'partially_paid')).toBe('paid');
  });

  it('accounts for a late fee raising what is owed', () => {
    const t = { totalMinor: Money.fromMinor(1000), discountMinor: Money.zero(), lateFeeMinor: Money.fromMinor(50), paidMinor: Money.fromMinor(1000) };
    // Paid in full against the ORIGINAL total, but a late fee since accrued —
    // still short, so still partially_paid rather than a false paid.
    expect(recomputeStatus(t, 'partially_paid')).toBe('partially_paid');
  });

  it('accounts for a discount lowering what is owed', () => {
    const t = { totalMinor: Money.fromMinor(1000), discountMinor: Money.fromMinor(200), lateFeeMinor: Money.zero(), paidMinor: Money.fromMinor(800) };
    expect(recomputeStatus(t, 'partially_paid')).toBe('paid');
  });

  it.each(['draft', 'written_off', 'void'] as const)(
    'never overrides a manual status (%s)',
    (manual) => {
      expect(recomputeStatus(totals(1000, 1000), manual)).toBe(manual);
    },
  );
});
