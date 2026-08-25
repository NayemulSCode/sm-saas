-- 0006 — tenant-scoped identity: membership, roles, role assignments.
--
-- `membership` is the bridge that makes the whole identity model work: THIS
-- account, in THIS tenant, acts as THIS person. One login reaching two schools
-- is two membership rows, not two accounts (ADR-0006).

SET lock_timeout = '3s';
SET statement_timeout = '5min';

/*
 * The standard column set, emitted from one place so it cannot drift.
 *
 * §3.1 specifies these on every tenant-owned table. Hand-writing them across a
 * hundred tables guarantees that one of them eventually differs — a missing
 * `deleted_at` silently turns a soft delete into a hard one.
 *
 * `tenant_id` defaults from the transaction-local session variable, so a
 * forgotten tenant_id on an INSERT gets the right value instead of a NOT NULL
 * violation in production.
 */
CREATE OR REPLACE FUNCTION app.add_tenant_columns(target regclass) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE tbl text := target::text;
BEGIN
  EXECUTE format(
    'ALTER TABLE %s
       ADD COLUMN tenant_id uuid NOT NULL DEFAULT app.current_tenant_id()
                    REFERENCES tenant(id) ON DELETE RESTRICT,
       ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
       ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
       ADD COLUMN created_by uuid REFERENCES person(id),
       ADD COLUMN updated_by uuid REFERENCES person(id),
       ADD COLUMN deleted_at timestamptz,
       ADD COLUMN deleted_by uuid REFERENCES person(id),
       ADD COLUMN delete_reason text,
       ADD COLUMN version integer NOT NULL DEFAULT 1', tbl);
END $$;

/* Applies the column set, RLS, grants and the updated_at trigger together, so
 * a table cannot be created with one and without another. */
CREATE OR REPLACE FUNCTION app.make_tenant_table(target regclass) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.add_tenant_columns(target);
  PERFORM app.enable_tenant_rls(target);
  PERFORM app.grant_table_access(target);
  PERFORM app.attach_touch_trigger(target);
END $$;

-- ── membership ──────────────────────────────────────────────────────────────

CREATE TABLE membership (
  id         uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES person(id),
  status     text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended'))
);
SELECT app.make_tenant_table('membership');

ALTER TABLE membership
  ADD CONSTRAINT membership_unique_triple UNIQUE (tenant_id, account_id, person_id);

-- One login per person per tenant. Two logins for one human inside one school
-- is a duplicate-person problem, not an identity feature.
CREATE UNIQUE INDEX membership_one_login_per_person_idx
  ON membership (tenant_id, person_id) WHERE deleted_at IS NULL;

-- Context resolution at login fans out across tenants by account_id. It is the
-- one legitimately cross-tenant read, and it runs on the sm_platform pool
-- because the tenant is what it is resolving (§8.4).
CREATE INDEX membership_account_idx ON membership (account_id);
CREATE INDEX membership_tenant_account_idx ON membership (tenant_id, account_id);

-- The FK deferred from 0004: `session` is global, `membership` is tenant-owned,
-- so membership could not exist until `person` did (0005).
ALTER TABLE session
  ADD CONSTRAINT session_active_membership_fk
  FOREIGN KEY (active_membership_id) REFERENCES membership(id) ON DELETE SET NULL;

-- ── roles ───────────────────────────────────────────────────────────────────

/*
 * Roles are data, copied per tenant from role_template at provisioning.
 *
 * `tenant_id` is never NULL here. Phase 1 §11.2 sketched NULL for platform
 * template roles; a NULL tenant_id matches no RLS policy, so the row would be
 * invisible to everyone — including the tenant that needs it. Templates live
 * in role_template (0003) instead.
 */
CREATE TABLE role (
  id        uuid PRIMARY KEY,
  code      text NOT NULL,
  name_bn   text NOT NULL,
  name_en   text NOT NULL,
  -- Seeded roles cannot be deleted; a tenant may still edit their permissions.
  is_system boolean NOT NULL DEFAULT false
);
SELECT app.make_tenant_table('role');

ALTER TABLE role ADD CONSTRAINT role_code_unique UNIQUE (tenant_id, code);

CREATE TABLE role_permission (
  id             uuid PRIMARY KEY,
  role_id        uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  -- FK to the vocabulary: a permission that is not in the closed TypeScript
  -- union cannot be granted, because it is not in the table (§9.1).
  permission_key text NOT NULL REFERENCES permission(key)
);
SELECT app.make_tenant_table('role_permission');

ALTER TABLE role_permission
  ADD CONSTRAINT role_permission_unique UNIQUE (tenant_id, role_id, permission_key);
CREATE INDEX role_permission_role_idx ON role_permission (tenant_id, role_id);

CREATE TABLE membership_role (
  id            uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES membership(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES role(id),
  /*
   * { campusIds?, classIds?, sectionIds?, subjectIds? }
   *
   * An ABSENT key means unrestricted within the tenant. A PRESENT but empty
   * array denies everything — a misconfigured role fails closed rather than
   * open. sectionIds + subjectIds together are a PAIR filter, not a cross
   * product: a teacher may teach Maths in 6A and nothing else in 6A (§9.3).
   */
  scope         jsonb NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(scope) = 'object')
);
SELECT app.make_tenant_table('membership_role');

ALTER TABLE membership_role
  ADD CONSTRAINT membership_role_unique UNIQUE (tenant_id, membership_id, role_id);
CREATE INDEX membership_role_membership_idx
  ON membership_role (tenant_id, membership_id);
