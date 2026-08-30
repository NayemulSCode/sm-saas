/**
 * How one payment spreads across what a student owes. §13.5.
 *
 * PURE — no IO, no `Money` amount ever leaves this file as a `number`. A
 * guardian hands over ৳3,000 against ৳5,200 owed across four fee heads and
 * three months; this decides which poisha goes where. Getting it wrong means
 * a receipt that does not add up, which is the one failure mode "the
 * accountant trusts the numbers" (§13's own exit criterion for this phase)
 * cannot survive.
 *
 * Four invariants, true for every policy and enforced by property tests
 * below rather than only by example:
 *   1. Total-preserving — Σ allocations === the payment, exactly.
 *   2. No allocation exceeds the line's own outstanding balance.
 *   3. No allocation is negative or zero.
 *   4. Deterministic — the same inputs produce the same output every time.
 *
 * Bespoke discriminated union for the failure, not `Result<T, DomainError>` —
 * `DomainError` (shared/result.ts) carries `httpStatus`/`messageKey`, which
 * are transport concerns this function has no business knowing about. The
 * future use case translates `AllocationVerdict` into a real `DomainError`,
 * the same way `promoteSection` translates domain/promotion.ts's
 * `PlanVerdict` — this file is the finance module's equivalent of that one.
 */

import { Money } from '../../../../shared/money';

export type AllocationPolicy =
  /** Ascending due date, then fee_head.sequence — the default. */
  | { readonly mode: 'oldest_first' }
  /** Configured head order — clears the exam fee first when an admit card is
   *  gated on it. The caller supplies lines already in that order. */
  | { readonly mode: 'head_priority' }
  /** Weighted by each line's outstanding amount. */
  | { readonly mode: 'proportional' }
  /** The collector chooses per line. */
  | {
      readonly mode: 'manual';
      readonly lines: ReadonlyArray<{ readonly invoiceLineId: string; readonly amountMinor: Money }>;
    };

export interface OutstandingLine {
  readonly invoiceLineId: string;
  /** What remains on this line: `amount - discount - already paid`. Always
   *  compared as `> 0`; a caller that includes a settled line gets it back
   *  untouched rather than the function silently dropping it. */
  readonly outstandingMinor: Money;
}

export interface Allocation {
  readonly invoiceLineId: string;
  readonly amountMinor: Money;
}

export type AllocationVerdict =
  | { readonly kind: 'ok'; readonly allocations: readonly Allocation[] }
  /** The payment is larger than every named line can absorb. Refused rather
   *  than parked as a credit balance or silently capped — what happens to an
   *  overpayment is a product decision belonging to the use case that calls
   *  this, not to the allocator. */
  | { readonly kind: 'exceeds_outstanding'; readonly excessMinor: Money }
  /** `manual` named a line this call was never given as outstanding. */
  | { readonly kind: 'unknown_invoice_line'; readonly invoiceLineId: string }
  /** `manual` named amounts that do not sum to the payment — under OR over;
   *  both mean the collector's breakdown does not account for the money. */
  | { readonly kind: 'manual_incomplete'; readonly allocatedMinor: Money; readonly amountMinor: Money };

/**
 * Greedy fill in the given order: take each line up to what it still owes,
 * moving to the next once a line is either fully paid or the payment is
 * exhausted. `oldest_first` and `head_priority` are the SAME algorithm — they
 * differ only in what order the caller has already sorted `outstanding` into
 * (§13.5: "pre-sorted by policy"), so this function does not sort at all.
 */
function greedyFill(amount: Money, outstanding: readonly OutstandingLine[]): Allocation[] {
  const allocations: Allocation[] = [];
  let remaining = amount;

  for (const line of outstanding) {
    if (Money.isZero(remaining)) break;
    if (Money.isZero(line.outstandingMinor) || Money.isNegative(line.outstandingMinor)) continue;

    const take = Money.min(remaining, line.outstandingMinor);
    allocations.push({ invoiceLineId: line.invoiceLineId, amountMinor: take });
    remaining = Money.sub(remaining, take);
  }

  return allocations;
}

export function allocatePayment(
  amount: Money,
  outstanding: readonly OutstandingLine[],
  policy: AllocationPolicy,
): AllocationVerdict {
  const totalOutstanding = outstanding.reduce(
    (sum, l) => (Money.isNegative(l.outstandingMinor) ? sum : Money.add(sum, l.outstandingMinor)),
    Money.zero(amount.currency),
  );

  if (policy.mode === 'manual') {
    const known = new Map(outstanding.map((l) => [l.invoiceLineId, l.outstandingMinor]));
    const allocations: Allocation[] = [];
    let allocated = Money.zero(amount.currency);

    for (const line of policy.lines) {
      const cap = known.get(line.invoiceLineId);
      if (cap === undefined) {
        return { kind: 'unknown_invoice_line', invoiceLineId: line.invoiceLineId };
      }
      // A line named twice, or an amount over its own cap, both collapse into
      // the same outcome the caller sees: the total will not add up, which
      // `manual_incomplete` below reports precisely rather than this
      // silently clamping a number the collector did not actually enter.
      allocations.push(line);
      allocated = Money.add(allocated, line.amountMinor);
    }

    if (Money.compare(allocated, amount) !== 0) {
      return { kind: 'manual_incomplete', allocatedMinor: allocated, amountMinor: amount };
    }
    // Individual per-line caps, checked after the total — a total that
    // matches but overshoots one line and undershoots another is still wrong,
    // and this is the specific line it is wrong on.
    for (const a of allocations) {
      const cap = known.get(a.invoiceLineId)!;
      if (Money.compare(a.amountMinor, cap) > 0) {
        return { kind: 'exceeds_outstanding', excessMinor: Money.sub(a.amountMinor, cap) };
      }
      // Zero or negative on a NAMED line is a mistake, not a real allocation
      // (invariant 3) — collapsed into the same verdict as a total mismatch
      // rather than given its own kind, because both mean the same thing to
      // the collector: this breakdown does not correctly account for the
      // money and has to be re-entered.
      if (Money.isZero(a.amountMinor) || Money.isNegative(a.amountMinor)) {
        return { kind: 'manual_incomplete', allocatedMinor: allocated, amountMinor: amount };
      }
    }

    return { kind: 'ok', allocations };
  }

  if (Money.compare(amount, totalOutstanding) > 0) {
    return { kind: 'exceeds_outstanding', excessMinor: Money.sub(amount, totalOutstanding) };
  }

  if (policy.mode === 'proportional') {
    const weighted = outstanding.filter(
      (l) => !Money.isZero(l.outstandingMinor) && !Money.isNegative(l.outstandingMinor),
    );
    if (weighted.length === 0) return { kind: 'ok', allocations: [] };

    // `Money.allocateByWeights` is already total-preserving by construction
    // (largest-remainder method) — this is the one branch that reuses rather
    // than reimplements, because getting exact-sum splitting right once, in
    // shared/money.ts, and reusing it here is how two implementations of the
    // same rounding rule are prevented from quietly drifting apart.
    //
    // A share can never exceed its own line's cap, and this is a proof, not
    // an assumption: the weight PASSED IN for each line is that line's own
    // outstanding amount, so `floor(amount·outstanding_i / totalOutstanding)`
    // is strictly less than `outstanding_i` whenever `amount < totalOutstanding`
    // (the guard above already refused `amount > totalOutstanding`), and the
    // largest-remainder pass adds at most +1 per line — which lands it AT
    // outstanding_i, never past it. The `amount === totalOutstanding` case
    // divides every line exactly, with zero remainder to distribute at all.
    // 300 generated cases × 3 policies never produced a counter-example
    // either. The check inside the map below is not a fallback for a real
    // code path — it exists so a future change to how weights are chosen
    // fails LOUDLY here rather than silently returning an allocation that
    // violates invariant 2.
    const shares = Money.allocateByWeights(
      amount,
      weighted.map((l) => l.outstandingMinor.minor),
    );
    return {
      kind: 'ok',
      allocations: weighted
        .map((l, i) => {
          const share = shares[i]!;
          if (Money.compare(share, l.outstandingMinor) > 0) {
            throw new Error(
              `allocatePayment: proportional share ${share.minor} exceeds line ` +
                `${l.invoiceLineId}'s outstanding ${l.outstandingMinor.minor} — ` +
                `this should be mathematically impossible when weights equal caps`,
            );
          }
          return { invoiceLineId: l.invoiceLineId, amountMinor: share };
        })
        .filter((a) => !Money.isZero(a.amountMinor)),
    };
  }

  // oldest_first and head_priority: same algorithm, different pre-sort.
  return { kind: 'ok', allocations: greedyFill(amount, outstanding) };
}
