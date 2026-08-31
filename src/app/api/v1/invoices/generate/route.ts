/**
 * POST /api/v1/invoices/generate — §13.6, §13.7.
 *
 * §10's own convention for what the spec writes as `:generate` — a literal
 * `:` cannot appear in a Windows filename, so `/resource/verb` is used
 * instead, same as `/class-levels/reorder`.
 *
 * §13.7 lists this as needing an `Idempotency-Key` header and running as an
 * "async job". Neither is here yet — see the PR description for why: the
 * unique indexes on `invoice`/`invoice_line` already make a re-run safe
 * without one, which is a different (and weaker) guarantee than the exact
 * response replay `Idempotency-Key` gives, and running as a synchronous
 * request is a deliberate, scoped choice for this first cut, not an oversight.
 */
import { generateInvoices, GenerateInvoicesSchema } from '../../../../../modules/finance/index';
import type { AcademicYearId } from '../../../../../shared/ids';
import { authed } from '../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed(GenerateInvoicesSchema, (ctx, input) =>
  generateInvoices(ctx, {
    academicYearId: input.academicYearId as AcademicYearId,
    periodLabel: input.periodLabel,
    issuedOn: input.issuedOn,
    dueDate: input.dueDate,
  }),
);
