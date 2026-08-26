/**
 * Sections and shifts. §14.4.
 *
 * "Capacity, class teacher, campus and shift all resolved; a section without a
 * shift is unschedulable." Every one of those is a foreign key the database
 * would enforce anyway — but a composite FK failure reads as a 500 and tells
 * the office nothing, so they are resolved here with an error each.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { CampusId, ClassLevelId, SchoolId, SectionId, ShiftId, StaffId } from '../../../shared/ids';
import { structure } from '../infrastructure/repositories';
import { YearErrors } from './academicYears';

export const SectionErrors = defineErrors({
  CAMPUS_NOT_FOUND: {
    code: 'CAMPUS_NOT_FOUND',
    messageKey: 'structure.error.campusNotFound',
    httpStatus: 404,
  },
  SHIFT_NOT_FOUND: {
    code: 'SHIFT_NOT_FOUND',
    messageKey: 'structure.error.shiftNotFound',
    httpStatus: 404,
  },
  /** A shift belongs to a campus; a section cannot borrow another campus's. */
  SHIFT_WRONG_CAMPUS: {
    code: 'SHIFT_WRONG_CAMPUS',
    messageKey: 'structure.error.shiftWrongCampus',
    httpStatus: 409,
  },
  CLASS_LEVEL_NOT_FOUND: {
    code: 'CLASS_LEVEL_NOT_FOUND',
    messageKey: 'structure.error.levelNotFound',
    httpStatus: 404,
  },
  CLASS_TEACHER_NOT_FOUND: {
    code: 'CLASS_TEACHER_NOT_FOUND',
    messageKey: 'structure.error.classTeacherNotFound',
    httpStatus: 404,
  },
  INVALID_CAPACITY: {
    code: 'INVALID_CAPACITY',
    messageKey: 'structure.error.invalidCapacity',
    httpStatus: 400,
  },
  SECTION_NOT_FOUND: {
    code: 'SECTION_NOT_FOUND',
    messageKey: 'structure.error.sectionNotFound',
    httpStatus: 404,
  },
  /** Lowering capacity below the students already in the room. */
  CAPACITY_BELOW_OCCUPANCY: {
    code: 'CAPACITY_BELOW_OCCUPANCY',
    messageKey: 'structure.error.capacityBelowOccupancy',
    httpStatus: 409,
  },
  INVALID_SHIFT_TIMES: {
    code: 'INVALID_SHIFT_TIMES',
    messageKey: 'structure.error.invalidShiftTimes',
    httpStatus: 400,
  },
});

/** 'HH:MM' or 'HH:MM:SS'. The database column is `time`. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export interface CreateShiftInput {
  campusId: CampusId;
  nameBn: string;
  nameEn: string;
  startTime: string;
  endTime: string;
}

/**
 * Adds a shift to a campus.
 *
 * Provisioning creates one day shift. A school running morning and day adds the
 * second here — deliberately, because a shift brings its own timetable and its
 * own working-day calendar, and an unused one sits empty looking like a bug.
 */
export async function createShift(
  ctx: AuthContext,
  input: CreateShiftInput,
): Promise<Result<{ shiftId: ShiftId; sequence: number }, DomainError>> {
  authorize(ctx, 'structure.manage');

  if (!TIME.test(input.startTime) || !TIME.test(input.endTime)) {
    return err(SectionErrors.INVALID_SHIFT_TIMES);
  }
  // The database has the same CHECK; this one produces a usable message.
  if (input.endTime <= input.startTime) return err(SectionErrors.INVALID_SHIFT_TIMES);

  return withTenant(ctx, async (tx) => {
    // RLS scopes this to the tenant, so a campus in another school of the same
    // tenant is legitimate and one in another tenant is invisible.
    if (!(await structure.campusExists(tx, input.campusId))) {
      return err(SectionErrors.CAMPUS_NOT_FOUND);
    }

    const sequence = await structure.nextShiftSequence(tx, input.campusId);
    const shiftId = await structure.createShift(tx, {
      campusId: input.campusId,
      nameBn: input.nameBn,
      nameEn: input.nameEn,
      startTime: input.startTime,
      endTime: input.endTime,
      sequence,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'shift.created', shiftId, {
      entityType: 'shift',
      after: {
        shiftId,
        campusId: input.campusId,
        nameEn: fact(input.nameEn),
        startTime: fact(input.startTime),
        endTime: fact(input.endTime),
      },
    });

    return ok({ shiftId, sequence });
  });
}

export interface CreateSectionInput {
  schoolId: SchoolId;
  classLevelId: ClassLevelId;
  campusId: CampusId;
  /** Required. A section without a shift is unschedulable (§14.4). */
  shiftId: ShiftId;
  nameBn: string;
  nameEn: string;
  capacity?: number | undefined;
  classTeacherId?: StaffId | undefined;
}

export async function createSection(
  ctx: AuthContext,
  input: CreateSectionInput,
): Promise<Result<{ sectionId: SectionId }, DomainError>> {
  authorize(ctx, 'structure.manage', { campusId: input.campusId, classId: input.classLevelId });

  if (input.capacity !== undefined && (!Number.isInteger(input.capacity) || input.capacity <= 0)) {
    return err(SectionErrors.INVALID_CAPACITY);
  }

  return withTenant(ctx, async (tx) => {
    if (!(await structure.schoolExists(tx, input.schoolId))) {
      return err(YearErrors.SCHOOL_NOT_FOUND);
    }
    if (!(await structure.levelInSchool(tx, input.classLevelId, input.schoolId))) {
      return err(SectionErrors.CLASS_LEVEL_NOT_FOUND);
    }
    if (!(await structure.campusInSchool(tx, input.campusId, input.schoolId))) {
      return err(SectionErrors.CAMPUS_NOT_FOUND);
    }
    /*
     * The shift must belong to THIS campus. The working-day calendar is keyed
     * by (campus, shift), so a section pointing at another campus's shift has
     * no calendar at all — and the single-column FK would happily allow it.
     */
    if (!(await structure.shiftOnCampus(tx, input.shiftId, input.campusId))) {
      return err(SectionErrors.SHIFT_WRONG_CAMPUS);
    }
    if (input.classTeacherId && !(await structure.staffExists(tx, input.classTeacherId))) {
      return err(SectionErrors.CLASS_TEACHER_NOT_FOUND);
    }

    const sectionId = await structure.createSection(tx, {
      classLevelId: input.classLevelId,
      campusId: input.campusId,
      shiftId: input.shiftId,
      nameBn: input.nameBn,
      nameEn: input.nameEn.trim(),
      capacity: input.capacity,
      classTeacherId: input.classTeacherId,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'section.created', sectionId, {
      entityType: 'section',
      after: {
        sectionId,
        classLevelId: input.classLevelId,
        campusId: input.campusId,
        shiftId: input.shiftId,
        nameEn: fact(input.nameEn.trim()),
        capacity: input.capacity === undefined ? null : fact(input.capacity),
        hasClassTeacher: input.classTeacherId !== undefined,
      },
    });

    return ok({ sectionId });
  });
}

export interface UpdateSectionInput {
  sectionId: SectionId;
  nameBn?: string | undefined;
  nameEn?: string | undefined;
  /** `null` clears it. */
  capacity?: number | null | undefined;
  classTeacherId?: StaffId | null | undefined;
}

export async function updateSection(
  ctx: AuthContext,
  input: UpdateSectionInput,
): Promise<Result<{ updated: boolean }, DomainError>> {
  authorize(ctx, 'structure.manage');

  if (
    input.capacity !== undefined &&
    input.capacity !== null &&
    (!Number.isInteger(input.capacity) || input.capacity <= 0)
  ) {
    return err(SectionErrors.INVALID_CAPACITY);
  }

  return withTenant(ctx, async (tx) => {
    const before = await structure.sectionById(tx, input.sectionId);
    if (!before) return err(SectionErrors.SECTION_NOT_FOUND);

    if (input.classTeacherId && !(await structure.staffExists(tx, input.classTeacherId))) {
      return err(SectionErrors.CLASS_TEACHER_NOT_FOUND);
    }

    /*
     * Capacity may not be lowered below the students already in the room.
     * Nothing downstream reads capacity as a hard limit yet, so the alternative
     * is a section that silently reports itself over-full for the rest of the
     * year and an office that cannot see why.
     */
    if (typeof input.capacity === 'number') {
      const occupied = await structure.occupancyNow(tx, input.sectionId);
      if (input.capacity < occupied) return err(SectionErrors.CAPACITY_BELOW_OCCUPANCY);
    }

    await structure.updateSection(tx, input.sectionId, input, ctx.personId);
    const after = await structure.sectionById(tx, input.sectionId);

    await audit(tx, ctx, 'section.updated', input.sectionId, {
      entityType: 'section',
      before: { ...before },
      after: { ...after },
    });

    return ok({ updated: true });
  });
}
