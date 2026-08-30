/**
 * Payment allocation. §13.5.
 *
 * Pure — no IO, no clock, no database. Given a payment amount, the lines it
 * could apply to, and how the collector wants it split, decides exactly how
 * many poisha go where. This is where "does the maths add up" is proven in a
 * unit test rather than discovered in an accountant's reconciliation.
 *
 * ASSUMES the caller already validated `amount` is positive — that is a DTO
 * concern (the database CHECK, and `payment.amount_minor > 0`), not this
 * function's. This function's only job is the distribution problem.
 */

import { Money } from '../../../shared/money';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import type { InvoiceLineId } from '../../../shared/ids';

export const AllocationErrors = defineErrors({
  ALLOCATION_EXCEEDS_OUTSTANDING: {
    code: 'ALLOCATION_EXCEEDS_OUTSTANDING',
    messageKey: 'finance.error.allocationExceedsOutstanding',
    httpStatus: 422,
  },
  ALLOCATION_MISMATCH: {
    code: 'ALLOCATION_MISMATCH',
    messageKey: 'finance.error.allocationMismatch',
    httpStatus: 422,
  },
  UNKNOWN_LINE: {
    code: 'UNKNOWN_LINE',
    messageKey: 'finance.error.unknownLine',
    httpStatus: 422,
  },
});

/** A line the payment could apply to, as much as allocation needs to know. */
export interface OutstandingLine {
  invoiceLineId: InvoiceLineId;
  dueDate: string;
  /** `fee_head.sequence` — the school's configured head order (§13.1). */
  feeHeadSequence: number;
  outstanding: Money;
}

export type AllocationPolicy = 'oldest_first' | 'head_priority' | 'proportional';

export type AllocationRequest =
  | { mode: 'auto'; policy: AllocationPolicy }
  | {
      mode: 'manual';
      /** The collector's own split — validated, never recomputed. */
      lines: ReadonlyArray<{ invoiceLineId: InvoiceLineId; amount: Money }>;
    };

export interface Allocation {
  invoiceLineId: InvoiceLineId;
  amount: Money;
}

function totalOutstanding(lines: readonly OutstandingLine[]): Money {
  return lines.reduce((sum, l) => Money.add(sum, l.outstanding), Money.zero());
}

function sortFor(policy: AllocationPolicy, lines: readonly OutstandingLine[]): OutstandingLine[] {
  const copy = [...lines];
  switch (policy) {
    case 'oldest_first':
      return copy.sort(
        (a, b) => a.dueDate.localeCompare(b.dueDate) || a.feeHeadSequence - b.feeHeadSequence,
      );
    case 'head_priority':
      return copy.sort(
        (a, b) => a.feeHeadSequence - b.feeHeadSequence || a.dueDate.localeCompare(b.dueDate),
      );
    case 'proportional':
      // Ordering does not matter for proportional — allocateByWeights takes
      // the whole set at once. Kept stable (input order) for a deterministic
      // largest-remainder tie-break.
      return copy;
  }
}

/** `oldest_first` / `head_priority`: greedily fill lines in the given order. */
function greedyAllocate(amount: Money, ordered: readonly OutstandingLine[]): Allocation[] {
  const out: Allocation[] = [];
  let remaining = amount;
  for (const line of ordered) {
    if (Money.isZero(remaining)) break;
    const take = Money.min(remaining, line.outstanding);
    if (!Money.isZero(take)) out.push({ invoiceLineId: line.invoiceLineId, amount: take });
    remaining = Money.sub(remaining, take);
  }
  return out;
}

function proportionalAllocate(amount: Money, lines: readonly OutstandingLine[]): Allocation[] {
  const weights = lines.map((l) => l.outstanding.minor);
  const shares = Money.allocateByWeights(amount, weights);
  return lines
    .map((l, i) => ({ invoiceLineId: l.invoiceLineId, amount: shares[i]! }))
    .filter((a) => !Money.isZero(a.amount));
}

type ManualLines = Extract<AllocationRequest, { mode: 'manual' }>['lines'];

function validateManual(
  amount: Money,
  outstanding: readonly OutstandingLine[],
  manualLines: ManualLines,
): Result<Allocation[], DomainError> {
  const byId = new Map(outstanding.map((l) => [l.invoiceLineId, l]));
  let sum = Money.zero(amount.currency);

  for (const line of manualLines) {
    const target = byId.get(line.invoiceLineId);
    if (!target) return err(AllocationErrors.UNKNOWN_LINE);
    if (Money.compare(line.amount, target.outstanding) > 0) {
      return err(AllocationErrors.ALLOCATION_EXCEEDS_OUTSTANDING);
    }
    sum = Money.add(sum, line.amount);
  }

  if (Money.compare(sum, amount) !== 0) return err(AllocationErrors.ALLOCATION_MISMATCH);

  return ok(manualLines.map((l) => ({ invoiceLineId: l.invoiceLineId, amount: l.amount })));
}

/**
 * Total-preserving: on success, Σ allocations === amount, exactly — always,
 * for every policy. `proportional` goes through `Money.allocateByWeights`
 * (largest-remainder), which is what makes that promise hold even when the
 * amount does not divide evenly across the weights.
 *
 * Overpayment (amount exceeds everything outstanding) is refused rather than
 * silently created as a credit balance — there is nowhere in this slice's
 * schema for a credit to live yet. A named future feature, not a rounding
 * shortcut.
 */
export function allocatePayment(
  amount: Money,
  outstanding: readonly OutstandingLine[],
  request: AllocationRequest,
): Result<Allocation[], DomainError> {
  if (request.mode === 'manual') {
    return validateManual(amount, outstanding, request.lines);
  }

  if (Money.compare(amount, totalOutstanding(outstanding)) > 0) {
    return err(AllocationErrors.ALLOCATION_EXCEEDS_OUTSTANDING);
  }

  const ordered = sortFor(request.policy, outstanding);
  const allocations =
    request.policy === 'proportional' ? proportionalAllocate(amount, ordered) : greedyAllocate(amount, ordered);

  return ok(allocations);
}
