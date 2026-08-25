-- 0003 — platform scope. NOT tenant-owned: no `tenant_id`, no RLS.
-- Access is controlled by role, and the isolation suite deliberately ignores
-- these tables because they have no tenant_id column to key on.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

/*
 * Grants least-privilege access on one table.
 *
 * ALTER DEFAULT PRIVILEGES in 0001 covers tables created BY sm_migrator. In CI
 * and in some local setups the tables are created by a superuser instead, so
 * the defaults do not apply and sm_app would have no access at all. Granting
 * explicitly per table makes the privilege model independent of who ran the
 * migration.
 */
CREATE OR REPLACE FUNCTION app.grant_table_access(target regclass) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE tbl text := target::text;
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO sm_app, sm_platform', tbl);
  EXECUTE format('GRANT SELECT ON %s TO sm_readonly', tbl);
END $$;

-- ── Plans and entitlements ──────────────────────────────────────────────────

CREATE TABLE plan (
  id             uuid PRIMARY KEY,
  code           text NOT NULL UNIQUE,
  name_bn        text NOT NULL,
  name_en        text NOT NULL,
  price_minor    bigint NOT NULL CHECK (price_minor >= 0),
  currency       char(3) NOT NULL DEFAULT 'BDT',
  billing_period text NOT NULL CHECK (billing_period IN ('monthly','annual')),
  is_public      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_feature (
  plan_id     uuid NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  limit_value bigint,                                 -- NULL = unlimited
  PRIMARY KEY (plan_id, feature_key)
);

-- ── Tenants ─────────────────────────────────────────────────────────────────

CREATE TABLE tenant (
  id              uuid PRIMARY KEY,
  -- FK to organization is added in 0007; organization is tenant-owned and
  -- therefore cannot exist before the tenant it belongs to.
  organization_id uuid,
  slug            text NOT NULL UNIQUE
                    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  name_bn         text NOT NULL,
  name_en         text NOT NULL,
  status          text NOT NULL DEFAULT 'trial'
                    CHECK (status IN ('trial','active','past_due','suspended',
                                      'cancelled','purged')),
  plan_id         uuid NOT NULL REFERENCES plan(id),
  -- Always 'primary' today. The indirection that lets one large tenant move to
  -- its own database later without touching call sites (§7.6). NOT dead code.
  shard_id        text NOT NULL DEFAULT 'primary',
  locale_default  text NOT NULL DEFAULT 'bn' CHECK (locale_default IN ('bn','en')),
  timezone        text NOT NULL DEFAULT 'Asia/Dhaka',
  numerals        text NOT NULL DEFAULT 'bn' CHECK (numerals IN ('bn','latin')),
  branding        jsonb NOT NULL DEFAULT '{}'::jsonb,
  trial_ends_at   timestamptz,
  suspended_at    timestamptz,
  purge_after     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_status_idx  ON tenant (status) WHERE status <> 'purged';
CREATE INDEX tenant_shard_idx   ON tenant (shard_id);

/*
 * Per-tenant entitlement override.
 *
 * Phase 1 §11.1 classified this as platform-scoped, and the isolation harness
 * disagreed — the table carries `tenant_id`, so under the "no exceptions list"
 * rule it must be protected. The harness is right and the classification was
 * wrong: these rows ARE per-tenant data, a tenant should see only its own, and
 * the operator path already uses sm_platform, which bypasses RLS by design.
 *
 * Caught by CI on the migration that introduced it, which is exactly what a
 * catalogue-generated guard is for.
 */
CREATE TABLE tenant_feature_override (
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled     boolean NOT NULL,
  limit_value bigint,
  -- Never silent: an override without a recorded reason becomes unexplainable.
  reason      text NOT NULL,
  expires_at  timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key)
);
SELECT app.enable_tenant_rls('tenant_feature_override');

-- ── The permission vocabulary ───────────────────────────────────────────────
-- Generated FROM the TypeScript union in src/shared/permissions.ts. Code is the
-- source of truth; this table exists for the role-editor UI and the FK from
-- role_permission (0006).

CREATE TABLE permission (
  key            text PRIMARY KEY,
  module         text NOT NULL,
  description_bn text NOT NULL DEFAULT '',
  description_en text NOT NULL DEFAULT '',
  -- fee.waive, result.publish, student.merge … require a confirm step and
  -- always record a reason.
  is_dangerous   boolean NOT NULL DEFAULT false
);

-- Template roles copied into each tenant at provisioning.
--
-- Phase 1's §11.2 sketch allowed role.tenant_id to be NULL for platform
-- templates. That would punch a hole in RLS: a NULL tenant_id matches no
-- policy, so the row becomes invisible to everyone including the tenant that
-- needs it. Templates therefore live here, outside the tenant model, and are
-- COPIED at provisioning.
CREATE TABLE role_template (
  code        text PRIMARY KEY,
  name_bn     text NOT NULL,
  name_en     text NOT NULL,
  permissions text[] NOT NULL,
  sequence    integer NOT NULL DEFAULT 0
);

-- ── Privileges ──────────────────────────────────────────────────────────────

SELECT app.grant_table_access('plan');
SELECT app.grant_table_access('plan_feature');
SELECT app.grant_table_access('tenant');
SELECT app.grant_table_access('tenant_feature_override');
SELECT app.grant_table_access('permission');
SELECT app.grant_table_access('role_template');

SELECT app.attach_touch_trigger('plan');
SELECT app.attach_touch_trigger('tenant');
