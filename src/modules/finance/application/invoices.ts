/**
 * Invoice generation and outstanding balances. §13.6.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { AcademicYearId, FeeHeadId, SchoolId, StudentId } from '../../../shared/ids';
import { Money } from '../../../shared/money';
import { sumLines, recomputeStatus } from '../domain/invoice';
import {
  enrolments,
  feeHeads,
  feeStructures,
  invoices,
  type FeeStructureRow,
  type OutstandingRow,
} from '../infrastructure/repositories';

export interface GenerateInvoicesInput {
  schoolId: SchoolId;
  academicYearId: AcademicYearId;
  periodLabel: string;
  issuedOn: string;
  dueDate: string;
}

export interface GenerateInvoicesResult {
  invoicesTouched: number;
  linesCreated: number;
}

/** A section-specific structure wins over a class-wide one for the same fee
 *  head — the whole reason `fee_structure`'s scope CHECK allows both to
 *  exist for one head, one class, at once. */
function pickApplicable(structures: readonly FeeStructureRow[]): Map<FeeHeadId, FeeStructureRow> {
  const byHead = new Map<FeeHeadId, FeeStructureRow>();
  for (const s of structures) {
    const existing = byHead.get(s.feeHeadId);
    if (!existing || (s.sectionId && !existing.sectionId)) byHead.set(s.feeHeadId, s);
  }
  return byHead;
}

/**
 * Idempotent by construction (§13.6): `invoices.create` gets-or-creates on
 * (student, year, period), and `invoices.insertLineIfAbsent` gets-or-creates
 * on (invoice, fee_head) — both via a unique index, not job-side bookkeeping,
 * so a concurrent or repeated run cannot double-bill. Running this twice for
 * the same period is a no-op the second time.
 */
export async function generateInvoices(
  ctx: AuthContext,
  input: GenerateInvoicesInput,
): Promise<Result<GenerateInvoicesResult, DomainError>> {
  authorize(ctx, 'fee.structure.manage');

  return withTenant(ctx, async (tx) => {
    const [active, allHeads] = await Promise.all([
      enrolments.activeFor(tx, input.academicYearId),
      feeHeads.list(tx),
    ]);
    const headById = new Map(allHeads.map((h) => [h.id, h]));

    let invoicesTouched = 0;
    let linesCreated = 0;

    for (const e of active) {
      const structures = await feeStructures.forEnrolment(
        tx,
        input.academicYearId,
        e.classLevelId,
        e.sectionId,
      );
      const applicable = pickApplicable(structures);
      // Nobody is billed nothing: skip a student with no applicable fee at
      // all rather than create an invoice with zero lines.
      if (applicable.size === 0) continue;

      const invoiceId = await invoices.create(tx, {
        studentId: e.studentId,
        academicYearId: input.academicYearId,
        periodLabel: input.periodLabel,
        issuedOn: input.issuedOn,
        dueDate: input.dueDate,
        source: 'system',
      });
      invoicesTouched++;

      for (const s of applicable.values()) {
        const head = headById.get(s.feeHeadId);
        const created = await invoices.insertLineIfAbsent(tx, {
          invoiceId,
          feeHeadId: s.feeHeadId,
          description: head?.nameEn ?? s.feeHeadId,
          amountMinor: s.amountMinor,
        });
        if (created) linesCreated++;
      }

      // Recomputed unconditionally, so a re-run leaves the invoice agreeing
      // with its actual lines even when this run added nothing new.
      const lines = await invoices.linesFor(tx, invoiceId);
      const current = await invoices.byId(tx, invoiceId);
      const totals = sumLines(
        lines.map((l) => ({
          amountMinor: Money.fromMinor(l.amountMinor),
          discountMinor: Money.fromMinor(l.discountMinor),
          paidMinor: Money.fromMinor(l.paidMinor),
        })),
      );
      const status = recomputeStatus(
        { ...totals, lateFeeMinor: Money.zero() },
        current?.status ?? 'issued',
      );
      await invoices.updateTotals(tx, invoiceId, {
        totalMinor: totals.totalMinor.minor,
        discountMinor: totals.discountMinor.minor,
        paidMinor: totals.paidMinor.minor,
        status,
      });
    }

    await audit(tx, ctx, 'fee.invoicesGenerated', input.schoolId, {
      entityType: 'invoiceBatch',
      after: {
        academicYearId: input.academicYearId,
        periodLabel: fact(input.periodLabel),
        invoicesTouched: fact(invoicesTouched),
        linesCreated: fact(linesCreated),
      },
    });

    return ok({ invoicesTouched, linesCreated });
  });
}

export async function getOutstanding(
  ctx: AuthContext,
  studentId: StudentId,
): Promise<Result<OutstandingRow[], DomainError>> {
  authorize(ctx, 'fee.read');
  return withTenant(ctx, async (tx) => ok(await invoices.outstandingFor(tx, studentId)));
}
