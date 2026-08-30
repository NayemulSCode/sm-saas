import { describe, it, expect } from 'vitest';
import { Money } from '../../../../shared/money';
import { allocatePayment, type OutstandingLine } from './allocate';

const bdt = (minor: bigint) => Money.fromMinor(minor);
const line = (id: string, outstanding: bigint): OutstandingLine => ({
  invoiceLineId: id,
  outstandingMinor: bdt(outstanding),
});

function ok(v: ReturnType<typeof allocatePayment>) {
  if (v.kind !== 'ok') throw new Error(`expected ok, got ${v.kind}`);
  return v.allocations;
}

describe('allocatePayment — worked examples', () => {
  it('oldest_first: clears the first lines fully, the payment runs out mid-line', () => {
    // ৳3,000 against ৳5,200 across four heads/three months (§13's own
    // example) — every amount here is already in poisha (minor units).
    const lines = [
      line('jan', 150000n),
      line('feb', 150000n),
      line('mar', 150000n),
      line('exam', 70000n),
    ];
    const a = ok(allocatePayment(bdt(300000n), lines, { mode: 'oldest_first' }));

    expect(a).toEqual([
      { invoiceLineId: 'jan', amountMinor: bdt(150000n) },
      { invoiceLineId: 'feb', amountMinor: bdt(150000n) },
    ]);
    // The remaining ৳0 stops the fill — mar and exam get nothing this time,
    // not a token amount each.
    expect(a).toHaveLength(2);
  });

  it('head_priority: clears the exam fee first, same lines, different order', () => {
    // Same money, same lines — reordered so the admit-card-gating head goes
    // first. The function does not sort; the caller already has.
    const lines = [
      line('exam', 70000n),
      line('jan', 150000n),
      line('feb', 150000n),
      line('mar', 150000n),
    ];
    const a = ok(allocatePayment(bdt(300000n), lines, { mode: 'head_priority' }));

    // exam(70,000) then jan(150,000) exhaust ৳2,200 of the ৳3,000; feb takes
    // the remaining ৳800 and mar gets nothing this time — the same
    // "runs out mid-line" shape as oldest_first, just in a different order.
    expect(a).toEqual([
      { invoiceLineId: 'exam', amountMinor: bdt(70000n) },
      { invoiceLineId: 'jan', amountMinor: bdt(150000n) },
      { invoiceLineId: 'feb', amountMinor: bdt(80000n) },
    ]);
  });

  it('proportional: splits by weight and still sums exactly', () => {
    const lines = [line('a', 100n), line('b', 200n), line('c', 300n)];
    const a = ok(allocatePayment(bdt(60n), lines, { mode: 'proportional' }));

    const total = a.reduce((s, x) => s + x.amountMinor.minor, 0n);
    expect(total).toBe(60n);
    // Roughly 1:2:3 — exact split is the property test's job, this just
    // pins the shape so a regression here is legible without recomputing it.
    const byId = Object.fromEntries(a.map((x) => [x.invoiceLineId, x.amountMinor.minor]));
    expect(byId['a']).toBe(10n);
    expect(byId['b']).toBe(20n);
    expect(byId['c']).toBe(30n);
  });

  it('manual: the collector chooses exactly, and it must add up', () => {
    const lines = [line('a', 1000n), line('b', 1000n)];
    const a = ok(
      allocatePayment(bdt(700n), lines, {
        mode: 'manual',
        lines: [
          { invoiceLineId: 'a', amountMinor: bdt(300n) },
          { invoiceLineId: 'b', amountMinor: bdt(400n) },
        ],
      }),
    );
    expect(a).toEqual([
      { invoiceLineId: 'a', amountMinor: bdt(300n) },
      { invoiceLineId: 'b', amountMinor: bdt(400n) },
    ]);
  });

  it('refuses a payment larger than every named line can absorb', () => {
    const lines = [line('a', 100n)];
    const v = allocatePayment(bdt(150n), lines, { mode: 'oldest_first' });
    expect(v).toEqual({ kind: 'exceeds_outstanding', excessMinor: bdt(50n) });
  });

  it('manual refuses a line this call was never told is outstanding', () => {
    const v = allocatePayment(bdt(100n), [line('a', 100n)], {
      mode: 'manual',
      lines: [{ invoiceLineId: 'not-a-real-line', amountMinor: bdt(100n) }],
    });
    expect(v).toEqual({ kind: 'unknown_invoice_line', invoiceLineId: 'not-a-real-line' });
  });

  it('manual refuses a breakdown that overshoots one line even if the total matches', () => {
    // ৳100 total is right, but it is placed wrong: `a` only owes ৳50.
    const v = allocatePayment(bdt(100n), [line('a', 50n), line('b', 100n)], {
      mode: 'manual',
      lines: [
        { invoiceLineId: 'a', amountMinor: bdt(60n) },
        { invoiceLineId: 'b', amountMinor: bdt(40n) },
      ],
    });
    expect(v).toEqual({ kind: 'exceeds_outstanding', excessMinor: bdt(10n) });
  });

  it('manual refuses a breakdown that does not sum to the payment', () => {
    const v = allocatePayment(bdt(100n), [line('a', 100n), line('b', 100n)], {
      mode: 'manual',
      lines: [{ invoiceLineId: 'a', amountMinor: bdt(60n) }], // only ৳60 of ৳100 named
    });
    expect(v.kind).toBe('manual_incomplete');
  });

  it('an already-settled line (zero outstanding) is skipped, not zero-allocated', () => {
    const lines = [line('paid', 0n), line('owing', 500n)];
    const a = ok(allocatePayment(bdt(200n), lines, { mode: 'oldest_first' }));
    expect(a).toEqual([{ invoiceLineId: 'owing', amountMinor: bdt(200n) }]);
  });

  it('a zero payment allocates nothing, to nobody, without error', () => {
    const lines = [line('a', 500n)];
    expect(ok(allocatePayment(Money.zero(), lines, { mode: 'oldest_first' }))).toEqual([]);
    expect(ok(allocatePayment(Money.zero(), lines, { mode: 'proportional' }))).toEqual([]);
  });
});

// ── property tests ──────────────────────────────────────────────────────────
//
// No fast-check in this codebase yet (nothing else here does property-based
// testing), so this is a small hand-rolled generator instead of a new
// dependency for one file. A fixed seed keeps a failure reproducible — a
// property test that fails differently on every CI run is one nobody trusts
// enough to act on.

/** `JSON.stringify` cannot serialise a bigint; every failure message needs a
 *  case description that can. */
function describeCase(c: Case): string {
  return JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
}

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

interface Case {
  amountMinor: bigint;
  lines: OutstandingLine[];
}

function randomCase(rand: () => number): Case {
  const lineCount = 1 + Math.floor(rand() * 6);
  const lines: OutstandingLine[] = [];
  let total = 0n;
  for (let i = 0; i < lineCount; i++) {
    const outstanding = BigInt(Math.floor(rand() * 100_000));
    lines.push(line(`line-${i}`, outstanding));
    total += outstanding;
  }
  // Payment is always <= total outstanding here — the exceeds_outstanding
  // path is covered by its own dedicated example above, not by this
  // generator, so every case below is expected to reach 'ok'.
  const amountMinor = total === 0n ? 0n : BigInt(Math.floor(rand() * Number(total)));
  return { amountMinor, lines };
}

const POLICIES = [
  { mode: 'oldest_first' as const },
  { mode: 'head_priority' as const },
  { mode: 'proportional' as const },
];

const CASES = 300;

describe('allocatePayment — properties (oldest_first, head_priority, proportional)', () => {
  for (const policy of POLICIES) {
    describe(policy.mode, () => {
      const rand = mulberry32(0xf1a2ce_00 + policy.mode.length);
      const cases = Array.from({ length: CASES }, () => randomCase(rand));

      it('is total-preserving: Σ allocations === the payment, for every generated case', () => {
        for (const c of cases) {
          const v = allocatePayment(bdt(c.amountMinor), c.lines, policy);
          expect(v.kind, describeCase(c)).toBe('ok');
          if (v.kind !== 'ok') continue;
          const sum = v.allocations.reduce((s, a) => s + a.amountMinor.minor, 0n);
          expect(sum, describeCase(c)).toBe(c.amountMinor);
        }
      });

      it('never allocates more than a line actually owes', () => {
        for (const c of cases) {
          const v = allocatePayment(bdt(c.amountMinor), c.lines, policy);
          if (v.kind !== 'ok') continue;
          const cap = new Map(c.lines.map((l) => [l.invoiceLineId, l.outstandingMinor.minor]));
          for (const a of v.allocations) {
            expect(a.amountMinor.minor, describeCase(c)).toBeLessThanOrEqual(
              cap.get(a.invoiceLineId)!,
            );
          }
        }
      });

      it('never produces a negative or zero allocation', () => {
        for (const c of cases) {
          const v = allocatePayment(bdt(c.amountMinor), c.lines, policy);
          if (v.kind !== 'ok') continue;
          for (const a of v.allocations) {
            expect(a.amountMinor.minor, describeCase(c)).toBeGreaterThan(0n);
          }
        }
      });

      it('is deterministic: the same case allocated twice gives the same result', () => {
        for (const c of cases) {
          const first = allocatePayment(bdt(c.amountMinor), c.lines, policy);
          const second = allocatePayment(bdt(c.amountMinor), c.lines, policy);
          expect(second).toEqual(first);
        }
      });
    });
  }
});
