/**
 * Fee assignments — a per-student override that beats `fee_structure`. §13.1.
 *
 * §13.7 does not contract an endpoint for this table at all — only
 * `generateInvoices` reading it is specified. Built anyway, because a table
 * with no write path except a hand-run `INSERT` is a feature only support
 * staff can operate: a scholarship, or a corrected amount for one student, is
 * exactly the kind of thing an accountant needs to do without a database
 * console. Scoped the same way `fee_structure` is — `fee.structure.manage` to
 * write, `fee.read` to read — since it is the same class of decision: what
 * this student is charged.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { Money } from '../../../shared/money';
import type { AcademicYearId, FeeAssignmentId, FeeHeadId, StudentId } from '../../../shared/ids';
import { finance } from '../infrastructure/repositories';

export const FeeAssignmentErrors = defineErrors({
  STUDENT_NOT_FOUND: {
    code: 'STUDENT_NOT_FOUND',
    messageKey: 'finance.error.studentNotFound',
    httpStatus: 404,
  },
  HEAD_NOT_FOUND: {
    code: 'HEAD_NOT_FOUND',
    messageKey: 'finance.error.headNotFound',
    httpStatus: 404,
  },
  YEAR_NOT_FOUND: {
    code: 'YEAR_NOT_FOUND',
    messageKey: 'finance.error.yearNotFound',
    httpStatus: 404,
  },
  ASSIGNMENT_TAKEN: {
    code: 'ASSIGNMENT_TAKEN',
    messageKey: 'finance.error.assignmentTaken',
    httpStatus: 409,
  },
});

export interface CreateFeeAssignmentInput {
  studentId: StudentId;
  feeHeadId: FeeHeadId;
  academicYearId: AcademicYearId;
  /** Minor units, as a wire string. */
  amountMinor: string;
  reason: string;
}

export interface FeeAssignmentRow {
  id: FeeAssignmentId;
  studentId: StudentId;
  feeHeadId: FeeHeadId;
  academicYearId: AcademicYearId;
  amountMinor: string;
  reason: string;
}

export async function createFeeAssignment(
  ctx: AuthContext,
  input: CreateFeeAssignmentInput,
): Promise<Result<{ feeAssignmentId: FeeAssignmentId }, DomainError>> {
  authorize(ctx, 'fee.structure.manage');

  return withTenant(ctx, async (tx) => {
    if (!(await finance.studentExists(tx, input.studentId))) {
      return err(FeeAssignmentErrors.STUDENT_NOT_FOUND);
    }
    if (!(await finance.feeHeadExists(tx, input.feeHeadId))) {
      return err(FeeAssignmentErrors.HEAD_NOT_FOUND);
    }
    if (!(await finance.academicYearSchool(tx, input.academicYearId))) {
      return err(FeeAssignmentErrors.YEAR_NOT_FOUND);
    }
    if (
      await finance.feeAssignmentConflict(tx, {
        studentId: input.studentId,
        feeHeadId: input.feeHeadId,
        academicYearId: input.academicYearId,
      })
    ) {
      return err(FeeAssignmentErrors.ASSIGNMENT_TAKEN);
    }

    const amount = Money.fromJSON(input.amountMinor);

    const feeAssignmentId = await finance.createFeeAssignment(tx, {
      studentId: input.studentId,
      feeHeadId: input.feeHeadId,
      academicYearId: input.academicYearId,
      amountMinor: amount.minor,
      reason: input.reason,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'feeAssignment.created', feeAssignmentId, {
      entityType: 'feeAssignment',
      reason: input.reason,
      after: {
        feeAssignmentId,
        studentId: input.studentId,
        feeHeadId: input.feeHeadId,
        academicYearId: input.academicYearId,
        amountMinor: fact(amount.minor.toString()),
      },
    });

    return ok({ feeAssignmentId });
  });
}

export async function listFeeAssignments(
  ctx: AuthContext,
  filter: { studentId?: StudentId | undefined } = {},
): Promise<Result<FeeAssignmentRow[], DomainError>> {
  authorize(ctx, 'fee.read');

  return withTenant(
    ctx,
    async (tx) => {
      const rows = await finance.listFeeAssignments(tx, filter);
      return ok(rows.map((r) => ({ ...r, amountMinor: r.amountMinor.toString() })));
    },
    { readOnly: true },
  );
}
