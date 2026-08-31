/**
 * Finance DTOs. §13.1, §13.7.
 *
 * Shared by the client form and the server handler, so the two cannot drift —
 * same convention as `structure/application/dto.ts`.
 */

import { z } from 'zod';
import {
  zDiscountKind,
  zFeeFrequency,
  zLocalDate,
  zMoney,
  zNameBn,
  zNameEn,
  zPaymentChannel,
  zReason,
  zShortReason,
  zUlid,
} from '../../../shared/api/primitives';

export const CreateFeeHeadSchema = z.object({
  code: z.string().trim().min(1).max(40),
  nameBn: zNameBn,
  nameEn: zNameEn,
  frequency: zFeeFrequency,
  /** Whether a withdrawal refunds this head — e.g. a security deposit does,
   *  a tuition month does not. Defaults false: refundable is the exception. */
  isRefundable: z.boolean().default(false),
  glCode: z.string().trim().max(40).optional(),
  sequence: z.number().int().min(0).optional(),
});

export const CreateFeeStructureSchema = z
  .object({
    academicYearId: zUlid(),
    feeHeadId: zUlid(),
    classLevelId: zUlid().optional(),
    sectionId: zUlid().optional(),
    amountMinor: zMoney,
    dueDay: z.number().int().min(1).max(31).optional(),
  })
  // Exactly one scope: class-wide OR section-specific — the same rule
  // `fee_structure`'s own CHECK (num_nonnulls(...) = 1) enforces in SQL. Given
  // here too so a bad request reads as a 400 with a field, not a 500 from a
  // constraint the caller never sees.
  .refine((v) => (v.classLevelId !== undefined) !== (v.sectionId !== undefined), {
    message: 'finance.error.exactlyOneScope',
    path: ['classLevelId'],
  });

// studentId is NOT here — it comes from the URL path
// (`/students/{studentId}/fee-assignments`), same convention `LinkGuardianSchema`
// already uses for its nested route.
export const CreateFeeAssignmentSchema = z.object({
  feeHeadId: zUlid(),
  academicYearId: zUlid(),
  amountMinor: zMoney,
  reason: zShortReason,
});

export const CreateDiscountSchema = z
  .object({
    studentId: zUlid(),
    /** Omitted = every head. */
    feeHeadId: zUlid().optional(),
    kind: zDiscountKind,
    valueMinor: zMoney.optional(),
    percent: z.number().min(0).max(100).optional(),
    validFrom: zLocalDate,
    validTo: zLocalDate.optional(),
    reason: zShortReason,
  })
  // Fixed amount OR percent, never both, never neither — mirrors `discount`'s
  // own CHECK (num_nonnulls(value_minor, percent) = 1).
  .refine((v) => (v.valueMinor !== undefined) !== (v.percent !== undefined), {
    message: 'finance.error.exactlyOneDiscountValue',
    path: ['valueMinor'],
  });

/** Dangerous: `fee.waive` is in `DANGEROUS_PERMISSIONS`, so this needs the
 *  longer, substantive reason — same bar as `CloseAcademicYearSchema`. */
export const ApproveDiscountSchema = z.object({ reason: zReason });

export const GenerateInvoicesSchema = z
  .object({
    academicYearId: zUlid(),
    periodLabel: z.string().trim().min(1).max(20),
    issuedOn: zLocalDate,
    dueDate: zLocalDate,
  })
  .refine((v) => v.issuedOn <= v.dueDate, {
    message: 'finance.error.invalidDates',
    path: ['dueDate'],
  });

export const RecordPaymentSchema = z
  .object({
    studentId: zUlid(),
    amountMinor: zMoney,
    channel: zPaymentChannel,
    channelRef: z.string().trim().max(64).optional(),
    /** May be backdated — the office enters Saturday's cash on Monday. */
    collectedAt: zLocalDate,
    allocation: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('auto') }),
        z.object({
          mode: z.literal('manual'),
          lines: z
            .array(z.object({ invoiceLineId: zUlid(), amountMinor: zMoney }))
            .min(1),
        }),
      ])
      .default({ mode: 'auto' }),
    note: z.string().trim().max(280).optional(),
  })
  // Every channel except cash needs a reference — a deposit slip, a cheque
  // number, a transaction id. Cash has none of those to name.
  .refine((v) => v.channel === 'cash' || !!v.channelRef, {
    message: 'finance.error.channelReferenceRequired',
    path: ['channelRef'],
  });
