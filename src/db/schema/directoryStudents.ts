/** Students, their lifecycle, guardians and siblings (migration 0008). */
import { boolean, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { instant, localDate, ulidCol } from '../types';
import { tenantColumns } from './columns';

export const student = pgTable('student', {
  ...tenantColumns<'student'>(),
  personId: ulidCol<'person'>('person_id').notNull(),
  /** School-visible. Separate from `id` because a ULID is unusable at a counter. */
  studentCode: text('student_code').notNull(),
  status: text('status', {
    enum: ['applicant', 'admitted', 'active', 'on_leave', 'withdrawn', 'alumni'],
  })
    .notNull()
    .default('applicant'),
  admittedOn: localDate('admitted_on'),
  withdrawnOn: localDate('withdrawn_on'),
  alumniOn: localDate('alumni_on'),
  house: text('house'),
  religion: text('religion'),
  bloodGroup: text('blood_group'),
  /** Cold cohort marker. Nothing is deleted — a transfer certificate may be
   *  requested a decade later (§10.8). */
  archivedAt: instant('archived_at'),
});

/** How the status column got its value. FR-4.1. */
export const studentStatusEvent = pgTable('student_status_event', {
  ...tenantColumns<'studentStatusEvent'>(),
  studentId: ulidCol<'student'>('student_id').notNull(),
  fromStatus: text('from_status', {
    enum: ['applicant', 'admitted', 'active', 'on_leave', 'withdrawn', 'alumni'],
  }),
  toStatus: text('to_status', {
    enum: ['applicant', 'admitted', 'active', 'on_leave', 'withdrawn', 'alumni'],
  }).notNull(),
  reason: text('reason'),
  effectiveDate: localDate('effective_date').notNull(),
  actorPersonId: ulidCol<'person'>('actor_person_id'),
});

/**
 * `isBillingGuardian` and `isPrimaryContact` are SEPARATE flags. Separated
 * parents: one may pay while the other is contacted, and `canReceiveResults`
 * covers custody arrangements.
 */
export const guardianLink = pgTable('guardian_link', {
  ...tenantColumns<'guardianLink'>(),
  guardianPersonId: ulidCol<'person'>('guardian_person_id').notNull(),
  studentId: ulidCol<'student'>('student_id').notNull(),
  relationship: text('relationship', {
    enum: ['father', 'mother', 'guardian', 'emergency', 'other'],
  }).notNull(),
  /** Who OWES. */
  isBillingGuardian: boolean('is_billing_guardian').notNull().default(false),
  /** Who is TOLD. */
  isPrimaryContact: boolean('is_primary_contact').notNull().default(false),
  canReceiveResults: boolean('can_receive_results').notNull().default(true),
  canCollectStudent: boolean('can_collect_student').notNull().default(true),
  sequence: integer('sequence').notNull().default(0),
});

/** Drives sibling discounts and SMS deduplication (FR-4.8, FR-9.4). */
export const siblingGroup = pgTable('sibling_group', {
  ...tenantColumns<'siblingGroup'>(),
});

export const siblingMember = pgTable('sibling_member', {
  ...tenantColumns<'siblingMember'>(),
  siblingGroupId: ulidCol<'siblingGroup'>('sibling_group_id').notNull(),
  studentId: ulidCol<'student'>('student_id').notNull(),
});
