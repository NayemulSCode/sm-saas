/**
 * The merge review queue, and the record of merges already made.
 *
 * Merging is the most dangerous thing in the directory: get it wrong and two
 * children's records are fused. So the product's job is not to merge
 * automatically — it is to put a well-evidenced pair in front of a person who
 * knows the family, and to make the reversal findable afterwards.
 *
 * Nothing here decides anything. It proposes, with its reasons, and counts what
 * each side would carry so the reviewer can see the cost of being wrong.
 */

import { withTenantReadonly } from '../../../db/rls';
import { type Result, ok, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { Ids } from '../../../shared/ids';
import { directory } from '../infrastructure/repositories';

/** Why a pair was proposed. Shown to the reviewer, never acted on alone. */
export type Evidence = 'birth_reg_no' | 'name_and_dob' | 'name_and_phone';

export interface DuplicateSide {
  personId: string;
  nameBn: string;
  nameEn: string;
  phone: string | null;
  /** What would move if this side lost the merge. */
  students: number;
  guardianLinks: number;
  staff: number;
  memberships: number;
  /**
   * The children this record is a guardian of, and their own name if they are
   * a student. Two identical names with DIFFERENT children behind them is the
   * same guardian entered twice; the same child on both sides is one record
   * split in two. A count cannot tell those apart.
   */
  attachedTo: string[];
  at: string;
}

export interface DuplicatePair {
  evidence: Evidence;
  /** The OLDER record, offered as the one to keep — see `suggestedWinner`. */
  left: DuplicateSide;
  right: DuplicateSide;
  /**
   * Which side to keep, if the reviewer has no reason to think otherwise.
   *
   * The one with more attached to it, falling back to the older record. This is
   * a SUGGESTION on a screen, never a default the server applies: the winner is
   * whichever id the caller puts in the path, and this module does not choose
   * it for them.
   */
  suggestedWinner: 'left' | 'right';
}

export interface MergeRow {
  id: string;
  winnerPersonId: string;
  loserPersonId: string;
  winnerNameBn: string | null;
  winnerNameEn: string | null;
  loserNameBn: string | null;
  loserNameEn: string | null;
  moved: Record<string, string[]>;
  reason: string;
  reversedAt: string | null;
  reverseReason: string | null;
  at: string;
}

export async function reviewDuplicates(
  ctx: AuthContext,
  input: { limit?: number | undefined } = {},
): Promise<Result<DuplicatePair[], DomainError>> {
  // The permission that performs the merge, not a read permission. A queue of
  // proposed merges shown to somebody who cannot act on it is an invitation to
  // ask a colleague who can, which is how the reason gets lost.
  authorize(ctx, 'student.merge');

  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);

  return withTenantReadonly(ctx, async (tx) => {
    const pairs = await directory.duplicateCandidates(tx, limit);
    if (pairs.length === 0) return ok([]);

    const ids = [...new Set(pairs.flatMap((p) => [p.left_id, p.right_id]))];
    const [countRows, nameRows] = await Promise.all([
      directory.attachmentCounts(tx, ids),
      directory.attachmentNames(tx, ids),
    ]);
    const counts = new Map(countRows.map((c) => [c.person_id, c]));

    const names = new Map<string, string[]>();
    for (const r of nameRows) {
      const list = names.get(r.person_id) ?? [];
      list.push(r.role === 'self' ? `${r.name_bn} (this person)` : r.name_bn);
      names.set(r.person_id, list);
    }

    /*
     * Two conversions, both because this pair comes from RAW SQL: `tx.execute`
     * hands back what the driver gave it, not the mapped types the query
     * builder produces.
     *
     * The id is stored as a uuid and must go back out as a ULID — every other
     * endpoint publishes ULIDs, `zUlid()` rejects anything else, and an id from
     * this queue is meant to be posted straight to the merge endpoint. Publish
     * the uuid and the screen cannot act on its own output.
     *
     * `at` arrives as a string rather than a Date for the same reason.
     */
    const side = (
      id: string,
      nameBn: string,
      nameEn: string,
      phone: string | null,
      at: string | Date,
    ): DuplicateSide => {
      const c = counts.get(id);
      return {
        personId: Ids.fromUuid(id),
        nameBn,
        nameEn,
        phone,
        students: c?.students ?? 0,
        guardianLinks: c?.guardian_links ?? 0,
        staff: c?.staff ?? 0,
        memberships: c?.memberships ?? 0,
        attachedTo: names.get(id) ?? [],
        at: new Date(at).toISOString(),
      };
    };

    const weight = (d: DuplicateSide): number =>
      d.students + d.guardianLinks + d.staff + d.memberships;

    return ok(
      pairs.map((p) => {
        const left = side(
          p.left_id,
          p.left_name_bn,
          p.left_name_en,
          p.left_phone,
          p.left_created_at,
        );
        const right = side(
          p.right_id,
          p.right_name_bn,
          p.right_name_en,
          p.right_phone,
          p.right_created_at,
        );
        return {
          evidence: p.evidence as Evidence,
          left,
          right,
          // More attached wins; ties go to the older record, which `left`
          // already is — the query orders each pair by creation.
          suggestedWinner: weight(right) > weight(left) ? ('right' as const) : ('left' as const),
        };
      }),
    );
  });
}

/**
 * The merges already made, newest first — so a reversal is reachable by
 * somebody who was not the person who merged.
 */
export async function listMerges(
  ctx: AuthContext,
  input: { limit?: number | undefined } = {},
): Promise<Result<MergeRow[], DomainError>> {
  authorize(ctx, 'student.merge');

  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

  return withTenantReadonly(ctx, async (tx) => {
    const rows = await directory.recentMerges(tx, limit);

    return ok(
      rows.map((r) => ({
        id: r.id,
        winnerPersonId: r.winnerPersonId,
        loserPersonId: r.loserPersonId,
        winnerNameBn: r.winnerNameBn,
        winnerNameEn: r.winnerNameEn,
        loserNameBn: r.loserNameBn,
        loserNameEn: r.loserNameEn,
        moved: r.moved,
        reason: r.reason,
        reversedAt: r.reversedAt === null ? null : r.reversedAt.toISOString(),
        reverseReason: r.reverseReason,
        at: r.createdAt.toISOString(),
      })),
    );
  });
}
