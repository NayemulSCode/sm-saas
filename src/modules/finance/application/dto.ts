/**
 * Finance DTOs. §13.7.
 *
 * Shared by the client form and the server handler, so the two cannot drift.
 */

import { z } from 'zod';
import {
  zAllocationMode,
  zFeeFrequency,
  zLocalDate,
  zMoney,
  zPaymentChannel,
  zShortReason,
  zUlid,
} from '../../../shared/api/primitives';

export const CreateFeeHeadSchema = z.object({
  code: z.string().trim().min(1).max(40),
  nameBn: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().min(1).max(120),
  frequency: zFeeFrequency,
  isRefundable: z.boolean().default(false),
  sequence: z.number().int().min(0).default(0),
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
  // Mirrors the database CHECK (num_nonnulls = 1) — caught here, with a field
  // path, rather than surfacing as an opaque constraint violation.
  .refine((v) => (v.classLevelId ? 1 : 0) + (v.sectionId ? 1 : 0) === 1, {
    message: 'finance.error.feeStructureScope',
    path: ['classLevelId'],
  });

export const GenerateInvoicesSchema = z.object({
  schoolId: zUlid(),
  academicYearId: zUlid(),
  /** '2027-03', '2027-T1', 'ADM' — a label, not a parseable date. */
  periodLabel: z.string().trim().min(1).max(20),
  issuedOn: zLocalDate,
  dueDate: zLocalDate,
});

export const RecordPaymentSchema = z
  .object({
    schoolId: zUlid(),
    studentId: zUlid(),
    amountMinor: zMoney,
    channel: zPaymentChannel,
    channelRef: z.string().trim().max(64).optional(),
    /** A calendar day, per §13.7 — may be backdated. `fee.backdate` is
     *  checked in the use case, not here. */
    collectedAt: zLocalDate,
    allocation: zAllocationMode.default({ mode: 'auto' }),
    idempotencyKey: z.string().trim().min(1).max(128),
  })
  .refine((v) => v.channel === 'cash' || Boolean(v.channelRef), {
    message: 'finance.error.channelRefRequired',
    path: ['channelRef'],
  });

export const ReversePaymentSchema = z.object({
  reason: zShortReason,
});
