/**
 * Invoice generation — idempotent by construction. §13.6.
 *
 * For every active enrolment: combine `fee_structure ∪ fee_assignment`,
 * apply approved discounts valid on the period's start date, write
 * `invoice`/`invoice_line` rows. Running it twice for the same period must
 * add nothing the second time — §13.9's first acceptance test.
 *
 * TWO guards make that true, not one:
 *   - `invoice_line`'s own unique index (migration 0014) — §13.6's own words
 *     for it: "the idempotency guard".
 *   - `invoice`'s own unique index (migration 0015, added alongside this PR)
 *     — the guard §13.6's pseudocode assumes but the schema never actually
 *     built, until now. Without it, two runs (or a retried request racing
 *     itself) could create two SEPARATE invoices for the same period before
 *     either reached a line.
 *
 * `academicYearId` alone determines the school — no separate `schoolId`
 * input, so there is no `schoolId`/`academicYearId` pair to disagree with
 * each other in the first place. Same reasoning `fee_structure`'s
 * `SCOPE_SCHOOL_MISMATCH` exists to catch, applied by removing the
 * redundant parameter instead of validating it.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate } from '../../../shared/date';
import { Money } from '../../../shared/money';
import type { AcademicYearId, ClassLevelId, FeeHeadId, SectionId } from '../../../shared/ids';
import { priceStudentFees } from '../domain/rules/price';
import { finance, type FeeStructureCandidate } from '../infrastructure/repositories';

export const InvoiceGenerationErrors = defineErrors({
  YEAR_NOT_FOUND: {
    code: 'YEAR_NOT_FOUND',
    messageKey: 'finance.error.yearNotFound',
    httpStatus: 404,
  },
  INVALID_DATES: {
    code: 'INVALID_DATES',
    messageKey: 'finance.error.invalidDates',
    httpStatus: 400,
  },
});

export interface GenerateInvoicesInput {
  academicYearId: AcademicYearId;
  /** '2027-03', '2027-T1', 'ADM' — a label, not a parsed date (§13.2). */
  periodLabel: string;
  issuedOn: string;
  dueDate: string;
}

export interface GenerateInvoicesResult {
  studentsProcessed: number;
  invoicesCreated: number;
  invoicesReused: number;
  linesCreated: number;
}

export async function generateInvoices(
  ctx: AuthContext,
  input: GenerateInvoicesInput,
): Promise<Result<GenerateInvoicesResult, DomainError>> {
  authorize(ctx, 'fee.structure.manage');

  const issuedOn = LocalDate.parse(input.issuedOn);
  const dueDate = LocalDate.parse(input.dueDate);
  if (!issuedOn.ok || !dueDate.ok) return err(InvoiceGenerationErrors.INVALID_DATES);
  if (LocalDate.compare(issuedOn.value, dueDate.value) > 0) {
    return err(InvoiceGenerationErrors.INVALID_DATES);
  }

  return withTenant(
    ctx,
    async (tx) => {
      const year = await finance.academicYearSchool(tx, input.academicYearId);
      if (!year) return err(InvoiceGenerationErrors.YEAR_NOT_FOUND);

      const enrolments = await finance.activeEnrolmentsFor(tx, {
        schoolId: year.schoolId,
        academicYearId: input.academicYearId,
      });

      // Names for `invoice_line.description` — fetched once for the whole
      // run rather than once per line, since the fee head catalogue is
      // tenant-wide and does not vary per student.
      const heads = await finance.listFeeHeads(tx);
      const nameByHead = new Map(heads.map((h) => [h.id, h.nameEn]));

      // A section's fee_structure candidates do not depend on WHICH student
      // in that section is being priced, so caching by (class, section)
      // turns "one query per student" into "one query per section" — the
      // difference between dozens of round trips and hundreds on a school
      // with 300+ students.
      const structureCache = new Map<string, FeeStructureCandidate[]>();
      async function structureFor(classLevelId: ClassLevelId, sectionId: SectionId) {
        const key = `${classLevelId}:${sectionId}`;
        let cached = structureCache.get(key);
        if (!cached) {
          cached = await finance.structureCandidatesFor(tx, {
            academicYearId: input.academicYearId,
            classLevelId,
            sectionId,
          });
          structureCache.set(key, cached);
        }
        return cached;
      }

      let invoicesCreated = 0;
      let invoicesReused = 0;
      let linesCreated = 0;

      for (const enr of enrolments) {
        const [structureCandidates, overrides, discounts] = await Promise.all([
          structureFor(enr.classLevelId, enr.sectionId),
          finance.assignmentOverridesFor(tx, {
            studentId: enr.studentId,
            academicYearId: input.academicYearId,
          }),
          finance.approvedDiscountsFor(tx, { studentId: enr.studentId, onDate: issuedOn.value }),
        ]);

        const priced = priceStudentFees(
          structureCandidates.map((c) => ({
            feeHeadId: c.feeHeadId,
            amountMinor: Money.fromMinor(c.amountMinor),
            scope: c.scope,
          })),
          overrides.map((o) => ({
            feeHeadId: o.feeHeadId,
            amountMinor: Money.fromMinor(o.amountMinor),
          })),
          discounts.map((d) => ({
            feeHeadId: d.feeHeadId,
            valueMinor: d.valueMinor === null ? null : Money.fromMinor(d.valueMinor),
            percent: d.percent,
          })),
        );

        // No head applies to this student at all — no invoice, empty or
        // otherwise. An enrolment with genuinely nothing to charge (a fully
        // sponsored seat, say) should not have an empty invoice appear.
        if (priced.length === 0) continue;

        const { invoiceId, created } = await finance.findOrCreateInvoice(tx, {
          studentId: enr.studentId,
          academicYearId: input.academicYearId,
          periodLabel: input.periodLabel,
          issuedOn: issuedOn.value,
          dueDate: dueDate.value,
          actorId: ctx.personId,
        });
        if (created) invoicesCreated++;
        else invoicesReused++;

        let addedALine = false;
        for (const line of priced) {
          const inserted = await finance.insertInvoiceLineIfAbsent(tx, {
            invoiceId,
            feeHeadId: line.feeHeadId as FeeHeadId,
            description: nameByHead.get(line.feeHeadId as FeeHeadId) ?? line.feeHeadId,
            amountMinor: line.amountMinor.minor,
            discountMinor: line.discountMinor.minor,
            actorId: ctx.personId,
          });
          if (inserted) {
            linesCreated++;
            addedALine = true;
          }
        }

        // A reused invoice that gained no new line this run needs no totals
        // recompute — its totals already reflect its existing lines.
        if (created || addedALine) {
          await finance.recomputeInvoiceTotals(tx, invoiceId, ctx.personId);
        }
      }

      await audit(tx, ctx, 'invoice.generated', input.academicYearId, {
        entityType: 'invoiceGenerationRun',
        after: {
          schoolId: year.schoolId,
          academicYearId: input.academicYearId,
          periodLabel: fact(input.periodLabel),
          studentsProcessed: fact(enrolments.length),
          invoicesCreated: fact(invoicesCreated),
          invoicesReused: fact(invoicesReused),
          linesCreated: fact(linesCreated),
        },
      });

      return ok({
        studentsProcessed: enrolments.length,
        invoicesCreated,
        invoicesReused,
        linesCreated,
      });
    },
    // A school of 1,000+ students, each needing a handful of small
    // queries — affordable, but not inside the 15s interactive default.
    { statementTimeout: '2min' },
  );
}
