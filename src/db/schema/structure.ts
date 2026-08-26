/**
 * Structure tables (migration 0007). All tenant-owned, all RLS.
 *
 * SQL migrations are the source of truth; these mirror them for typed access.
 */

import { boolean, index, integer, jsonb, pgTable, text, time, uniqueIndex } from 'drizzle-orm/pg-core';
import { localDate, ulidCol } from '../types';
import { tenantColumns } from './columns';

/** A group of schools under one owner. Most tenants have exactly one. */
export const organization = pgTable('organization', {
  ...tenantColumns<'organization'>(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  ownerPersonId: ulidCol<'person'>('owner_person_id'),
});

export const school = pgTable(
  'school',
  {
    ...tenantColumns<'school'>(),
    organizationId: ulidCol<'organization'>('organization_id'),
    nameBn: text('name_bn').notNull(),
    nameEn: text('name_en').notNull(),
    /** Government institution id. Optional: a new school may not have one. */
    eiin: text('eiin'),
    address: jsonb('address').notNull().default({}),
    contact: jsonb('contact').notNull().default({}),
    /** An R2 object key, never a URL. */
    logoKey: text('logo_key'),
    settings: jsonb('settings').notNull().default({}),
    /** Receipt numbers are gapless per school per FISCAL year, and schools
     *  differ on whether that starts in January or July. */
    fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
  },
  (t) => [index('school_tenant_org_idx').on(t.tenantId, t.organizationId)],
);

export const campus = pgTable(
  'campus',
  {
    ...tenantColumns<'campus'>(),
    schoolId: ulidCol<'school'>('school_id').notNull(),
    nameBn: text('name_bn').notNull(),
    nameEn: text('name_en').notNull(),
    address: jsonb('address').notNull().default({}),
    /** Exactly one per school, enforced by a partial unique index. */
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => [index('campus_school_idx').on(t.tenantId, t.schoolId)],
);

/**
 * A first-class entity, not an attribute of section. Morning and day shifts
 * have their own timetables, weekly-off patterns and working-day calendars.
 */
export const shift = pgTable(
  'shift',
  {
    ...tenantColumns<'shift'>(),
    campusId: ulidCol<'campus'>('campus_id').notNull(),
    nameBn: text('name_bn').notNull(),
    nameEn: text('name_en').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    sequence: integer('sequence').notNull(),
  },
  (t) => [uniqueIndex('shift_sequence_unique').on(t.tenantId, t.campusId, t.sequence)],
);

export const academicYear = pgTable(
  'academic_year',
  {
    ...tenantColumns<'academicYear'>(),
    schoolId: ulidCol<'school'>('school_id').notNull(),
    /** '2027' — a label, not a date. */
    name: text('name').notNull(),
    startDate: localDate('start_date').notNull(),
    endDate: localDate('end_date').notNull(),
    /** Exactly one per school, enforced by the database: every module reads
     *  "the current year" and two of them would corrupt every query. */
    isCurrent: boolean('is_current').notNull().default(false),
    status: text('status', { enum: ['planning', 'active', 'closed'] })
      .notNull()
      .default('planning'),
  },
  (t) => [uniqueIndex('academic_year_name_unique').on(t.tenantId, t.schoolId, t.name)],
);

export const term = pgTable(
  'term',
  {
    ...tenantColumns<'term'>(),
    academicYearId: ulidCol<'academicYear'>('academic_year_id').notNull(),
    nameBn: text('name_bn').notNull(),
    nameEn: text('name_en').notNull(),
    sequence: integer('sequence').notNull(),
    startDate: localDate('start_date').notNull(),
    endDate: localDate('end_date').notNull(),
  },
  (t) => [uniqueIndex('term_sequence_unique').on(t.tenantId, t.academicYearId, t.sequence)],
);

/**
 * Arbitrary class naming: Play, Nursery, KG, Class 1–10, or whatever a school
 * uses. `sequence` carries promotion order, so adding 'Pre-Nursery' is a row
 * and a renumber, never a code change.
 */
export const classLevel = pgTable(
  'class_level',
  {
    ...tenantColumns<'classLevel'>(),
    schoolId: ulidCol<'school'>('school_id').notNull(),
    nameBn: text('name_bn').notNull(),
    nameEn: text('name_en').notNull(),
    sequence: integer('sequence').notNull(),
    medium: text('medium', { enum: ['bangla', 'english', 'other'] }),
    curriculumId: ulidCol<'curriculum'>('curriculum_id'),
    /** Kindergarten students have no login at all (FR-2.6). */
    loginEnabled: boolean('login_enabled').notNull().default(false),
  },
  (t) => [uniqueIndex('class_level_sequence_unique').on(t.tenantId, t.schoolId, t.sequence)],
);

export const section = pgTable(
  'section',
  {
    ...tenantColumns<'section'>(),
    classLevelId: ulidCol<'classLevel'>('class_level_id').notNull(),
    campusId: ulidCol<'campus'>('campus_id').notNull(),
    /** Required: a section without a shift is unschedulable. */
    shiftId: ulidCol<'shift'>('shift_id').notNull(),
    nameBn: text('name_bn').notNull(),
    nameEn: text('name_en').notNull(),
    capacity: integer('capacity'),
    classTeacherId: ulidCol<'staff'>('class_teacher_id'),
  },
  (t) => [index('section_campus_shift_idx').on(t.tenantId, t.campusId, t.shiftId)],
);
