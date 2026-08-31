/**
 * Finance DTOs. §13.1, §13.7.
 *
 * Shared by the client form and the server handler, so the two cannot drift —
 * same convention as `structure/application/dto.ts`.
 */

import { z } from 'zod';
import {
  zFeeFrequency,
  zMoney,
  zNameBn,
  zNameEn,
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
