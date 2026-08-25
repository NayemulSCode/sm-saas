-- 0005 — `person`: THE FIRST TENANT-OWNED TABLE.
--
-- This is the milestone the generated isolation suite exists for. Until now it
-- had nothing to protect; from this migration onwards it enumerates pg_class
-- and fails the build on any table carrying tenant_id without RLS enabled,
-- forced, and a USING + WITH CHECK policy (§5.5).
--
-- All personal data about a child lives here, behind row-level security. That
-- is the deliberate consequence of keeping `account` (0004) thin.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

CREATE TABLE person (
  -- ── standard column set (§3.1) ──
  id            uuid PRIMARY KEY,               -- app-generated ULID, NO default
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id()
                  REFERENCES tenant(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES person(id),      -- self-reference, nullable
  updated_by    uuid REFERENCES person(id),
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES person(id),
  delete_reason text,
  version       integer NOT NULL DEFAULT 1,

  -- ── the person ──
  -- BOTH names are real and NOT NULL. Not translations of each other: the
  -- report card prints one, the board registration list needs the other
  -- (ADR-0019). Modelling this as one localised field produces a Bangla report
  -- card that silently prints an English name.
  name_bn       text NOT NULL CHECK (length(btrim(name_bn)) > 0),
  name_en       text NOT NULL CHECK (length(btrim(name_en)) > 0),

  date_of_birth date,
  gender        text CHECK (gender IN ('male','female','other')),
  photo_key     text,

  -- CONTACT details — deliberately NOT unique. The login identifier is
  -- credential.value and is globally unique (0004).
  phone         text,
  email         text,

  national_id_enc bytea,                         -- app-level encryption
  birth_reg_no  text,
  address       jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Loser of a reviewed merge (§8.6). Merging is never automatic: merging two
  -- students merges their dues.
  merged_into_person_id uuid REFERENCES person(id),

  CONSTRAINT person_phone_e164
    CHECK (phone IS NULL OR phone ~ '^\+8801[3-9][0-9]{8}$'),
  CONSTRAINT person_not_merged_into_self
    CHECK (merged_into_person_id IS NULL OR merged_into_person_id <> id)
);

-- Names are NFC-normalised by the application BEFORE insert (ADR-0019). Bangla
-- conjuncts have several valid encodings, so without normalisation two
-- visually identical names do not compare equal — and these indexes would
-- encode the inconsistency rather than resolve it.
CREATE INDEX person_name_bn_trgm_idx ON person USING gin (name_bn gin_trgm_ops);
CREATE INDEX person_name_en_trgm_idx ON person USING gin (name_en gin_trgm_ops);

-- Invariant 11: every index on a tenant table leads with tenant_id, because
-- RLS adds tenant_id = ANY(...) to every plan.
CREATE INDEX person_tenant_phone_idx    ON person (tenant_id, phone)
  WHERE phone IS NOT NULL;
CREATE INDEX person_tenant_birthreg_idx ON person (tenant_id, birth_reg_no)
  WHERE birth_reg_no IS NOT NULL;
CREATE INDEX person_tenant_dob_idx      ON person (tenant_id, date_of_birth);
CREATE INDEX person_merged_into_idx     ON person (merged_into_person_id)
  WHERE merged_into_person_id IS NOT NULL;

-- Enables RLS, FORCES it, and creates the USING + WITH CHECK policy from one
-- template. Never hand-write these: FORCE is the clause people omit, and
-- without it the TABLE OWNER bypasses RLS entirely.
SELECT app.enable_tenant_rls('person');
SELECT app.grant_table_access('person');
SELECT app.attach_touch_trigger('person');
