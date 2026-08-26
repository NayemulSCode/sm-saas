/** Directory tables (migrations 0005, 0008). All tenant-owned, all RLS. */
import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { localDate, ulidCol } from '../types';
import { tenantColumns } from './columns';


/**
 * A human, as known to ONE school. All personal data lives here, behind RLS —
 * which is the deliberate consequence of keeping `account` thin (§7.7).
 *
 * name_bn and name_en are BOTH real and both required: the report card prints
 * one, the board registration list needs the other, and neither is a
 * translation of the other (ADR-0019).
 */
export const person = pgTable('person', {
  ...tenantColumns<'person'>(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  dateOfBirth: localDate('date_of_birth'),
  gender: text('gender', { enum: ['male', 'female', 'other'] }),
  photoKey: text('photo_key'),
  /** CONTACT detail — deliberately NOT unique. The login identifier lives on
   *  credential.value and is globally unique. */
  phone: text('phone'),
  email: text('email'),
  birthRegNo: text('birth_reg_no'),
  address: jsonb('address').notNull().default({}),
  mergedIntoPersonId: ulidCol<'person'>('merged_into_person_id'),
});

/**
 * A member of staff. One row per person who works at the school.
 *
 * Defined here rather than in the structure module because it belongs to
 * `directory` — structure only reads it, to resolve a section's class teacher.
 */
export const staff = pgTable('staff', {
  ...tenantColumns<'staff'>(),
  personId: ulidCol<'person'>('person_id').notNull(),
  employeeCode: text('employee_code').notNull(),
  designation: text('designation'),
  department: text('department'),
  joinedOn: localDate('joined_on'),
  leftOn: localDate('left_on'),
  status: text('status', { enum: ['active', 'on_leave', 'left'] })
    .notNull()
    .default('active'),
});

/**
 * Student × section × academic year — the join all history hangs from.
 *
 * Roll number lives HERE, not on the student: it is reassigned at every
 * promotion, and putting it on the student erases last year's records.
 */
export const enrolment = pgTable('enrolment', {
  ...tenantColumns<'enrolment'>(),
  studentId: ulidCol<'student'>('student_id').notNull(),
  sectionId: ulidCol<'section'>('section_id').notNull(),
  academicYearId: ulidCol<'academicYear'>('academic_year_id').notNull(),
  rollNo: integer('roll_no'),
  enrolledOn: localDate('enrolled_on').notNull(),
  leftOn: localDate('left_on'),
  /** Which promotion run created this row, so undo finds exactly those. */
  promotionBatchId: ulidCol<'promotionBatch'>('promotion_batch_id'),
  outcome: text('outcome', {
    enum: ['promoted', 'retained', 'transferred', 'withdrawn'],
  }),
});
