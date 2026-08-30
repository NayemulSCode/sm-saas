import { describe, it, expect } from 'vitest';
import { Money } from '../../../shared/money';
import { allocatePayment, AllocationErrors, type OutstandingLine } from './allocate';
import type { InvoiceLineId } from '../../../shared/ids';

const lineId = (n: number): InvoiceLineId => `line-${n}` as InvoiceLineId;

function line(n: number, dueDate: string, sequence: number, outstandingMinor: number): OutstandingLine {
  return {
    invoiceLineId: lineId(n),
    dueDate,
    feeHeadSequence: sequence,
    outstanding: Money.fromMinor(outstandingMinor),
  };
}

describe('allocatePayment — oldest_first', () => {
  it('fills the earliest due date first, then the next', () => {
    const lines = [line(1, '2027-03-01', 0, 20000), line(2, '2027-01-01', 0, 10000)];
    const result = allocatePayment(Money.fromMinor(15000), lines, {
      mode: 'auto',
      policy: 'oldest_first',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2027-01-01 (line 2) is oldest: takes its full 10000, then 5000 of line 1.
    expect(result.value).toEqual([
      { invoiceLineId: lineId(2), amount: Money.fromMinor(10000) },
      { invoiceLineId: lineId(1), amount: Money.fromMinor(5000) },
    ]);
  });

  it('ties on due date break by fee_head.sequence', () => {
    const lines = [line(1, '2027-01-01', 2, 10000), line(2, '2027-01-01', 1, 10000)];
    const result = allocatePayment(Money.fromMinor(5000), lines, {
      mode: 'auto',
      policy: 'oldest_first',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ invoiceLineId: lineId(2), amount: Money.fromMinor(5000) }]);
  });
});

describe('allocatePayment — head_priority', () => {
  it('clears the lowest sequence first regardless of due date', () => {
    const lines = [line(1, '2027-01-01', 5, 10000), line(2, '2027-06-01', 1, 10000)];
    const result = allocatePayment(Money.fromMinor(5000), lines, {
      mode: 'auto',
      policy: 'head_priority',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sequence 1 (line 2, due later) is cleared first — the exam fee ahead of
    // an earlier-due but lower-priority head.
    expect(result.value).toEqual([{ invoiceLineId: lineId(2), amount: Money.fromMinor(5000) }]);
  });
});

describe('allocatePayment — proportional', () => {
  it('splits by outstanding weight and preserves the total exactly', () => {
    // Weights 1:2 on an amount that does not divide evenly.
    const lines = [line(1, '2027-01-01', 0, 10000), line(2, '2027-01-01', 0, 20000)];
    const result = allocatePayment(Money.fromMinor(10001), lines, {
      mode: 'auto',
      policy: 'proportional',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sum = result.value.reduce((s, a) => Money.add(s, a.amount), Money.zero());
    expect(sum).toEqual(Money.fromMinor(10001));
    // Neither share exceeds what that line actually owes.
    for (const a of result.value) {
      const owed = lines.find((l) => l.invoiceLineId === a.invoiceLineId)!.outstanding;
      expect(Money.compare(a.amount, owed)).toBeLessThanOrEqual(0);
    }
  });
});

describe('allocatePayment — manual', () => {
  const lines = [line(1, '2027-01-01', 0, 10000), line(2, '2027-01-01', 0, 5000)];

  it('accepts a split that sums exactly and stays within each line', () => {
    const result = allocatePayment(Money.fromMinor(8000), lines, {
      mode: 'manual',
      lines: [
        { invoiceLineId: lineId(1), amount: Money.fromMinor(6000) },
        { invoiceLineId: lineId(2), amount: Money.fromMinor(2000) },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a split that does not sum to the payment amount', () => {
    const result = allocatePayment(Money.fromMinor(8000), lines, {
      mode: 'manual',
      lines: [{ invoiceLineId: lineId(1), amount: Money.fromMinor(6000) }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(AllocationErrors.ALLOCATION_MISMATCH.code);
  });

  it('rejects a line amount exceeding what that line owes', () => {
    // Line 1 owes 10000; asking to apply 10001 to it exceeds that line, even
    // though the total payment (10001) is a perfectly ordinary amount.
    const result = allocatePayment(Money.fromMinor(10001), lines, {
      mode: 'manual',
      lines: [{ invoiceLineId: lineId(1), amount: Money.fromMinor(10001) }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(AllocationErrors.ALLOCATION_EXCEEDS_OUTSTANDING.code);
  });

  it('rejects a line id that is not in the outstanding set', () => {
    const result = allocatePayment(Money.fromMinor(100), lines, {
      mode: 'manual',
      lines: [{ invoiceLineId: lineId(99), amount: Money.fromMinor(100) }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(AllocationErrors.UNKNOWN_LINE.code);
  });
});

describe('allocatePayment — overpayment is refused, not silently absorbed', () => {
  it.each(['oldest_first', 'head_priority', 'proportional'] as const)('%s', (policy) => {
    const lines = [line(1, '2027-01-01', 0, 1000)];
    const result = allocatePayment(Money.fromMinor(1001), lines, { mode: 'auto', policy });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(AllocationErrors.ALLOCATION_EXCEEDS_OUTSTANDING.code);
  });
});

// ── property tests — §13.9: sums match, never exceed, never negative, deterministic ──

/** Mulberry32 — a tiny seeded PRNG, so a failure is reproducible without a
 *  fast-check dependency this codebase does not otherwise carry. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('allocatePayment — property tests', () => {
  const policies = ['oldest_first', 'head_priority', 'proportional'] as const;

  it('sums to the payment, never negative, never exceeds a line, deterministic', () => {
    const rand = mulberry32(42);

    for (let trial = 0; trial < 200; trial++) {
      const lineCount = 1 + Math.floor(rand() * 5);
      const lines: OutstandingLine[] = Array.from({ length: lineCount }, (_, i) =>
        line(i, `2027-${String(1 + (i % 12)).padStart(2, '0')}-01`, i % 3, 1 + Math.floor(rand() * 100_000)),
      );
      const total = lines.reduce((s, l) => s + l.outstanding.minor, 0n);
      const amount = Money.fromMinor((BigInt(Math.floor(rand() * 1_000_000)) % (total + 1n)) as bigint);
      const policy = policies[trial % policies.length]!;

      const request = { mode: 'auto', policy } as const;
      const first = allocatePayment(amount, lines, request);
      const second = allocatePayment(amount, lines, request);

      expect(first.ok).toBe(true);
      if (!first.ok) continue;

      // Deterministic: identical inputs, identical output.
      expect(second).toEqual(first);

      const sum = first.value.reduce((s, a) => Money.add(s, a.amount), Money.zero());
      expect(sum).toEqual(amount);

      for (const a of first.value) {
        expect(Money.isNegative(a.amount)).toBe(false);
        const owed = lines.find((l) => l.invoiceLineId === a.invoiceLineId)!.outstanding;
        expect(Money.compare(a.amount, owed)).toBeLessThanOrEqual(0);
      }
    }
  });
});
