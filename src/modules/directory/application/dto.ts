/**
 * Directory DTOs. §10.5.
 */

import { z } from 'zod';
import {
  zGender,
  zLocalDate,
  zNameBn,
  zNameEn,
  zOutcome,
  zPhoneBd,
  zReason,
  zRelationship,
  zShortReason,
  zStudentStatus,
  zUlid,
} from '../../../shared/api/primitives';

export const AdmitStudentSchema = z.object({
  schoolId: zUlid(),
  sectionId: zUlid(),
  academicYearId: zUlid(),
  /** BOTH required, neither a translation of the other (ADR-0019). */
  nameBn: zNameBn,
  nameEn: zNameEn,
  dateOfBirth: zLocalDate.optional(),
  gender: zGender.optional(),
  /** CONTACT detail, not a login. A child may share a parent's handset. */
  phone: zPhoneBd.optional(),
  rollNo: z.number().int().positive().optional(),
  admittedOn: zLocalDate.optional(),
});

export const TransitionStudentSchema = z.object({
  to: zStudentStatus,
  /** Required for withdrawal and leave; the use case enforces which. */
  reason: zShortReason.optional(),
  /** Backdating is normal office work. */
  effectiveDate: zLocalDate.optional(),
});

export const WithdrawStudentSchema = z.object({
  reason: zShortReason,
  effectiveDate: zLocalDate.optional(),
});

export const LinkGuardianSchema = z
  .object({
    /** An existing person… */
    guardianPersonId: zUlid().optional(),
    /** …or the details to create one. Exactly one of the two. */
    person: z
      .object({
        nameBn: zNameBn,
        nameEn: zNameEn,
        phone: zPhoneBd.optional(),
        email: z.email().optional(),
      })
      .optional(),
    relationship: zRelationship,
  /** Who OWES. */
    isBillingGuardian: z.boolean().default(false),
    /** Who is TOLD. */
    isPrimaryContact: z.boolean().default(false),
    canReceiveResults: z.boolean().default(true),
    canCollectStudent: z.boolean().default(true),
  })
  // Naming both is ambiguous: which one is the guardian? Refused rather than
  // resolved by precedence, which nobody would remember.
  .refine((v) => Boolean(v.guardianPersonId) !== Boolean(v.person), {
    message: 'directory.error.noGuardianGiven',
    path: ['guardianPersonId'],
  });

export const UnlinkGuardianSchema = z.object({
  guardianPersonId: zUlid(),
  reason: zShortReason,
});

export const LinkSiblingsSchema = z.object({
  siblingStudentId: zUlid(),
});

export const PromoteSectionSchema = z.object({
  fromYearId: zUlid(),
  toYearId: zUlid(),
  targetSectionId: zUlid(),
  retainSectionId: zUlid().optional(),
  defaultOutcome: z.enum(['promoted', 'retained']).default('promoted'),
  /**
   * studentId → outcome, for the students who are not doing the default.
   * A head teacher promotes forty and names the three who are repeating.
   */
  exceptions: z.record(zUlid(), zOutcome).default({}),
  reason: zShortReason,
});

export const UndoPromotionSchema = z.object({
  reason: zShortReason,
});

export const MergePersonsSchema = z.object({
  /** The duplicate. The path id is the record that survives. */
  loserPersonId: zUlid(),
  // Dangerous: student.merge fuses two children's records if it is wrong.
  reason: zReason,
});

export const UnmergePersonsSchema = z.object({
  reason: zShortReason,
});

export const UpdateStudentSchema = z.object({
  /** What the editor was shown. A mismatch is a 409, not a silent overwrite. */
  version: z.number().int().nonnegative(),
  nameBn: zNameBn.optional(),
  nameEn: zNameEn.optional(),
  dateOfBirth: zLocalDate.nullable().optional(),
  gender: zGender.nullable().optional(),
  phone: zPhoneBd.nullable().optional(),
  email: z.email().nullable().optional(),
  house: z.string().trim().max(60).nullable().optional(),
  religion: z.string().trim().max(60).nullable().optional(),
  bloodGroup: z.string().trim().max(8).nullable().optional(),
});
