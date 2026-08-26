/**
 * Class level ordering. §14.4.
 *
 * `sequence` is promotion order — it is what "the next class up" means — so
 * reordering is not cosmetic. Getting it wrong sends a whole cohort to the
 * wrong class next January.
 */

export interface ExistingLevel {
  id: string;
  nameEn: string;
  sequence: number;
}

export type ReorderVerdict =
  | { kind: 'ok'; changes: ReadonlyArray<{ id: string; sequence: number }> }
  /** The request names an id the school does not have. */
  | { kind: 'unknown'; ids: readonly string[] }
  /** The request omits a level. A partial reorder has no defined meaning. */
  | { kind: 'incomplete'; missing: readonly string[] }
  | { kind: 'duplicate_id'; ids: readonly string[] }
  | { kind: 'no_change' };

/**
 * The spacing between generated sequences.
 *
 * Levels are numbered 10, 20, 30 … rather than 1, 2, 3, so that inserting
 * 'Pre-Nursery' between two existing rungs is one row rather than a renumber of
 * everything below it. A reorder re-spaces from scratch, which repairs a
 * previously squeezed ordering as a side effect.
 */
export const SEQUENCE_STEP = 10;

/**
 * Turns an ordered list of ids into the sequence numbers to write.
 *
 * The request is the COMPLETE order, not a diff. A partial reorder — "move this
 * one to the top" — has no defined meaning when two clients send overlapping
 * partial moves, and reconciling them silently is how a cohort ends up in the
 * wrong class.
 */
export function evaluateReorder(
  existing: readonly ExistingLevel[],
  orderedIds: readonly string[],
): ReorderVerdict {
  const seen = new Set<string>();
  const duplicates = orderedIds.filter((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
  if (duplicates.length > 0) return { kind: 'duplicate_id', ids: [...new Set(duplicates)] };

  const known = new Set(existing.map((l) => l.id));
  const unknown = orderedIds.filter((id) => !known.has(id));
  if (unknown.length > 0) return { kind: 'unknown', ids: unknown };

  const missing = existing.filter((l) => !seen.has(l.id)).map((l) => l.id);
  if (missing.length > 0) return { kind: 'incomplete', missing };

  const current = new Map(existing.map((l) => [l.id, l.sequence]));
  const changes = orderedIds
    .map((id, i) => ({ id, sequence: (i + 1) * SEQUENCE_STEP }))
    .filter((c) => current.get(c.id) !== c.sequence);

  if (changes.length === 0) return { kind: 'no_change' };
  return { kind: 'ok', changes };
}

/**
 * Where a new level goes when the caller does not say.
 *
 * The end, not the beginning. A school adding a class is almost always
 * extending upward — adding Class 9 to a school that stopped at 8 — and putting
 * it at the top would silently demote every existing class by one rung.
 */
export function nextSequence(existing: readonly ExistingLevel[]): number {
  if (existing.length === 0) return SEQUENCE_STEP;
  return Math.max(...existing.map((l) => l.sequence)) + SEQUENCE_STEP;
}
