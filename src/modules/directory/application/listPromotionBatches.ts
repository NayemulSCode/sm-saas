/**
 * The recent promotion runs, so undo outlives the screen that promoted.
 *
 * §14.5 makes "undo the promotion, we ran it on the wrong section" a supported
 * operation rather than a restore. That promise is only kept if the batch can
 * still be FOUND — the mistake is realised minutes later, by somebody who has
 * already closed the tab, and often by a different person from the one who ran
 * it.
 *
 * Read-only and deliberately small: the last few runs, newest first. This is
 * not a history report, it is the list of things that can still be taken back.
 */

import { withTenantReadonly } from '../../../db/rls';
import { type Result, ok, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { directory } from '../infrastructure/repositories';

export interface PromotionBatchRow {
  id: string;
  sourceSectionId: string;
  /** Null when the section or year has since been removed. */
  sectionNameEn: string | null;
  className: string | null;
  fromYearName: string | null;
  toYearName: string | null;
  promoted: number;
  retained: number;
  transferred: number;
  withdrawn: number;
  /** Non-null once taken back. Undoing twice is a 409, not a second undo. */
  undoneAt: string | null;
  undoReason: string | null;
  at: string;
}

export async function listPromotionBatches(
  ctx: AuthContext,
  input: { limit?: number | undefined } = {},
): Promise<Result<PromotionBatchRow[], DomainError>> {
  /*
   * `enrolment.promote`, not `student.read`. The only thing this list is for is
   * deciding what to undo, and undoing is what it guards — showing it to
   * somebody who cannot act on it is an invitation to ask a colleague to.
   */
  authorize(ctx, 'enrolment.promote');

  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

  return withTenantReadonly(ctx, async (tx) => {
    const rows = await directory.recentBatches(tx, limit);

    return ok(
      rows.map((r) => ({
        id: r.id,
        sourceSectionId: r.sourceSectionId,
        sectionNameEn: r.sectionNameEn,
        className: r.className,
        fromYearName: r.fromYearName,
        toYearName: r.toYearName,
        promoted: r.promoted,
        retained: r.retained,
        transferred: r.transferred,
        withdrawn: r.withdrawn,
        undoneAt: r.undoneAt === null ? null : r.undoneAt.toISOString(),
        undoReason: r.undoReason,
        at: r.createdAt.toISOString(),
      })),
    );
  });
}
