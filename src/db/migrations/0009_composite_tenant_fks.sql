-- 0009 — composite tenant foreign keys.
--
-- THE PROBLEM
--
-- PostgreSQL performs foreign-key checks with the privileges of the REFERENCED
-- table's owner and does not apply row-level security to them. A single-column
-- FK between two tenant-owned tables is therefore satisfied by a row in ANY
-- tenant: an `enrolment` in tenant A can reference a `section` in tenant B.
--
-- Reads do not leak — the join is RLS-filtered and yields nothing — so this is
-- an integrity hole rather than a disclosure one. But invariant 3 says
-- cross-tenant isolation is STRUCTURAL, and a rule enforced only by the
-- application is not structural.
--
-- THE FIX
--
-- Carry the tenant in the key:
--     UNIQUE (tenant_id, id)                       on the referenced table
--     FOREIGN KEY (tenant_id, child_col)           on the child
--         REFERENCES parent (tenant_id, id)
--
-- The FK check now looks for (tenant_id, id) and cannot match another tenant's
-- row, because the child's own tenant_id is part of the lookup — and that
-- column is already pinned by the RLS WITH CHECK policy.
--
-- SCOPE — domain references only
--
-- The audit columns added by app.add_tenant_columns (created_by, updated_by,
-- deleted_by) and similar bookkeeping references (verified_by,
-- actor_person_id) keep their simple FKs. They are written by the framework
-- from ctx.personId, which is derived from a verified membership in the ACTIVE
-- tenant and cannot come from request input. Domain references are set FROM
-- request payloads — a section id, a student id — which is exactly where a
-- cross-tenant value could be injected. That is the line, and it is drawn on
-- where the value originates rather than on convenience.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

-- ── helpers ─────────────────────────────────────────────────────────────────

/* Every tenant-owned table that is referenced needs (tenant_id, id) unique.
 * `id` is already the primary key, so this adds no real constraint — it exists
 * to give the composite FK something to point at. */
CREATE OR REPLACE FUNCTION app.add_tenant_id_unique(target regclass) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  tbl  text := target::text;
  cname text := replace(tbl, '.', '_') || '_tenant_id_key';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = target AND conname = cname
  ) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (tenant_id, id)', tbl, cname);
  END IF;
END $$;

/*
 * Replaces a single-column FK with a composite one carrying tenant_id.
 *
 * The existing constraint is found in pg_constraint by (child, parent, column)
 * rather than by name, because PostgreSQL auto-names them and the generated
 * names are not stable enough to hard-code across a schema this size.
 */
CREATE OR REPLACE FUNCTION app.tenantize_fk(
  child      regclass,
  child_col  text,
  parent     regclass,
  on_delete  text DEFAULT 'NO ACTION'
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  old_name text;
  new_name text := replace(child::text, '.', '_') || '_' || child_col || '_tenant_fkey';
  attnum   smallint;
BEGIN
  SELECT a.attnum INTO attnum
  FROM pg_attribute a
  WHERE a.attrelid = child AND a.attname = child_col AND NOT a.attisdropped;

  IF attnum IS NULL THEN
    RAISE EXCEPTION 'tenantize_fk: %.% does not exist', child, child_col;
  END IF;

  SELECT c.conname INTO old_name
  FROM pg_constraint c
  WHERE c.conrelid = child
    AND c.contype = 'f'
    AND c.confrelid = parent
    AND c.conkey = ARRAY[attnum]::smallint[];

  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', child::text, old_name);
  END IF;

  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I
       FOREIGN KEY (tenant_id, %I) REFERENCES %s (tenant_id, id) ON DELETE %s',
    child::text, new_name, child_col, parent::text, on_delete);
END $$;

-- ── referenced tables get (tenant_id, id) ───────────────────────────────────

SELECT app.add_tenant_id_unique('person');
SELECT app.add_tenant_id_unique('membership');
SELECT app.add_tenant_id_unique('role');
SELECT app.add_tenant_id_unique('organization');
SELECT app.add_tenant_id_unique('school');
SELECT app.add_tenant_id_unique('campus');
SELECT app.add_tenant_id_unique('shift');
SELECT app.add_tenant_id_unique('academic_year');
SELECT app.add_tenant_id_unique('class_level');
SELECT app.add_tenant_id_unique('section');
SELECT app.add_tenant_id_unique('student');
SELECT app.add_tenant_id_unique('staff');
SELECT app.add_tenant_id_unique('sibling_group');

-- ── 0006: identity ──────────────────────────────────────────────────────────

SELECT app.tenantize_fk('membership',      'person_id',     'person');
SELECT app.tenantize_fk('role_permission', 'role_id',       'role',       'CASCADE');
SELECT app.tenantize_fk('membership_role', 'membership_id', 'membership', 'CASCADE');
SELECT app.tenantize_fk('membership_role', 'role_id',       'role');

-- ── 0007: structure ─────────────────────────────────────────────────────────

SELECT app.tenantize_fk('school',        'organization_id', 'organization');
SELECT app.tenantize_fk('campus',        'school_id',       'school');
SELECT app.tenantize_fk('shift',         'campus_id',       'campus');
SELECT app.tenantize_fk('academic_year', 'school_id',       'school');
SELECT app.tenantize_fk('term',          'academic_year_id','academic_year');
SELECT app.tenantize_fk('class_level',   'school_id',       'school');
SELECT app.tenantize_fk('section',       'class_level_id',  'class_level');
SELECT app.tenantize_fk('section',       'campus_id',       'campus');
SELECT app.tenantize_fk('section',       'shift_id',        'shift');

-- ── 0008: directory ─────────────────────────────────────────────────────────

SELECT app.tenantize_fk('student',                  'person_id',        'person');
SELECT app.tenantize_fk('student_status_event',     'student_id',       'student');
SELECT app.tenantize_fk('enrolment',                'student_id',       'student');
SELECT app.tenantize_fk('enrolment',                'section_id',       'section');
SELECT app.tenantize_fk('enrolment',                'academic_year_id', 'academic_year');
SELECT app.tenantize_fk('guardian_link',            'guardian_person_id','person');
SELECT app.tenantize_fk('guardian_link',            'student_id',       'student');
SELECT app.tenantize_fk('sibling_member',           'sibling_group_id', 'sibling_group', 'CASCADE');
SELECT app.tenantize_fk('sibling_member',           'student_id',       'student');
SELECT app.tenantize_fk('staff',                    'person_id',        'person');
SELECT app.tenantize_fk('section',                  'class_teacher_id', 'staff');
SELECT app.tenantize_fk('staff_section_assignment', 'staff_id',         'staff');
SELECT app.tenantize_fk('staff_section_assignment', 'section_id',       'section');
SELECT app.tenantize_fk('staff_section_assignment', 'academic_year_id', 'academic_year');
SELECT app.tenantize_fk('staff_subject_assignment', 'staff_id',         'staff');
SELECT app.tenantize_fk('staff_subject_assignment', 'section_id',       'section');
SELECT app.tenantize_fk('staff_subject_assignment', 'academic_year_id', 'academic_year');

-- person.merged_into_person_id is a self-reference and tenant-scoped by the
-- same argument: a merge must never point across tenants.
SELECT app.tenantize_fk('person', 'merged_into_person_id', 'person');

/*
 * Every tenant table created from here on must use composite FKs for domain
 * references. There is no automated guard for this yet — a catalogue test
 * asserting "no single-column FK between two tenant-owned tables" is the
 * natural companion and is the next thing to add to the isolation suite.
 */
