-- 0008 — directory: students, guardians, staff, and the enrolment that ties
-- every piece of history to a point in time.
--
-- The load-bearing idea here is `enrolment`. A student is not "in Class 5,
-- Section A" — a student HAS AN ENROLMENT in Section A for 2027 and another in
-- Section B for 2028. Modelling section as an attribute of student destroys
-- last year's tabulation sheet the moment promotion runs.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

-- ── students ────────────────────────────────────────────────────────────────

CREATE TABLE student (
  id           uuid PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES person(id),
  -- School-visible identifier, generated from a per-school pattern. Separate
  -- from `id` because a ULID is unusable in conversation at a counter.
  student_code text NOT NULL,
  status       text NOT NULL DEFAULT 'applicant'
                 CHECK (status IN ('applicant','admitted','active','on_leave',
                                   'withdrawn','alumni')),
  admitted_on  date,
  withdrawn_on date,
  alumni_on    date,
  house        text,
  religion     text,
  blood_group  text,
  -- Cold cohort marker. Nothing is deleted: a transfer certificate may be
  -- requested a decade later (§10.8).
  archived_at  timestamptz
);
SELECT app.make_tenant_table('student');

ALTER TABLE student
  ADD CONSTRAINT student_person_unique UNIQUE (tenant_id, person_id),
  ADD CONSTRAINT student_code_unique   UNIQUE (tenant_id, student_code);
CREATE INDEX student_status_idx ON student (tenant_id, status)
  WHERE deleted_at IS NULL;

-- Every lifecycle transition, with actor and reason (FR-4.1). The status column
-- above is the current value; this is how it got there.
CREATE TABLE student_status_event (
  id              uuid PRIMARY KEY,
  student_id      uuid NOT NULL REFERENCES student(id),
  from_status     text,
  to_status       text NOT NULL,
  reason          text,
  effective_date  date NOT NULL,
  actor_person_id uuid REFERENCES person(id)
);
SELECT app.make_tenant_table('student_status_event');

CREATE INDEX student_status_event_idx
  ON student_status_event (tenant_id, student_id, effective_date DESC);

-- ── enrolment ───────────────────────────────────────────────────────────────

CREATE TABLE enrolment (
  id               uuid PRIMARY KEY,
  student_id       uuid NOT NULL REFERENCES student(id),
  section_id       uuid NOT NULL REFERENCES section(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  -- Roll number lives HERE, not on student: it is reassigned at every
  -- promotion, and putting it on the student erases last year's records.
  roll_no          integer CHECK (roll_no IS NULL OR roll_no > 0),
  enrolled_on      date NOT NULL,
  left_on          date,
  outcome          text CHECK (outcome IN ('promoted','retained','transferred',
                                           'withdrawn')),
  CONSTRAINT enrolment_left_after_enrolled
    CHECK (left_on IS NULL OR left_on >= enrolled_on)
);
SELECT app.make_tenant_table('enrolment');

-- The partial predicates matter: soft-deleting a student and re-admitting them
-- with the same roll number must not collide with the deleted row.
CREATE UNIQUE INDEX enrolment_roll_unique_idx
  ON enrolment (tenant_id, section_id, academic_year_id, roll_no)
  WHERE deleted_at IS NULL AND roll_no IS NOT NULL;

-- A student is enrolled in exactly one section per academic year.
CREATE UNIQUE INDEX enrolment_one_per_year_idx
  ON enrolment (tenant_id, student_id, academic_year_id)
  WHERE deleted_at IS NULL;

CREATE INDEX enrolment_section_idx ON enrolment (tenant_id, section_id, academic_year_id);
CREATE INDEX enrolment_student_idx ON enrolment (tenant_id, student_id);

-- ── guardians ───────────────────────────────────────────────────────────────

/*
 * Guardian relationships.
 *
 * `is_billing_guardian` and `is_primary_contact` are SEPARATE columns.
 * Separated parents are common enough to design for: one may pay while the
 * other is contacted, and `can_receive_results` covers custody arrangements
 * where a child's results must not go to both households.
 *
 * A single "primary guardian" flag forces a wrong answer for a real family.
 */
CREATE TABLE guardian_link (
  id                  uuid PRIMARY KEY,
  guardian_person_id  uuid NOT NULL REFERENCES person(id),
  student_id          uuid NOT NULL REFERENCES student(id),
  relationship        text NOT NULL
                        CHECK (relationship IN ('father','mother','guardian',
                                                'emergency','other')),
  is_billing_guardian boolean NOT NULL DEFAULT false,   -- who OWES
  is_primary_contact  boolean NOT NULL DEFAULT false,   -- who is TOLD
  can_receive_results boolean NOT NULL DEFAULT true,
  can_collect_student boolean NOT NULL DEFAULT true,
  sequence            integer NOT NULL DEFAULT 0
);
SELECT app.make_tenant_table('guardian_link');

ALTER TABLE guardian_link
  ADD CONSTRAINT guardian_link_unique
  UNIQUE (tenant_id, student_id, guardian_person_id);

-- At most one of each per student. Two billing guardians means an ambiguous
-- invoice; two primary contacts means duplicate SMS to one family.
CREATE UNIQUE INDEX guardian_link_one_billing_idx
  ON guardian_link (tenant_id, student_id)
  WHERE is_billing_guardian AND deleted_at IS NULL;
CREATE UNIQUE INDEX guardian_link_one_primary_idx
  ON guardian_link (tenant_id, student_id)
  WHERE is_primary_contact AND deleted_at IS NULL;

-- Every guardian query joins through this table, which is what makes it
-- impossible for a guardian to address another family's child (§8.7).
CREATE INDEX guardian_link_guardian_idx
  ON guardian_link (tenant_id, guardian_person_id);

-- Drives sibling discounts and SMS deduplication: two absent siblings sharing
-- one guardian phone must produce ONE message (FR-4.8, FR-9.4).
CREATE TABLE sibling_group (
  id uuid PRIMARY KEY
);
SELECT app.make_tenant_table('sibling_group');

CREATE TABLE sibling_member (
  id               uuid PRIMARY KEY,
  sibling_group_id uuid NOT NULL REFERENCES sibling_group(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES student(id)
);
SELECT app.make_tenant_table('sibling_member');

-- A student belongs to one group, or a sibling discount could be applied twice.
ALTER TABLE sibling_member
  ADD CONSTRAINT sibling_member_one_group UNIQUE (tenant_id, student_id);
CREATE INDEX sibling_member_group_idx ON sibling_member (tenant_id, sibling_group_id);

-- ── staff ───────────────────────────────────────────────────────────────────

CREATE TABLE staff (
  id            uuid PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES person(id),
  employee_code text NOT NULL,
  designation   text,
  department    text,
  joined_on     date,
  left_on       date,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','on_leave','left'))
);
SELECT app.make_tenant_table('staff');

ALTER TABLE staff
  ADD CONSTRAINT staff_person_unique   UNIQUE (tenant_id, person_id),
  ADD CONSTRAINT staff_employee_unique UNIQUE (tenant_id, employee_code);

-- The FK deferred from 0007: `section` is created before `staff` exists.
ALTER TABLE section
  ADD CONSTRAINT section_class_teacher_fk
  FOREIGN KEY (class_teacher_id) REFERENCES staff(id);

CREATE TABLE staff_section_assignment (
  id               uuid PRIMARY KEY,
  staff_id         uuid NOT NULL REFERENCES staff(id),
  section_id       uuid NOT NULL REFERENCES section(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  role             text NOT NULL CHECK (role IN ('class_teacher','assistant'))
);
SELECT app.make_tenant_table('staff_section_assignment');

ALTER TABLE staff_section_assignment
  ADD CONSTRAINT staff_section_unique
  UNIQUE (tenant_id, staff_id, section_id, academic_year_id, role);
CREATE INDEX staff_section_by_section_idx
  ON staff_section_assignment (tenant_id, section_id, academic_year_id);

/*
 * The (section, subject) PAIR is the unit of a subject teacher's scope.
 *
 * A teacher may teach Mathematics in 6A and nothing else in 6A, so scope is a
 * pair filter rather than a cross product of sections × subjects (§9.3).
 */
CREATE TABLE staff_subject_assignment (
  id               uuid PRIMARY KEY,
  staff_id         uuid NOT NULL REFERENCES staff(id),
  section_id       uuid NOT NULL REFERENCES section(id),
  -- FK added in 3c with the academics module; `subject` does not exist yet.
  subject_id       uuid NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_year(id)
);
SELECT app.make_tenant_table('staff_subject_assignment');

ALTER TABLE staff_subject_assignment
  ADD CONSTRAINT staff_subject_unique
  UNIQUE (tenant_id, staff_id, section_id, subject_id, academic_year_id);
CREATE INDEX staff_subject_by_section_idx
  ON staff_subject_assignment (tenant_id, section_id, academic_year_id);

-- ── documents ───────────────────────────────────────────────────────────────

/*
 * Birth certificates, photos, transcripts. Personal data about children, so the
 * bytes live in private object storage and only the key is stored here —
 * never a public URL. Authorization is checked BEFORE a URL is signed
 * (invariant 13).
 *
 * `owner_type` + `owner_id` is a deliberate polymorphic reference: a document
 * belongs to a person, a student, a staff member or the school, and four
 * nullable FK columns would be worse. Referential integrity for it is enforced
 * in the application, which is the accepted cost.
 */
CREATE TABLE document (
  id          uuid PRIMARY KEY,
  owner_type  text NOT NULL
                CHECK (owner_type IN ('person','student','staff','school')),
  owner_id    uuid NOT NULL,
  doc_type    text NOT NULL,
  storage_key text NOT NULL,
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0),
  issued_on   date,
  expires_on  date,
  verified_at timestamptz,
  verified_by uuid REFERENCES person(id)
);
SELECT app.make_tenant_table('document');

CREATE INDEX document_owner_idx ON document (tenant_id, owner_type, owner_id);
CREATE INDEX document_expiry_idx ON document (tenant_id, expires_on)
  WHERE expires_on IS NOT NULL AND deleted_at IS NULL;
