-- 0007 — school structure.
--
-- `Organization → School → Campus → Shift` and
-- `Class level → Section`, with the academic year scoping almost everything.
--
-- Nothing here hardcodes a Bangladeshi convention: class names are rows,
-- weekends are configuration, and the hierarchy takes a new level by adding a
-- table rather than reshaping one (§4 of the brief).

SET lock_timeout = '3s';
SET statement_timeout = '5min';

-- ── organization and school ─────────────────────────────────────────────────

CREATE TABLE organization (
  id              uuid PRIMARY KEY,
  name_bn         text NOT NULL,
  name_en         text NOT NULL,
  owner_person_id uuid REFERENCES person(id)
);
SELECT app.make_tenant_table('organization');

-- The FK deferred from 0003: `tenant` is platform-scoped and is created before
-- any tenant-owned table can exist, so it could not reference organization then.
ALTER TABLE tenant
  ADD CONSTRAINT tenant_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organization(id);

CREATE TABLE school (
  id              uuid PRIMARY KEY,
  organization_id uuid REFERENCES organization(id),
  name_bn         text NOT NULL,
  name_en         text NOT NULL,
  eiin            text,                       -- government institution id
  address         jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact         jsonb NOT NULL DEFAULT '{}'::jsonb,
  logo_key        text,                       -- R2 object key, never a URL
  -- Per-school behaviour that is genuinely configurable. Validated by Zod in
  -- the application; jsonb here so adding a setting is not a migration.
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Receipt numbering is gapless per school per FISCAL year, and schools differ
  -- on whether that is the academic year (Jan) or the government one (Jul).
  fiscal_year_start_month smallint NOT NULL DEFAULT 1
                    CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
);
SELECT app.make_tenant_table('school');

CREATE INDEX school_tenant_org_idx ON school (tenant_id, organization_id);
-- EIIN is unique per tenant where present; NULLs repeat freely.
CREATE UNIQUE INDEX school_eiin_idx ON school (tenant_id, eiin)
  WHERE eiin IS NOT NULL AND deleted_at IS NULL;

-- ── campus and shift ────────────────────────────────────────────────────────

CREATE TABLE campus (
  id         uuid PRIMARY KEY,
  school_id  uuid NOT NULL REFERENCES school(id),
  name_bn    text NOT NULL,
  name_en    text NOT NULL,
  address    jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_primary boolean NOT NULL DEFAULT false
);
SELECT app.make_tenant_table('campus');

CREATE INDEX campus_school_idx ON campus (tenant_id, school_id);
-- Exactly one default campus per school, or "the campus" is ambiguous.
CREATE UNIQUE INDEX campus_one_primary_idx ON campus (tenant_id, school_id)
  WHERE is_primary AND deleted_at IS NULL;

/*
 * A shift is a FIRST-CLASS entity, not an attribute of section.
 *
 * Morning and day shifts have their own timetables, their own weekly-off
 * patterns and their own working-day calendars. Modelling this as a column
 * makes the calendar engine (§5.16) unimplementable.
 */
CREATE TABLE shift (
  id         uuid PRIMARY KEY,
  campus_id  uuid NOT NULL REFERENCES campus(id),
  name_bn    text NOT NULL,
  name_en    text NOT NULL,
  start_time time NOT NULL,
  end_time   time NOT NULL CHECK (end_time > start_time),
  sequence   integer NOT NULL
);
SELECT app.make_tenant_table('shift');

ALTER TABLE shift
  ADD CONSTRAINT shift_sequence_unique UNIQUE (tenant_id, campus_id, sequence);

-- ── academic year and term ──────────────────────────────────────────────────

CREATE TABLE academic_year (
  id         uuid PRIMARY KEY,
  school_id  uuid NOT NULL REFERENCES school(id),
  name       text NOT NULL,                   -- '2027'
  start_date date NOT NULL,
  end_date   date NOT NULL CHECK (end_date > start_date),
  is_current boolean NOT NULL DEFAULT false,
  status     text NOT NULL DEFAULT 'planning'
               CHECK (status IN ('planning','active','closed'))
);
SELECT app.make_tenant_table('academic_year');

ALTER TABLE academic_year
  ADD CONSTRAINT academic_year_name_unique UNIQUE (tenant_id, school_id, name);

/*
 * Exactly ONE current year per school, enforced by the database rather than by
 * the application, because "the current year" is read by every other module and
 * two of them would silently corrupt every "this year" query.
 */
CREATE UNIQUE INDEX academic_year_one_current_idx
  ON academic_year (tenant_id, school_id)
  WHERE is_current AND deleted_at IS NULL;

CREATE TABLE term (
  id               uuid PRIMARY KEY,
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  name_bn          text NOT NULL,
  name_en          text NOT NULL,
  sequence         integer NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL CHECK (end_date > start_date)
);
SELECT app.make_tenant_table('term');

ALTER TABLE term
  ADD CONSTRAINT term_sequence_unique UNIQUE (tenant_id, academic_year_id, sequence);

-- ── class levels and sections ───────────────────────────────────────────────

/*
 * Arbitrary class naming: Play, Nursery, KG, Class 1–10, or anything a school
 * uses. `sequence` carries promotion order, so inserting 'Pre-Nursery' is a row
 * and a renumber — never a code change.
 */
CREATE TABLE class_level (
  id            uuid PRIMARY KEY,
  school_id     uuid NOT NULL REFERENCES school(id),
  name_bn       text NOT NULL,
  name_en       text NOT NULL,
  sequence      integer NOT NULL,
  medium        text CHECK (medium IN ('bangla','english','other')),
  -- FK added in 3c with the academics module; declared now because promotion
  -- and subject mapping both read it.
  curriculum_id uuid,
  -- Kindergarten students have no login at all (FR-2.6).
  login_enabled boolean NOT NULL DEFAULT false
);
SELECT app.make_tenant_table('class_level');

ALTER TABLE class_level
  ADD CONSTRAINT class_level_sequence_unique UNIQUE (tenant_id, school_id, sequence);

CREATE TABLE section (
  id               uuid PRIMARY KEY,
  class_level_id   uuid NOT NULL REFERENCES class_level(id),
  campus_id        uuid NOT NULL REFERENCES campus(id),
  -- Required: a section without a shift is unschedulable, and the working-day
  -- calendar is keyed by (campus, shift).
  shift_id         uuid NOT NULL REFERENCES shift(id),
  name_bn          text NOT NULL,
  name_en          text NOT NULL,
  capacity         integer CHECK (capacity IS NULL OR capacity > 0),
  -- FK to staff is added in 0008; staff does not exist yet.
  class_teacher_id uuid
);
SELECT app.make_tenant_table('section');

ALTER TABLE section
  ADD CONSTRAINT section_name_unique
  UNIQUE (tenant_id, class_level_id, shift_id, name_en);

CREATE INDEX section_campus_shift_idx ON section (tenant_id, campus_id, shift_id);
CREATE INDEX section_class_level_idx  ON section (tenant_id, class_level_id);
