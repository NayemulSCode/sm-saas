/**
 * Structure reads and writes.
 *
 * Every query runs inside `withTenant`, so RLS narrows it to the caller's
 * school and a row from another tenant is simply absent rather than forbidden.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/rls';
import {
  academicYear,
  campus,
  classLevel,
  school,
  section,
  shift,
} from '../../../db/schema/structure';
import { enrolment } from '../../../db/schema/directory';
import { staff } from '../../../db/schema/directory';
import { Ids } from '../../../shared/ids';
import type {
  AcademicYearId,
  CampusId,
  ClassLevelId,
  PersonId,
  SchoolId,
  SectionId,
  ShiftId,
  StaffId,
} from '../../../shared/ids';
import type { LocalDate } from '../../../shared/date';
import type { ExistingYear } from '../domain/academicYear';
import type { ExistingLevel } from '../domain/classLevel';

export const structure = {
  async schoolExists(tx: Tx, schoolId: SchoolId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(school)
      .where(and(eq(school.id, schoolId), isNull(school.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  /** The only school in a single-school tenant — the overwhelmingly common case. */
  async soleSchool(tx: Tx): Promise<SchoolId | undefined> {
    const rows = await tx
      .select({ id: school.id })
      .from(school)
      .where(isNull(school.deletedAt))
      .limit(2);
    return rows.length === 1 ? rows[0]!.id : undefined;
  },

  // ── academic years ────────────────────────────────────────────────────────

  async yearsFor(tx: Tx, schoolId: SchoolId): Promise<ExistingYear[]> {
    const rows = await tx
      .select({
        id: academicYear.id,
        name: academicYear.name,
        startDate: academicYear.startDate,
        endDate: academicYear.endDate,
        isCurrent: academicYear.isCurrent,
        status: academicYear.status,
      })
      .from(academicYear)
      .where(and(eq(academicYear.schoolId, schoolId), isNull(academicYear.deletedAt)))
      .orderBy(asc(academicYear.startDate));
    return rows;
  },

  async yearById(tx: Tx, id: AcademicYearId): Promise<(ExistingYear & { schoolId: SchoolId }) | undefined> {
    const [row] = await tx
      .select({
        id: academicYear.id,
        schoolId: academicYear.schoolId,
        name: academicYear.name,
        startDate: academicYear.startDate,
        endDate: academicYear.endDate,
        isCurrent: academicYear.isCurrent,
        status: academicYear.status,
      })
      .from(academicYear)
      .where(and(eq(academicYear.id, id), isNull(academicYear.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * Clears `is_current` for a school.
   *
   * Runs BEFORE the new year is inserted. The partial unique index allows one
   * current year per school and is not deferrable, so the old one has to step
   * down first — in the same transaction, so there is never a moment with none.
   */
  async clearCurrent(tx: Tx, schoolId: SchoolId, actorId: PersonId): Promise<void> {
    await tx
      .update(academicYear)
      .set({ isCurrent: false, updatedBy: actorId })
      .where(
        and(
          eq(academicYear.schoolId, schoolId),
          eq(academicYear.isCurrent, true),
          isNull(academicYear.deletedAt),
        ),
      );
  },

  async createYear(
    tx: Tx,
    input: {
      schoolId: SchoolId;
      name: string;
      startDate: LocalDate;
      endDate: LocalDate;
      isCurrent: boolean;
      actorId: PersonId;
    },
  ): Promise<AcademicYearId> {
    const id = Ids.generate<'academicYear'>();
    await tx.insert(academicYear).values({
      id,
      schoolId: input.schoolId,
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
      isCurrent: input.isCurrent,
      // A year a school can enrol into today, rather than a plan.
      status: input.isCurrent ? 'active' : 'planning',
      createdBy: input.actorId,
    });
    return id;
  },

  async closeYear(tx: Tx, id: AcademicYearId, actorId: PersonId): Promise<void> {
    await tx
      .update(academicYear)
      .set({ status: 'closed', updatedBy: actorId })
      .where(eq(academicYear.id, id));
  },

  // ── class levels ──────────────────────────────────────────────────────────

  async levelsFor(tx: Tx, schoolId: SchoolId): Promise<ExistingLevel[]> {
    return tx
      .select({ id: classLevel.id, nameEn: classLevel.nameEn, sequence: classLevel.sequence })
      .from(classLevel)
      .where(and(eq(classLevel.schoolId, schoolId), isNull(classLevel.deletedAt)))
      .orderBy(asc(classLevel.sequence));
  },

  async createLevel(
    tx: Tx,
    input: {
      schoolId: SchoolId;
      nameBn: string;
      nameEn: string;
      sequence: number;
      medium?: 'bangla' | 'english' | 'other' | undefined;
      loginEnabled: boolean;
      actorId: PersonId;
    },
  ): Promise<ClassLevelId> {
    const id = Ids.generate<'classLevel'>();
    await tx.insert(classLevel).values({
      id,
      schoolId: input.schoolId,
      nameBn: input.nameBn.normalize('NFC'),
      nameEn: input.nameEn,
      sequence: input.sequence,
      medium: input.medium ?? null,
      loginEnabled: input.loginEnabled,
      createdBy: input.actorId,
    });
    return id;
  },

  /**
   * Applies a whole reordering.
   *
   * `SET CONSTRAINTS … DEFERRED` is what makes this a plain loop: the unique
   * constraint on (tenant_id, school_id, sequence) is checked at COMMIT rather
   * than per row, so two levels can exchange sequences without the intermediate
   * state failing (migration 0012). The invariant still holds at commit.
   */
  async applyReorder(
    tx: Tx,
    changes: ReadonlyArray<{ id: string; sequence: number }>,
    actorId: PersonId,
  ): Promise<void> {
    await tx.execute(sql`SET CONSTRAINTS class_level_sequence_unique DEFERRED`);
    for (const c of changes) {
      await tx
        .update(classLevel)
        .set({ sequence: c.sequence, updatedBy: actorId })
        .where(eq(classLevel.id, c.id as never));
    }
  },

  /**
   * Whether anyone is enrolled in a year — the "mid-year" test for reordering.
   *
   * Reordering with a cohort in place changes what "the next class up" means
   * while promotion is already keyed to it (§14.4).
   */
  async enrolmentCountIn(tx: Tx, yearId: AcademicYearId): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(enrolment)
      .where(and(eq(enrolment.academicYearId, yearId), isNull(enrolment.deletedAt)));
    return row?.n ?? 0;
  },

  // ── campuses, shifts, sections ────────────────────────────────────────────

  async campusesFor(tx: Tx, schoolId: SchoolId) {
    return tx
      .select({
        id: campus.id,
        nameBn: campus.nameBn,
        nameEn: campus.nameEn,
        isPrimary: campus.isPrimary,
      })
      .from(campus)
      .where(and(eq(campus.schoolId, schoolId), isNull(campus.deletedAt)));
  },

  /** RLS already scopes this to the tenant, which is the check that matters. */
  async campusExists(tx: Tx, campusId: CampusId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(campus)
      .where(and(eq(campus.id, campusId), isNull(campus.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  async campusInSchool(tx: Tx, campusId: CampusId, schoolId: SchoolId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(campus)
      .where(
        and(eq(campus.id, campusId), eq(campus.schoolId, schoolId), isNull(campus.deletedAt)),
      );
    return (row?.n ?? 0) > 0;
  },

  async shiftsFor(tx: Tx, campusId: CampusId) {
    return tx
      .select({
        id: shift.id,
        campusId: shift.campusId,
        nameBn: shift.nameBn,
        nameEn: shift.nameEn,
        startTime: shift.startTime,
        endTime: shift.endTime,
        sequence: shift.sequence,
      })
      .from(shift)
      .where(and(eq(shift.campusId, campusId), isNull(shift.deletedAt)))
      .orderBy(asc(shift.sequence));
  },

  async shiftOnCampus(tx: Tx, shiftId: ShiftId, campusId: CampusId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(shift)
      .where(and(eq(shift.id, shiftId), eq(shift.campusId, campusId), isNull(shift.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  async createShift(
    tx: Tx,
    input: {
      campusId: CampusId;
      nameBn: string;
      nameEn: string;
      startTime: string;
      endTime: string;
      sequence: number;
      actorId: PersonId;
    },
  ): Promise<ShiftId> {
    const id = Ids.generate<'shift'>();
    await tx.insert(shift).values({
      id,
      campusId: input.campusId,
      nameBn: input.nameBn.normalize('NFC'),
      nameEn: input.nameEn,
      startTime: input.startTime,
      endTime: input.endTime,
      sequence: input.sequence,
      createdBy: input.actorId,
    });
    return id;
  },

  async nextShiftSequence(tx: Tx, campusId: CampusId): Promise<number> {
    const [row] = await tx
      .select({ max: sql<number | null>`max(${shift.sequence})` })
      .from(shift)
      .where(and(eq(shift.campusId, campusId), isNull(shift.deletedAt)));
    return (row?.max ?? 0) + 1;
  },

  async levelInSchool(tx: Tx, levelId: ClassLevelId, schoolId: SchoolId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(classLevel)
      .where(
        and(
          eq(classLevel.id, levelId),
          eq(classLevel.schoolId, schoolId),
          isNull(classLevel.deletedAt),
        ),
      );
    return (row?.n ?? 0) > 0;
  },

  async staffExists(tx: Tx, staffId: StaffId): Promise<boolean> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(staff)
      .where(and(eq(staff.id, staffId), isNull(staff.deletedAt)));
    return (row?.n ?? 0) > 0;
  },

  async createSection(
    tx: Tx,
    input: {
      classLevelId: ClassLevelId;
      campusId: CampusId;
      shiftId: ShiftId;
      nameBn: string;
      nameEn: string;
      capacity?: number | undefined;
      classTeacherId?: StaffId | undefined;
      actorId: PersonId;
    },
  ): Promise<SectionId> {
    const id = Ids.generate<'section'>();
    await tx.insert(section).values({
      id,
      classLevelId: input.classLevelId,
      campusId: input.campusId,
      shiftId: input.shiftId,
      nameBn: input.nameBn.normalize('NFC'),
      nameEn: input.nameEn,
      capacity: input.capacity ?? null,
      classTeacherId: input.classTeacherId ?? null,
      createdBy: input.actorId,
    });
    return id;
  },

  async sectionById(tx: Tx, id: SectionId) {
    const [row] = await tx
      .select({
        id: section.id,
        classLevelId: section.classLevelId,
        campusId: section.campusId,
        shiftId: section.shiftId,
        nameBn: section.nameBn,
        nameEn: section.nameEn,
        capacity: section.capacity,
        classTeacherId: section.classTeacherId,
      })
      .from(section)
      .where(and(eq(section.id, id), isNull(section.deletedAt)))
      .limit(1);
    return row;
  },

  async updateSection(
    tx: Tx,
    id: SectionId,
    patch: {
      nameBn?: string | undefined;
      nameEn?: string | undefined;
      capacity?: number | null | undefined;
      classTeacherId?: StaffId | null | undefined;
    },
    actorId: PersonId,
  ): Promise<void> {
    await tx
      .update(section)
      .set({
        ...(patch.nameBn !== undefined ? { nameBn: patch.nameBn.normalize('NFC') } : {}),
        ...(patch.nameEn !== undefined ? { nameEn: patch.nameEn } : {}),
        ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
        ...(patch.classTeacherId !== undefined ? { classTeacherId: patch.classTeacherId } : {}),
        updatedBy: actorId,
      })
      .where(eq(section.id, id));
  },

  /**
   * How many students are in a section right now.
   *
   * Resolves the school's CURRENT year from the section itself rather than
   * making the caller find it — a section knows its class level, which knows
   * its school. Doing it any other way needs a "the school" that a multi-school
   * tenant does not have.
   */
  async occupancyNow(tx: Tx, sectionId: SectionId): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(enrolment)
      .innerJoin(section, eq(section.id, enrolment.sectionId))
      .innerJoin(classLevel, eq(classLevel.id, section.classLevelId))
      .innerJoin(
        academicYear,
        and(
          eq(academicYear.id, enrolment.academicYearId),
          eq(academicYear.schoolId, classLevel.schoolId),
          eq(academicYear.isCurrent, true),
        ),
      )
      .where(and(eq(enrolment.sectionId, sectionId), isNull(enrolment.deletedAt)));
    return row?.n ?? 0;
  },

  async sectionsFor(tx: Tx, schoolId: SchoolId) {
    return tx
      .select({
        id: section.id,
        classLevelId: section.classLevelId,
        campusId: section.campusId,
        shiftId: section.shiftId,
        nameBn: section.nameBn,
        nameEn: section.nameEn,
        capacity: section.capacity,
        classTeacherId: section.classTeacherId,
      })
      .from(section)
      .innerJoin(classLevel, eq(classLevel.id, section.classLevelId))
      .where(and(eq(classLevel.schoolId, schoolId), isNull(section.deletedAt)))
      .orderBy(asc(classLevel.sequence), asc(section.nameEn));
  },

  async schoolSummary(tx: Tx, schoolId: SchoolId) {
    const [row] = await tx
      .select({
        id: school.id,
        nameBn: school.nameBn,
        nameEn: school.nameEn,
        eiin: school.eiin,
        fiscalYearStartMonth: school.fiscalYearStartMonth,
      })
      .from(school)
      .where(and(eq(school.id, schoolId), isNull(school.deletedAt)))
      .limit(1);
    return row;
  },
};
