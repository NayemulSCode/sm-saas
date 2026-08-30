/** POST /api/v1/invoices/generate — idempotent invoice generation. §13.6. */
import { generateInvoices, GenerateInvoicesSchema } from '../../../../../modules/finance/index';
import type { AcademicYearId, SchoolId } from '../../../../../shared/ids';
import { authed } from '../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed(GenerateInvoicesSchema, (ctx, input) =>
  generateInvoices(ctx, {
    schoolId: input.schoolId as SchoolId,
    academicYearId: input.academicYearId as AcademicYearId,
    periodLabel: input.periodLabel,
    issuedOn: input.issuedOn,
    dueDate: input.dueDate,
  }),
);
