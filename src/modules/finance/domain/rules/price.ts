/**
 * What one student owes for one invoicing period, before it becomes rows.
 * §13.6: `heads = fee_structure(class, section) ∪ fee_assignment overrides`,
 * `applied = approved discounts valid on period start`.
 *
 * PURE — no IO, same discipline as `rules/allocate.ts`. The use case resolves
 * which `fee_structure`/`fee_assignment`/`discount` rows are in scope for one
 * student (a database concern); this decides what they add up to (a money
 * concern), so the arithmetic is unit-testable without a database.
 */

import { Money } from '../../../../shared/money';

export interface StructureLine {
  readonly feeHeadId: string;
  readonly amountMinor: Money;
  /** A section-scoped row beats a class-scoped row for the SAME head — a
   *  special-programme section paying extra on top of the class default. */
  readonly scope: 'class' | 'section';
}

/** Per-student override. Replaces the structure amount for this head
 *  entirely — including introducing a head the structure never priced. */
export interface AssignmentOverride {
  readonly feeHeadId: string;
  readonly amountMinor: Money;
}

export interface ApplicableDiscount {
  /** `null` applies to every head. */
  readonly feeHeadId: string | null;
  /** Exactly one of these is set — same rule `discount`'s own CHECK enforces. */
  readonly valueMinor: Money | null;
  /** `numeric(5,2)` as it comes back from the database, e.g. `"12.50"`. */
  readonly percent: string | null;
}

export interface PricedHead {
  readonly feeHeadId: string;
  readonly amountMinor: Money;
  /** Never exceeds `amountMinor` — a discount cannot make a line negative. */
  readonly discountMinor: Money;
}

/**
 * `"12.50"` → 1250/10000. Two steps folded into one fraction: the string's
 * own two decimal places, and dividing by 100 to turn a percentage into a
 * ratio. `Money.mulRatio` takes it from there with banker's rounding — the
 * same reasoning `allocate.ts` gives for reusing `shared/money.ts` rather
 * than reimplementing a rounding rule at a second call site.
 */
function percentToFraction(percent: string): { numerator: bigint; denominator: bigint } {
  const [whole = '0', frac = ''] = percent.split('.');
  const paddedFrac = (frac + '00').slice(0, 2);
  const scaled = BigInt(whole) * 100n + BigInt(paddedFrac);
  return { numerator: scaled, denominator: 10_000n };
}

function discountAmount(gross: Money, d: ApplicableDiscount): Money {
  if (d.valueMinor !== null) return d.valueMinor;
  const { numerator, denominator } = percentToFraction(d.percent!);
  return Money.mulRatio(gross, numerator, denominator);
}

export function priceStudentFees(
  structureLines: readonly StructureLine[],
  overrides: readonly AssignmentOverride[],
  discounts: readonly ApplicableDiscount[],
): PricedHead[] {
  const gross = new Map<string, Money>();

  // Class-scoped first, section-scoped second — a later write for the same
  // key wins, which is exactly "section beats class".
  for (const line of structureLines) {
    if (line.scope === 'class') gross.set(line.feeHeadId, line.amountMinor);
  }
  for (const line of structureLines) {
    if (line.scope === 'section') gross.set(line.feeHeadId, line.amountMinor);
  }

  // Assignments beat structure entirely, and may introduce a head the
  // structure never priced (§13.1: "Per-student override. Beats fee_structure.").
  for (const o of overrides) gross.set(o.feeHeadId, o.amountMinor);

  const priced: PricedHead[] = [];
  for (const [feeHeadId, amountMinor] of gross) {
    const applicable = discounts.filter((d) => d.feeHeadId === null || d.feeHeadId === feeHeadId);

    let discountMinor = Money.zero(amountMinor.currency);
    for (const d of applicable) {
      discountMinor = Money.add(discountMinor, discountAmount(amountMinor, d));
    }
    // Several discounts can stack (e.g. a sibling discount plus a merit
    // discount) but never past what the line is actually worth — the same
    // "refused rather than silently invented" posture `allocatePayment`
    // takes with an overpayment, applied here to an over-discount instead.
    discountMinor = Money.min(discountMinor, amountMinor);

    priced.push({ feeHeadId, amountMinor, discountMinor });
  }

  // Deterministic order — the caller does not have to sort, and a test
  // asserting on the shape does not depend on Map iteration happening to
  // match insertion order.
  return priced.sort((a, b) => (a.feeHeadId < b.feeHeadId ? -1 : a.feeHeadId > b.feeHeadId ? 1 : 0));
}
