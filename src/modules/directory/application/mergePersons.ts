/**
 * Merging two person records. §14.5.
 *
 * "Repoints every FK in one transaction; loser marked `merged_into`;
 * reversible."
 *
 * This happens because the same human was entered twice — a guardian who
 * registered two children a year apart, a returning student re-admitted as new,
 * a name spelled মোহাম্মদ once and মুহাম্মদ the next time. Left unmerged, the
 * family gets two SMS, misses their sibling discount, and appears twice on
 * every list.
 *
 * `student.merge` is a dangerous permission because getting it wrong fuses two
 * different children's records together. Hence: a reason, a full record of what
 * moved, and a reversal that puts back exactly those rows.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { PersonId } from '../../../shared/ids';
import { directory } from '../infrastructure/repositories';
import { AdmissionErrors } from './admitStudent';

export const MergeErrors = defineErrors({
  SAME_PERSON: {
    code: 'SAME_PERSON',
    messageKey: 'directory.error.samePerson',
    httpStatus: 400,
  },
  ALREADY_MERGED: {
    code: 'ALREADY_MERGED',
    messageKey: 'directory.error.alreadyMerged',
    httpStatus: 409,
  },
  MERGE_NOT_FOUND: {
    code: 'MERGE_NOT_FOUND',
    messageKey: 'directory.error.mergeNotFound',
    httpStatus: 404,
  },
  MERGE_ALREADY_REVERSED: {
    code: 'MERGE_ALREADY_REVERSED',
    messageKey: 'directory.error.mergeAlreadyReversed',
    httpStatus: 409,
  },
  /** Merging the actor's own person record would rewrite their own identity. */
  CANNOT_MERGE_SELF: {
    code: 'CANNOT_MERGE_SELF',
    messageKey: 'directory.error.cannotMergeSelf',
    httpStatus: 403,
  },
});

export interface MergePersonsInput {
  /** The record that survives. */
  winnerPersonId: PersonId;
  /** The duplicate, marked `merged_into` and left in place. */
  loserPersonId: PersonId;
  reason: string;
}

export async function mergePersons(
  ctx: AuthContext,
  input: MergePersonsInput,
): Promise<Result<{ mergeId: string; moved: Record<string, number> }, DomainError>> {
  authorize(ctx, 'student.merge');

  if (input.winnerPersonId === input.loserPersonId) return err(MergeErrors.SAME_PERSON);

  /*
   * Not your own record, in either direction. Merging yourself away repoints
   * your membership onto someone else mid-request, and the AuthContext already
   * resolved from the old one — a state nothing downstream expects.
   */
  if (ctx.personId === input.loserPersonId || ctx.personId === input.winnerPersonId) {
    return err(MergeErrors.CANNOT_MERGE_SELF);
  }

  return withTenant(ctx, async (tx) => {
    const winner = await directory.personById(tx, input.winnerPersonId);
    const loser = await directory.personById(tx, input.loserPersonId);
    if (!winner || !loser) return err(AdmissionErrors.PERSON_NOT_FOUND);

    // Merging a record that already lost a merge would make the first reversal
    // put rows back on a person who has since moved on again.
    if (loser.mergedIntoPersonId !== null || winner.mergedIntoPersonId !== null) {
      return err(MergeErrors.ALREADY_MERGED);
    }

    const moved = await directory.repoint(
      tx,
      input.loserPersonId,
      input.winnerPersonId,
      ctx.personId,
    );

    // The loser stays. Nothing is hard-deleted, and the row is what makes an
    // old reference to that id still resolve to a human.
    await directory.setMergedInto(tx, input.loserPersonId, input.winnerPersonId, ctx.personId);

    const mergeId = await directory.recordMerge(tx, {
      winner: input.winnerPersonId,
      loser: input.loserPersonId,
      moved,
      reason: input.reason,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'student.merged', input.loserPersonId, {
      entityType: 'person',
      reason: input.reason,
      after: {
        mergeId,
        winnerPersonId: input.winnerPersonId,
        loserPersonId: input.loserPersonId,
        students: fact(moved.students.length),
        guardianLinks: fact(moved.guardianLinks.length),
        staff: fact(moved.staff.length),
        memberships: fact(moved.memberships.length),
      },
    });

    return ok({
      mergeId,
      moved: {
        students: moved.students.length,
        guardianLinks: moved.guardianLinks.length,
        staff: moved.staff.length,
        memberships: moved.memberships.length,
      },
    });
  });
}

/**
 * Reverses a merge.
 *
 * Puts back exactly the rows recorded in `person_merge.moved`, BY ID. Not
 * "everything currently pointing at the winner" — the winner may legitimately
 * have gained rows since, and returning those would move a second family's
 * records to a stranger.
 */
export async function unmergePersons(
  ctx: AuthContext,
  input: { mergeId: string; reason: string },
): Promise<Result<{ reversed: boolean }, DomainError>> {
  authorize(ctx, 'student.merge');

  return withTenant(ctx, async (tx) => {
    const record = await directory.mergeById(tx, input.mergeId);
    if (!record) return err(MergeErrors.MERGE_NOT_FOUND);
    if (record.reversedAt !== null) return err(MergeErrors.MERGE_ALREADY_REVERSED);

    await directory.repointBack(tx, record.moved, record.loserPersonId, ctx.personId);
    await directory.setMergedInto(tx, record.loserPersonId, null, ctx.personId);
    await directory.markMergeReversed(tx, input.mergeId, input.reason, ctx.personId);

    await audit(tx, ctx, 'student.mergeReversed', record.loserPersonId, {
      entityType: 'person',
      reason: input.reason,
      after: { mergeId: input.mergeId, winnerPersonId: record.winnerPersonId },
    });

    return ok({ reversed: true });
  });
}
