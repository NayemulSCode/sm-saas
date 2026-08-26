-- 0011 — the audit trail. Invariant 7 / non-negotiable 4.
--
-- TWO TABLES, NOT ONE
--
-- §8 line 204 says "every authentication event appears in audit_log". It
-- cannot: `audit_log.tenant_id` is NOT NULL, and authentication happens BEFORE
-- a tenant is known — `account`, `credential` and `session` are all global
-- tables (0004), and `withPlatform` deliberately sets no tenant context, so an
-- insert from the login path matches no policy and is refused.
--
-- The two ways to force it into one table are both worse:
--
--   * A nullable tenant_id punches the same hole in RLS that was rejected for
--     `role.tenant_id` (§3.3) — a NULL matches no policy, so the row becomes
--     invisible to everyone. It would also break the isolation harness rule
--     that every tenant_id column has RLS, and that rule earns its keep by
--     having no exceptions list.
--   * Guessing a tenant at login time writes a lie into the audit trail. A
--     failed attempt on an unknown phone number has no tenant at all.
--
-- So authentication — which is about an ACCOUNT — is audited globally in
-- `auth_event`, and everything that happens inside a school is audited in
-- `audit_log`. Activating a context and accepting an invite appear in both:
-- they are the moment an account becomes an actor in a tenant.
--
-- ADR-0033 records this.
--
-- BOTH TABLES ARE APPEND-ONLY
--
-- An audit trail the application can rewrite is not an audit trail. Neither
-- table is created with app.make_tenant_table: that adds updated_at,
-- deleted_at, delete_reason and version, every one of which is a lie on a row
-- that must never change. The app roles are granted SELECT and INSERT and
-- nothing else, and UPDATE/DELETE are revoked explicitly rather than merely
-- withheld, so the intent survives a future blanket GRANT.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

-- ── auth_event — GLOBAL ─────────────────────────────────────────────────────
--
-- No tenant_id column, deliberately. Adding one would oblige RLS (the harness
-- enumerates pg_class for exactly that), and RLS on the login path means the
-- row is refused: there is no tenant context to satisfy it.

CREATE TABLE auth_event (
  id              uuid PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  -- otp.requested · otp.verified · password.attempted · account.locked ·
  -- session.created · session.revoked · context.switched · platform.accessed
  type            text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('success', 'failure')),

  -- All nullable: a failed attempt on an unknown identifier has no account.
  -- SET NULL rather than CASCADE — deleting an account must not delete the
  -- record that it existed.
  account_id      uuid REFERENCES account(id) ON DELETE SET NULL,
  credential_id   uuid REFERENCES credential(id) ON DELETE SET NULL,
  session_id      uuid REFERENCES session(id) ON DELETE SET NULL,

  /*
   * The identifier is a phone number or an email — PII, and non-negotiable 4
   * says ids only, never PII values. Hashing keeps the one property the audit
   * needs, which is correlating repeated attempts on the same identifier,
   * without storing the number a second time in a table that will be read by
   * support staff.
   */
  identifier_hash bytea,

  reason          text,
  request_id      text NOT NULL,
  ip              inet,
  user_agent      text,
  -- Ids and flags only. Never values — same rule as audit_log.before/after.
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX auth_event_account_idx ON auth_event (account_id, at DESC)
  WHERE account_id IS NOT NULL;
CREATE INDEX auth_event_at_idx ON auth_event (at DESC);
-- "How many failures against this identifier in the last hour" — the question
-- asked during an incident, and the reason the hash is indexed at all.
CREATE INDEX auth_event_identifier_idx ON auth_event (identifier_hash, at DESC)
  WHERE identifier_hash IS NOT NULL;

-- ── audit_log — TENANT-OWNED ────────────────────────────────────────────────
--
-- §3.4, with the bookkeeping columns omitted for the append-only reason above.

CREATE TABLE audit_log (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  at               timestamptz NOT NULL DEFAULT now(),

  -- Simple FKs, not composite ones. ADR-0032 draws the line at where the value
  -- ORIGINATES: these are written by the framework from ctx.personId, which is
  -- derived from a verified membership in the active tenant and can never come
  -- from request input.
  actor_person_id  uuid REFERENCES person(id),
  actor_account_id uuid REFERENCES account(id),

  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  action           text NOT NULL,

  -- Invariant 12: ids and CHANGED FIELD NAMES, not values. A person diff
  -- records that `phone` changed, not the old and new numbers. The audit
  -- answers who changed what, when and why — none of which needs the PII
  -- stored twice. src/db/audit.ts enforces this on the way in.
  before           jsonb,
  after            jsonb,

  reason           text,
  request_id       text NOT NULL,
  impersonated_by  uuid REFERENCES account(id),   -- ADR-0029
  ip               inet,
  user_agent       text
);

-- RLS only. NOT make_tenant_table: see the header.
SELECT app.enable_tenant_rls('audit_log');

-- "Everything that ever happened to this student" — the history view.
CREATE INDEX audit_log_entity_idx
  ON audit_log (tenant_id, entity_type, entity_id, at DESC);
-- "What happened in this school today" — the review view.
CREATE INDEX audit_log_at_idx ON audit_log (tenant_id, at DESC);

-- ── Append-only privileges ──────────────────────────────────────────────────

GRANT SELECT, INSERT ON auth_event TO sm_app, sm_platform;
GRANT SELECT, INSERT ON audit_log  TO sm_app, sm_platform;
GRANT SELECT ON auth_event, audit_log TO sm_readonly;

-- Explicit, not merely absent: this states the intent in the schema, and it
-- survives someone later running app.grant_table_access on these tables.
REVOKE UPDATE, DELETE, TRUNCATE ON auth_event FROM sm_app, sm_platform, sm_readonly, PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log  FROM sm_app, sm_platform, sm_readonly, PUBLIC;

COMMENT ON TABLE auth_event IS
  'Append-only. Global authentication trail — no tenant_id by design (ADR-0033).';
COMMENT ON TABLE audit_log IS
  'Append-only. Every tenant-scoped mutation: actor, tenant, time, before/after, reason.';
