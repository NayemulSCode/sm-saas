-- 0002 — extensions and the tenancy primitives.
--
-- Still no tables. This migration installs the functions that every RLS policy
-- reads and the helper that emits a policy, so that the FIRST tenant table
-- (0005, `person`) cannot be created without protection.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

-- Trigram search for Bangla and English names. Works on Bangla without a
-- language dictionary, which is why it is preferred to full-text search here.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Tenant session primitives ───────────────────────────────────────────────

-- STABLE so the planner evaluates it ONCE per query and the index on
-- (tenant_id, ...) is still used with = ANY(...). OQ-15 measures this at scale;
-- the fallback is a single-value GUC.
--
-- Unset GUC ⇒ empty array ⇒ every policy matches nothing ⇒ FAILS CLOSED.
-- That is the property that makes forgetting withTenant() harmless.
CREATE OR REPLACE FUNCTION app.current_tenant_ids() RETURNS uuid[]
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT CASE
             WHEN COALESCE(current_setting('app.tenant_ids', true), '') = ''
               THEN ARRAY[]::uuid[]
             ELSE string_to_array(current_setting('app.tenant_ids', true), ',')::uuid[]
           END
  $$;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT (app.current_tenant_ids())[1]
  $$;

CREATE OR REPLACE FUNCTION app.current_actor_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid
  $$;

-- ── Shared table plumbing ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

/*
 * Emits the RLS policy for a tenant-owned table.
 *
 * Never hand-write these. FORCE is the clause people omit, and without it the
 * TABLE OWNER bypasses RLS — which means every connection using sm_migrator
 * silently sees every tenant. WITH CHECK is the other: USING alone filters
 * reads but still permits writing a row INTO another tenant.
 */
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(target regclass) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  tbl text := target::text;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE  ROW LEVEL SECURITY', tbl);

  EXECUTE format(
    'DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING      (tenant_id = ANY (app.current_tenant_ids()))
       WITH CHECK (tenant_id = ANY (app.current_tenant_ids()))', tbl);

  -- Invariant 11: RLS adds tenant_id = ANY(...) to every plan, so an index that
  -- does not lead with tenant_id forces a filter after the scan.
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %s (tenant_id)',
    replace(tbl, '.', '_') || '_tenant_id_idx', tbl);
END $$;

-- Attaches the updated_at trigger. Called alongside enable_tenant_rls.
CREATE OR REPLACE FUNCTION app.attach_touch_trigger(target regclass) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  tbl  text := target::text;
  trg  text := replace(tbl, '.', '_') || '_touch_updated_at';
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trg, tbl);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', trg, tbl);
END $$;

GRANT EXECUTE ON FUNCTION
  app.current_tenant_ids(), app.current_tenant_id(), app.current_actor_id()
  TO sm_app, sm_readonly, sm_platform;
