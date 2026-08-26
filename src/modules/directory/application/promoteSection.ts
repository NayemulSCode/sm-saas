/**
 * Bulk promotion, and its undo. §14.5, FR-4.6.
 *
 * "The riskiest bulk operation in the product — it rewrites a whole cohort's
 * enrolment. It runs as a chunked job with a recorded batch id and a
 * compensating action, so 'undo the promotion, we ran it on the wrong section'
 * is a supported operation rather than a restore."
 *
 * The batch id and the compensating action are here. CHUNKING IS NOT: a section
 * is at most a few dozen students, one transaction handles it comfortably, and
 * a job runner would add a failure mode (half-promoted, worker died) that the
 * single transaction does not have. When a school promotes a whole year group
 * in one action, this becomes a pg-boss job over the same use case.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate, systemClock, type Clock } from '../../../shared/date';
import type { AcademicYearId, SectionId, StudentId } from '../../../shared/ids';
import { buildPromotionPlan, statusForExit, type Outcome } from '../domain/promotion';
import { dateColumnFor } from '../domain/studentStatus';
import { directory } from '../infrastructure/repositories';

export const PromotionErrors = defineErrors({
  SECTION_EMPTY: {
    code: 'SECTION_EMPTY',
    messageKey: 'directory.error.sectionEmpty',
    httpStatus: 409,
  },
  UNKNOWN_EXCEPTION: {
    code: 'UNKNOWN_EXCEPTION',
    messageKey: 'directory.error.unknownException',
    httpStatus: 400,
  },
  SAME_YEAR: {
    code: 'SAME_YEAR',
    messageKey: 'directory.error.sameYear',
    httpStatus: 400,
  },
  BATCH_NOT_FOUND: {
    code: 'BATCH_NOT_FOUND',
    messageKey: 'directory.error.batchNotFound',
    httpStatus: 404,
  },
  BATCH_ALREADY_UNDONE: {
    code: 'BATCH_ALREADY_UNDONE',
    messageKey: 'directory.error.batchAlreadyUndone',
    httpStatus: 409,
  },
});

export interface PromoteSectionInput {
  sourceSectionId: SectionId;
  fromYearId: AcademicYearId;
  toYearId: AcademicYearId;
  /** Where promoted students go. */
  targetSectionId: SectionId;
  /** Where retained students stay. Defaults to the source section. */
  retainSectionId?: SectionId | undefined;
  defaultOutcome?: 'promoted' | 'retained' | undefined;
  /** studentId → outcome. Everyone else gets `defaultOutcome`. */
  exceptions?: Readonly<Record<string, Outcome>> | undefined;
  reason: string;
}

export interface PromoteSectionResult {
  batchId: string;
  counts: Record<Outcome, number>;
  enrolled: number;
}

export async function promoteSection(
  ctx: AuthContext,
  input: PromoteSectionInput,
  deps: { clock?: Clock } = {},
): Promise<Result<PromoteSectionResult, DomainError>> {
  authorize(ctx, 'enrolment.promote');

  if (input.fromYearId === input.toYearId) return err(PromotionErrors.SAME_YEAR);

  const today = LocalDate.today(deps.clock ?? systemClock);

  return withTenant(ctx, async (tx) => {
    const candidates = await directory.candidatesIn(tx, input.sourceSectionId, input.fromYearId);

    const verdict = buildPromotionPlan({
      candidates,
      targetSectionId: input.targetSectionId,
      retainSectionId: input.retainSectionId ?? input.sourceSectionId,
      defaultOutcome: input.defaultOutcome ?? 'promoted',
      exceptions: input.exceptions ?? {},
    });

    switch (verdict.kind) {
      case 'empty':
        return err(PromotionErrors.SECTION_EMPTY);
      case 'unknown_students':
        return err(PromotionErrors.UNKNOWN_EXCEPTION);
      case 'ok':
        break;
    }

    const { plan } = verdict;

    const batchId = await directory.createBatch(tx, {
      sourceSectionId: input.sourceSectionId,
      fromYearId: input.fromYearId,
      toYearId: input.toYearId,
      counts: plan.counts,
      actorId: ctx.personId,
    });

    for (const entry of plan.entries) {
      await directory.createEnrolment(tx, {
        studentId: entry.studentId as StudentId,
        sectionId: entry.sectionId as SectionId,
        academicYearId: input.toYearId,
        rollNo: entry.rollNo,
        enrolledOn: today,
        promotionBatchId: batchId,
        actorId: ctx.personId,
      });

      await directory.setOutcomes(tx, [entry.sourceEnrolmentId], entry.outcome, today, ctx.personId);
    }

    for (const exit of plan.exits) {
      await directory.setOutcomes(tx, [exit.sourceEnrolmentId], exit.outcome, today, ctx.personId);

      /*
       * A leaver's lifecycle changes too. Both a transfer out and a withdrawal
       * mean the child stops attending; the enrolment outcome is what records
       * which of the two it was.
       */
      const to = statusForExit(exit.outcome);
      await directory.setStatus(
        tx,
        exit.studentId as StudentId,
        to,
        dateColumnFor(to),
        today,
        ctx.personId,
      );
      await directory.recordStatusEvent(tx, {
        studentId: exit.studentId as StudentId,
        from: null,
        to,
        reason: `${exit.outcome} during promotion: ${input.reason}`,
        effectiveDate: today,
        actorId: ctx.personId,
      });
    }

    await audit(tx, ctx, 'enrolment.promoted', batchId, {
      entityType: 'promotionBatch',
      reason: input.reason,
      after: {
        batchId,
        sourceSectionId: input.sourceSectionId,
        targetSectionId: input.targetSectionId,
        fromYearId: input.fromYearId,
        toYearId: input.toYearId,
        promoted: fact(plan.counts.promoted),
        retained: fact(plan.counts.retained),
        transferred: fact(plan.counts.transferred),
        withdrawn: fact(plan.counts.withdrawn),
        // Stated so the audit row cannot be read as a settlement. Arrears carry
        // forward through finance, which reads enrolment history.
        duesTouched: false,
      },
    });

    return ok({ batchId, counts: plan.counts, enrolled: plan.entries.length });
  });
}

/**
 * The compensating action. "Undo the promotion, we ran it on the wrong section."
 *
 * Removes exactly the enrolments THIS batch created — found by
 * `promotion_batch_id`, never by (section, year), because deriving them would
 * also catch students enrolled by hand afterwards and removing those is the
 * accident undo exists to avoid.
 *
 * Soft-deletes, because nothing is hard-deleted (non-negotiable 1). It does not
 * restore a withdrawn leaver's previous status: reversing a lifecycle event
 * needs its own decision and its own reason, and guessing would silently
 * reinstate a child whose family had genuinely left.
 */
export async function undoPromotion(
  ctx: AuthContext,
  input: { batchId: string; reason: string },
): Promise<Result<{ removed: number; restored: number }, DomainError>> {
  authorize(ctx, 'enrolment.promote');

  return withTenant(ctx, async (tx) => {
    const batch = await directory.batchById(tx, input.batchId);
    if (!batch) return err(PromotionErrors.BATCH_NOT_FOUND);
    if (batch.undoneAt !== null) return err(PromotionErrors.BATCH_ALREADY_UNDONE);

    const created = await directory.enrolmentsFromBatch(tx, input.batchId);
    const removed = await directory.softDeleteEnrolments(
      tx,
      created.map((e) => e.id),
      input.reason,
      ctx.personId,
    );

    // The source enrolments go back to having no outcome, so the cohort can be
    // promoted again once the right section is chosen.
    const restored = await directory.clearOutcomesFor(
      tx,
      created.map((e) => e.studentId),
      batch.fromYearId,
      ctx.personId,
    );

    await directory.markBatchUndone(tx, input.batchId, input.reason, ctx.personId);

    await audit(tx, ctx, 'enrolment.promotionUndone', input.batchId, {
      entityType: 'promotionBatch',
      reason: input.reason,
      after: { batchId: input.batchId, removed: fact(removed), restored: fact(restored) },
    });

    return ok({ removed, restored });
  });
}
