/**
 * Structure DTOs. §10.4.
 *
 * Shared by the client form and the server handler, so the two cannot drift.
 */

import { z } from 'zod';
import {
  zLocalDate,
  zMedium,
  zNameBn,
  zNameEn,
  zReason,
  zTime,
  zUlid,
} from '../../../shared/api/primitives';

export const OpenAcademicYearSchema = z.object({
  schoolId: zUlid(),
  /** '2027' — a label, not a date. */
  name: z.string().trim().min(1).max(40),
  startDate: zLocalDate,
  endDate: zLocalDate,
  /** Defaults true: a year opened without being current is a plan, which is
   *  the less common case. */
  makeCurrent: z.boolean().default(true),
});

export const CloseAcademicYearSchema = z.object({
  // Dangerous: academicYear.close is in DANGEROUS_PERMISSIONS.
  reason: zReason,
});

export const CreateClassLevelSchema = z.object({
  schoolId: zUlid(),
  nameBn: zNameBn,
  nameEn: zNameEn,
  medium: zMedium.optional(),
  /** Kindergarten students have no login at all (FR-2.6). */
  loginEnabled: z.boolean().default(false),
  sequence: z.number().int().positive().optional(),
});

export const ReorderClassLevelsSchema = z.object({
  schoolId: zUlid(),
  /** The COMPLETE order, lowest class first. Not a diff — a partial reorder
   *  has no defined meaning when two clients send overlapping moves. */
  orderedIds: z.array(zUlid()).min(1).max(50),
  reason: z.string().trim().min(3).max(280),
});

export const CreateShiftSchema = z.object({
  campusId: zUlid(),
  nameBn: zNameBn,
  nameEn: zNameEn,
  startTime: zTime,
  endTime: zTime,
});

export const CreateSectionSchema = z.object({
  schoolId: zUlid(),
  classLevelId: zUlid(),
  campusId: zUlid(),
  /** Required — a section without a shift is unschedulable (§4.1). */
  shiftId: zUlid(),
  nameBn: zNameBn,
  nameEn: zNameEn,
  capacity: z.number().int().positive().optional(),
  classTeacherId: zUlid().optional(),
});

export const UpdateSectionSchema = z.object({
  nameBn: zNameBn.optional(),
  nameEn: zNameEn.optional(),
  /** null clears it. */
  capacity: z.number().int().positive().nullable().optional(),
  classTeacherId: zUlid().nullable().optional(),
});
