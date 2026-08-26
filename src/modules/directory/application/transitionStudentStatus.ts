/**
 * Student lifecycle transitions. §14.5, FR-4.1.
 *
 * "Only legal transitions; every one writes a `student_status_event` with actor
 * and reason." The status column is the current value; the event table is how
 * it got there, and a status that changed with no event is a record nobody can
 * explain to a parent.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate, systemClock, type Clock } from '../../../shared/date';
import type { StudentId } from '../../../shared/ids';
import {
  evaluateTransition,
  dateColumnFor,
  requiresReason,
  type StudentStatus,
} from '../domain/studentStatus';
import { directory } from '../infrastructure/repositories';
import { AdmissionErrors } from './admitStudent';

export const TransitionErrors = defineErrors({
  ILLEGAL_TRANSITION: {
    code: 'ILLEGAL_TRANSITION',
    messageKey: 'directory.error.illegalTransition',
    httpStatus: 409,
  },
  ALREADY_IN_STATUS: {
    code: 'ALREADY_IN_STATUS',
    messageKey: 'directory.error.alreadyInStatus',
    httpStatus: 409,
  },
  REASON_REQUIRED: {
    code: 'REASON_REQUIRED',
    messageKey: 'directory.error.reasonRequired',
    httpStatus: 400,
  },
  INVALID_EFFECTIVE_DATE: {
    code: 'INVALID_EFFECTIVE_DATE',
    messageKey: 'directory.error.invalidEffectiveDate',
    httpStatus: 400,
  },
});

export interface TransitionInput {
  studentId: StudentId;
  to: StudentStatus;
  /** Required for withdrawal and leave. */
  reason?: string | undefined;
  /** Defaults to today. Backdating a withdrawal is normal office work. */
  effectiveDate?: string | undefined;
}

export async function transitionStudentStatus(
  ctx: AuthContext,
  input: TransitionInput,
  deps: { clock?: Clock } = {},
): Promise<Result<{ from: StudentStatus; to: StudentStatus }, DomainError>> {
  authorize(ctx, 'student.transition');

  /*
   * "Why did you mark my child withdrawn?" needs an answer that is not "the
   * system did it". Checked before the lookup so the caller is told what is
   * missing rather than what does not exist.
   */
  if (requiresReason(input.to) && !input.reason?.trim()) {
    return err(TransitionErrors.REASON_REQUIRED);
  }

  let effective = LocalDate.today(deps.clock ?? systemClock);
  if (input.effectiveDate !== undefined) {
    const parsed = LocalDate.parse(input.effectiveDate);
    if (!parsed.ok) return err(TransitionErrors.INVALID_EFFECTIVE_DATE);
    effective = parsed.value;
  }

  return withTenant(ctx, async (tx) => {
    const found = await directory.studentById(tx, input.studentId);
    if (!found) return err(AdmissionErrors.STUDENT_NOT_FOUND);

    const from = found.status as StudentStatus;
    const verdict = evaluateTransition(from, input.to);

    switch (verdict.kind) {
      case 'same_status':
        // Not silently ignored: a status event claiming a change that did not
        // happen is worse than an error the caller can handle.
        return err(TransitionErrors.ALREADY_IN_STATUS);
      case 'illegal':
        return err(TransitionErrors.ILLEGAL_TRANSITION);
      case 'ok':
        break;
    }

    await directory.setStatus(
      tx,
      input.studentId,
      input.to,
      dateColumnFor(input.to),
      effective,
      ctx.personId,
    );

    await directory.recordStatusEvent(tx, {
      studentId: input.studentId,
      from,
      to: input.to,
      reason: input.reason,
      effectiveDate: effective,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'student.statusChanged', input.studentId, {
      entityType: 'student',
      reason: input.reason,
      before: { status: fact(from) },
      after: { status: fact(input.to), effectiveDate: fact(LocalDate.toISO(effective)) },
    });

    return ok({ from, to: input.to });
  });
}

/**
 * Withdrawing a student. §14.5.
 *
 * A thin wrapper, deliberately: withdrawal is the transition offices perform
 * most and the one they get asked about most, so it has its own name, its own
 * permission check and its own audit action rather than being buried in a
 * generic status change.
 *
 * `finance` decides what happens to outstanding dues. This does not touch them
 * — it is a lifecycle event, not a settlement, and a school that withdraws a
 * student still expects to be paid for the term they attended.
 */
export async function withdrawStudent(
  ctx: AuthContext,
  input: { studentId: StudentId; reason: string; effectiveDate?: string | undefined },
  deps: { clock?: Clock } = {},
): Promise<Result<{ from: StudentStatus; to: StudentStatus }, DomainError>> {
  return transitionStudentStatus(ctx, { ...input, to: 'withdrawn' }, deps);
}
