# 4. Schema — structure and directory

All `[T]`. The standard column set from [§3.1](03-schema-platform-identity.md) is
implied and shown as `-- + std`.

## 4.1 Structure

```sql
CREATE TABLE organization (
  -- + std
  name_bn         text NOT NULL,
  name_en         text NOT NULL,
  owner_person_id uuid REFERENCES person(id)
);
ALTER TABLE tenant ADD CONSTRAINT tenant_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organization(id);

CREATE TABLE school (
  -- + std
  organization_id uuid REFERENCES organization(id),
  name_bn         text NOT NULL,
  name_en         text NOT NULL,
  eiin            text,                        -- government institution id
  address         jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact         jsonb NOT NULL DEFAULT '{}'::jsonb,
  logo_key        text,                        -- R2 object key
  -- Per-school behaviour that is genuinely configurable. Validated by a Zod
  -- schema in the application; jsonb here so adding a setting is not a migration.
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  fiscal_year_start_month smallint NOT NULL DEFAULT 1
                    CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  UNIQUE (tenant_id, eiin)                     -- NULLs allowed and repeatable
);

CREATE TABLE campus (
  -- + std
  school_id  uuid NOT NULL REFERENCES school(id),
  name_bn    text NOT NULL,
  name_en    text NOT NULL,
  address    jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_primary boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX ON campus (tenant_id, school_id)
  WHERE is_primary AND deleted_at IS NULL;

-- A shift is a FIRST-CLASS entity, not an attribute of section. It has its own
-- timetable, its own weekly-off pattern and its own working-day calendar.
-- Modelling it as a column makes §5.16 unimplementable.
CREATE TABLE shift (
  -- + std
  campus_id  uuid NOT NULL REFERENCES campus(id),
  name_bn    text NOT NULL,
  name_en    text NOT NULL,
  start_time time NOT NULL,
  end_time   time NOT NULL CHECK (end_time > start_time),
  sequence   integer NOT NULL,
  UNIQUE (tenant_id, campus_id, sequence)
);

CREATE TABLE academic_year (
  -- + std
  school_id  uuid NOT NULL REFERENCES school(id),
  name       text NOT NULL,                    -- '2027'
  start_date date NOT NULL,
  end_date   date NOT NULL CHECK (end_date > start_date),
  is_current boolean NOT NULL DEFAULT false,
  status     text NOT NULL DEFAULT 'planning'
               CHECK (status IN ('planning','active','closed')),
  UNIQUE (tenant_id, school_id, name)
);
-- Exactly one current year per school. Invariant enforced by the DATABASE,
-- because "the current year" is read by every other module.
CREATE UNIQUE INDEX ON academic_year (tenant_id, school_id)
  WHERE is_current AND deleted_at IS NULL;

CREATE TABLE term (
  -- + std
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  name_bn    text NOT NULL,
  name_en    text NOT NULL,
  sequence   integer NOT NULL,
  start_date date NOT NULL,
  end_date   date NOT NULL CHECK (end_date > start_date),
  UNIQUE (tenant_id, academic_year_id, sequence)
);

-- Arbitrary class naming: 'Play', 'Nursery', 'KG', 'Class 1'…
-- `sequence` carries promotion order, so inserting 'Pre-Nursery' is a row,
-- not a code change.
CREATE TABLE class_level (
  -- + std
  school_id     uuid NOT NULL REFERENCES school(id),
  name_bn       text NOT NULL,
  name_en       text NOT NULL,
  sequence      integer NOT NULL,
  medium        text CHECK (medium IN ('bangla','english','other')),
  curriculum_id uuid,                          -- FK added with academics module
  -- Below this class level, students get no login at all (FR-2.6).
  login_enabled boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, school_id, sequence)
);

CREATE TABLE section (
  -- + std
  class_level_id   uuid NOT NULL REFERENCES class_level(id),
  campus_id        uuid NOT NULL REFERENCES campus(id),
  shift_id         uuid NOT NULL REFERENCES shift(id),
  name_bn          text NOT NULL,
  name_en          text NOT NULL,
  capacity         integer CHECK (capacity IS NULL OR capacity > 0),
  class_teacher_id uuid REFERENCES staff(id),
  UNIQUE (tenant_id, class_level_id, shift_id, name_en)
);
CREATE INDEX ON section (tenant_id, campus_id, shift_id);
CREATE INDEX ON section (tenant_id, class_level_id);
```

## 4.2 Directory — the person and their people

```sql
-- A human, as known to ONE school. Never shared across tenants; all PII lives
-- here, behind RLS (§7.7).
CREATE TABLE person (
  -- + std
  -- BOTH are real and NOT NULL. Not translations of each other: the report card
  -- prints one, the board registration list needs the other (ADR-0019).
  name_bn        text NOT NULL CHECK (length(btrim(name_bn)) > 0),
  name_en        text NOT NULL CHECK (length(btrim(name_en)) > 0),
  date_of_birth  date,
  gender         text CHECK (gender IN ('male','female','other')),
  photo_key      text,
  -- CONTACT details — deliberately NOT unique. The login identifier lives on
  -- credential.value and is globally unique. Different columns, different
  -- tables, different meanings (ADR-0006).
  phone          text,
  email          text,
  national_id_enc bytea,                       -- app-level encryption (NFR §4.6)
  birth_reg_no   text,
  address        jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_into_person_id uuid REFERENCES person(id),   -- §8.6, loser of a merge
  CHECK (phone IS NULL OR phone ~ '^\+8801[3-9][0-9]{8}$')
);
-- Names are NFC-normalised on write by the application (ADR-0019). Trigram
-- indexes are built AFTER normalisation or they encode the inconsistency.
CREATE INDEX ON person USING gin (name_bn gin_trgm_ops);
CREATE INDEX ON person USING gin (name_en gin_trgm_ops);
CREATE INDEX ON person (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX ON person (tenant_id, birth_reg_no) WHERE birth_reg_no IS NOT NULL;
CREATE INDEX ON person (tenant_id, date_of_birth);
CREATE INDEX ON person (merged_into_person_id) WHERE merged_into_person_id IS NOT NULL;

CREATE TABLE student (
  -- + std
  person_id    uuid NOT NULL REFERENCES person(id),
  student_code text NOT NULL,                  -- school-visible, per-school pattern
  status       text NOT NULL DEFAULT 'applicant'
                 CHECK (status IN ('applicant','admitted','active','on_leave',
                                   'withdrawn','alumni')),
  admitted_on  date,
  withdrawn_on date,
  alumni_on    date,
  house        text,
  religion     text,
  blood_group  text,
  archived_at  timestamptz,                    -- cold cohort marker (§10.8)
  UNIQUE (tenant_id, person_id),
  UNIQUE (tenant_id, student_code)
);
CREATE INDEX ON student (tenant_id, status) WHERE deleted_at IS NULL;

-- Every lifecycle transition, with actor and reason (FR-4.1).
CREATE TABLE student_status_event (
  -- + std
  student_id      uuid NOT NULL REFERENCES student(id),
  from_status     text,
  to_status       text NOT NULL,
  reason          text,
  effective_date  date NOT NULL,
  actor_person_id uuid REFERENCES person(id)
);
CREATE INDEX ON student_status_event (tenant_id, student_id, effective_date DESC);

-- THE join all history hangs from. A student is not "in Class 5A"; a student
-- HAS AN ENROLMENT in 5A for 2027. Modelling section as an attribute of student
-- destroys last year's tabulation the moment promotion runs.
CREATE TABLE enrolment (
  -- + std
  student_id       uuid NOT NULL REFERENCES student(id),
  section_id       uuid NOT NULL REFERENCES section(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  -- Roll number lives HERE, not on student. It is reassigned every promotion.
  roll_no          integer CHECK (roll_no IS NULL OR roll_no > 0),
  enrolled_on      date NOT NULL,
  left_on          date,
  outcome          text CHECK (outcome IN ('promoted','retained','transferred',
                                           'withdrawn')),
  CHECK (left_on IS NULL OR left_on >= enrolled_on)
);
-- Partial predicates matter: soft-deleting a student and re-admitting them with
-- the same roll number must not violate the constraint.
CREATE UNIQUE INDEX ON enrolment (tenant_id, section_id, academic_year_id, roll_no)
  WHERE deleted_at IS NULL AND roll_no IS NOT NULL;
CREATE UNIQUE INDEX ON enrolment (tenant_id, student_id, academic_year_id)
  WHERE deleted_at IS NULL;
CREATE INDEX ON enrolment (tenant_id, section_id, academic_year_id);
CREATE INDEX ON enrolment (tenant_id, student_id);

-- Guardian relationships. The two flags are SEPARATE columns: separated parents
-- are common, and one may pay while the other is contacted (§11.4).
CREATE TABLE guardian_link (
  -- + std
  guardian_person_id  uuid NOT NULL REFERENCES person(id),
  student_id          uuid NOT NULL REFERENCES student(id),
  relationship        text NOT NULL
                        CHECK (relationship IN ('father','mother','guardian',
                                                'emergency','other')),
  is_billing_guardian boolean NOT NULL DEFAULT false,   -- who OWES
  is_primary_contact  boolean NOT NULL DEFAULT false,   -- who is TOLD
  can_receive_results boolean NOT NULL DEFAULT true,    -- custody arrangements
  can_collect_student boolean NOT NULL DEFAULT true,
  sequence            integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, student_id, guardian_person_id)
);
CREATE UNIQUE INDEX ON guardian_link (tenant_id, student_id)
  WHERE is_billing_guardian AND deleted_at IS NULL;
CREATE UNIQUE INDEX ON guardian_link (tenant_id, student_id)
  WHERE is_primary_contact AND deleted_at IS NULL;
CREATE INDEX ON guardian_link (tenant_id, guardian_person_id);

-- Drives sibling discounts and SMS deduplication (FR-4.8, FR-9.4).
CREATE TABLE sibling_group ( -- + std
);
CREATE TABLE sibling_member (
  -- + std
  sibling_group_id uuid NOT NULL REFERENCES sibling_group(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES student(id),
  UNIQUE (tenant_id, student_id)               -- a student is in one group
);

CREATE TABLE staff (
  -- + std
  person_id     uuid NOT NULL REFERENCES person(id),
  employee_code text NOT NULL,
  designation   text,
  department    text,
  joined_on     date,
  left_on       date,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','on_leave','left')),
  UNIQUE (tenant_id, person_id),
  UNIQUE (tenant_id, employee_code)
);

CREATE TABLE staff_section_assignment (
  -- + std
  staff_id         uuid NOT NULL REFERENCES staff(id),
  section_id       uuid NOT NULL REFERENCES section(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  role             text NOT NULL
                     CHECK (role IN ('class_teacher','assistant')),
  UNIQUE (tenant_id, staff_id, section_id, academic_year_id, role)
);
CREATE INDEX ON staff_section_assignment (tenant_id, section_id, academic_year_id);

-- The (section, subject) PAIR matters: a teacher may teach Mathematics in 6A
-- and nothing else in 6A (§8.5).
CREATE TABLE staff_subject_assignment (
  -- + std
  staff_id         uuid NOT NULL REFERENCES staff(id),
  section_id       uuid NOT NULL REFERENCES section(id),
  subject_id       uuid NOT NULL,              -- FK added with academics
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  UNIQUE (tenant_id, staff_id, section_id, subject_id, academic_year_id)
);

CREATE TABLE document (
  -- + std
  owner_type   text NOT NULL
                 CHECK (owner_type IN ('person','student','staff','school')),
  owner_id     uuid NOT NULL,
  doc_type     text NOT NULL,
  storage_key  text NOT NULL,                  -- R2 key, never a public URL
  mime         text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  issued_on    date,
  expires_on   date,
  verified_at  timestamptz,
  verified_by  uuid REFERENCES person(id)
);
CREATE INDEX ON document (tenant_id, owner_type, owner_id);
```

## 4.3 Constraints that encode a domain rule

Worth listing separately, because each one is a bug that would otherwise be
found in production.

| Constraint | Prevents |
|---|---|
| `academic_year` partial unique on `is_current` | Two current years, which silently corrupts every "this year" query |
| `enrolment` unique `(section, year, roll_no)` **partial on `deleted_at IS NULL`** | Roll collisions, while still allowing re-admission with the same roll |
| `enrolment` unique `(student, year)` | A student enrolled in two sections in one year |
| `guardian_link` partial unique on `is_billing_guardian` | Two guardians billed for one child |
| `guardian_link` partial unique on `is_primary_contact` | Duplicate SMS to one family |
| `credential` unique `(kind, value)` | Two logins on one phone |
| `membership` unique `(tenant, person)` | One person with two logins in a school |
| `sibling_member` unique `(tenant, student)` | A student in two sibling groups, double-discounted |
| `campus` partial unique on `is_primary` | Ambiguous default campus |
| `person` `NOT NULL` on both names | A report card with a blank Bangla name |
| E.164 `CHECK` on phone columns | Unnormalised numbers defeating dedup and OTP lookup |

## 4.4 Deferred to later phases

Not in the 3a migration set; listed so the FK stubs above are understood:

| Column | Resolved in |
|---|---|
| `class_level.curriculum_id` | 3c — academics |
| `staff_subject_assignment.subject_id` | 3c — academics |
| `section.class_teacher_id` → `staff` | 3a (staff exists), FK added after `staff` |

`subject_id` is `uuid NOT NULL` with **no FK** until the academics module lands.
That is deliberate and recorded here so it is not mistaken for an oversight; the
FK is added by the 3c migration.
