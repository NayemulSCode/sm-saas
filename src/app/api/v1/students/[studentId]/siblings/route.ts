/**
 * POST /api/v1/students/:id/siblings
 *
 * Drives sibling discounts and SMS deduplication (FR-4.8, FR-9.4).
 */
import { linkSiblings, LinkSiblingsSchema } from '../../../../../../modules/directory/index';
import type { StudentId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof LinkSiblingsSchema.parse>,
  unknown,
  { studentId: string }
>(LinkSiblingsSchema, (ctx, input, params) =>
  linkSiblings(ctx, {
    studentId: params.studentId as StudentId,
    siblingStudentId: input.siblingStudentId as StudentId,
  }),
);
