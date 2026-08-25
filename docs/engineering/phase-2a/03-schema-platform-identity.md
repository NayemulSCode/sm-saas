# 3. Schema — platform and identity

Final DDL for the Phase 3a foundation. Scope key: **[P]** platform (no RLS,
role-guarded), **[G]** global identity (no RLS, deliberately thin),
**[T]** tenant-scoped (RLS enabled *and* forced).

RLS statements are **not** repeated per table — they are emitted from one
template in [§5](05-rls-and-isolation-harness.md). Every `[T]` table gets them,
with no exceptions list.

## 3.1 The standard column set

Every `[T]` table carries these. Migrations emit them from a macro so they
cannot drift.

```sql
  id            uuid PRIMARY KEY,              -- app-generated ULID, NO default
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id()
                     REFERENCES tenant(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES person(id),
  updated_by    uuid REFERENCES person(id),
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES person(id),
  delete_reason text,
  version       integer NOT NULL DEFAULT 1     -- optimistic locking
```

Notes that matter:

- **`id` has no default.** ULIDs come from the application so an import can build
  a whole object graph before writing ([ADR-0016](../../architecture/adr/0016-identifier-strategy.md)).
- **`tenant_id` defaults from the session GUC**, so a forgotten `tenant_id` on an
  INSERT gets the right value instead of failing in production.
- `ON DELETE RESTRICT` because tenants are never hard-deleted except at
  offboarding, which purges in dependency order.
- `updated_at` is maintained by a trigger, not by the application.

```sql
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
-- Attached to every table by the same migration macro.
```

**Table creation order** is constrained by two references: `person` needs
`tenant`, and every `[T]` table's `created_by` needs `person`. Order is therefore
`tenant → account → credential → person → membership → everything else`.
`person.created_by` self-references and is nullable, which resolves the cycle.

## 3.2 Platform

```sql
-- [P] The unit of isolation, billing and support.
CREATE TABLE tenant (
  id              uuid PRIMARY KEY,
  organization_id uuid,                        -- FK added after organization exists
  slug            text NOT NULL UNIQUE
                    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  name_bn         text NOT NULL,
  name_en         text NOT NULL,
  status          text NOT NULL DEFAULT 'trial'
                    CHECK (status IN ('trial','active','past_due','suspended',
                                      'cancelled','purged')),
  plan_id         uuid NOT NULL REFERENCES plan(id),
  -- Always 'primary'. The indirection that lets one large tenant move to its
  -- own database later without touching call sites (§7.6). NOT dead code.
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
CREATE INDEX ON tenant (status) WHERE status <> 'purged';
CREATE INDEX ON tenant (shard_id);

-- [P] Plans and entitlements.
CREATE TABLE plan (
  id             uuid PRIMARY KEY,
  code           text NOT NULL UNIQUE,
  name_bn        text NOT NULL,
  name_en        text NOT NULL,
  price_minor    bigint NOT NULL CHECK (price_minor >= 0),
  currency       char(3) NOT NULL DEFAULT 'BDT',
  billing_period text NOT NULL CHECK (billing_period IN ('monthly','annual')),
  is_public      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_feature (
  plan_id     uuid NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  limit_value bigint,                          -- NULL = unlimited
  PRIMARY KEY (plan_id, feature_key)
);

-- [P] Per-tenant override, e.g. a pilot school with a raised SMS cap.
CREATE TABLE tenant_feature_override (
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled     boolean NOT NULL,
  limit_value bigint,
  reason      text NOT NULL,                   -- never silent
  expires_at  timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key)
);

-- [P] PLATFORM revenue. Never shares a table with school fee collection.
CREATE TABLE platform_invoice (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  period_start   date NOT NULL,
  period_end     date NOT NULL CHECK (period_end > period_start),
  amount_minor   bigint NOT NULL CHECK (amount_minor >= 0),
  tax_minor      bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  currency       char(3) NOT NULL DEFAULT 'BDT',
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','issued','paid','overdue','void')),
  due_date       date,
  issued_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, period_end)
);

CREATE TABLE platform_payment (
  id                  uuid PRIMARY KEY,
  platform_invoice_id uuid NOT NULL REFERENCES platform_invoice(id),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  channel             text NOT NULL CHECK (channel IN ('bank','mfs','cash','online')),
  reference           text,
  received_at         timestamptz NOT NULL,
  recorded_by         uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- [P] Metering, written by a nightly batch — never on the request path (FR-13.2).
CREATE TABLE tenant_usage_meter (
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period_month date NOT NULL,                  -- first of month
  metric       text NOT NULL
                 CHECK (metric IN ('active_students','sms_sent','storage_bytes',
                                   'documents_rendered')),
  value        bigint NOT NULL CHECK (value >= 0),
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_month, metric)
);

-- [P] Every operator action, including impersonation (ADR-0029).
CREATE TABLE operator_audit (
  id           uuid PRIMARY KEY,
  operator_id  uuid NOT NULL REFERENCES account(id),
  tenant_id    uuid REFERENCES tenant(id),
  action       text NOT NULL,
  reason       text NOT NULL,                  -- mandatory, always
  target       jsonb,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  ip           inet,
  user_agent   text
);
CREATE INDEX ON operator_audit (tenant_id, started_at DESC);
CREATE INDEX ON operator_audit (operator_id, started_at DESC);
```

`reason` is `NOT NULL` on both `tenant_feature_override` and `operator_audit`.
An override or an impersonation without a recorded reason is exactly the thing
that becomes unexplainable six months later.

## 3.3 Identity

Model rationale in [§8](../../architecture/phase-1a/08-identity-authn-rbac.md)
and [ADR-0006](../../architecture/adr/0006-identity-model.md). The separation:
**an account is who logs in; a person is a human inside one school.**

```sql
-- [G] Who logs in. Holds NO personal data — see §7.7. A breach of this table
-- yields phone numbers and Argon2id hashes, not a single student record.
CREATE TABLE account (
  id              uuid PRIMARY KEY,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','locked','disabled')),
  locale          text NOT NULL DEFAULT 'bn' CHECK (locale IN ('bn','en')),
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_secret_enc  bytea,                       -- app-level encryption
  last_login_at   timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- [G] One phone or email is ONE login, globally.
-- A phone is unique as a LOGIN IDENTIFIER and non-unique as a CONTACT DETAIL —
-- the contact copy lives on person.phone. Collapsing them breaks siblings,
-- shared handsets and separated parents (ADR-0006).
CREATE TABLE credential (
  id            uuid PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('phone','email')),
  value         text NOT NULL,                 -- phone normalised to E.164
  password_hash text,                          -- argon2id; NULL for OTP-only
  verified_at   timestamptz,
  is_primary    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value),
  CHECK (kind <> 'phone' OR value ~ '^\+8801[3-9][0-9]{8}$')
);
CREATE INDEX ON credential (account_id);
CREATE UNIQUE INDEX ON credential (account_id) WHERE is_primary;

-- [G] Opaque server-side sessions. NOT JWTs — revocation must take effect
-- within 60 s (NFR §4.6), and a stateless token cannot do that.
CREATE TABLE session (
  id                   uuid PRIMARY KEY,
  account_id           uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  token_hash           bytea NOT NULL UNIQUE,  -- sha256 of the cookie value
  active_membership_id uuid REFERENCES membership(id),
  issued_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  revoked_at           timestamptz,
  ip                   inet,
  user_agent           text
);
CREATE INDEX ON session (account_id) WHERE revoked_at IS NULL;
CREATE INDEX ON session (expires_at);          -- purge job

-- [G] Hashed, single-use, rate-limited. One of two tables that IS hard-deleted.
CREATE TABLE otp_challenge (
  id            uuid PRIMARY KEY,
  credential_id uuid NOT NULL REFERENCES credential(id) ON DELETE CASCADE,
  code_hash     bytea NOT NULL,
  purpose       text NOT NULL
                  CHECK (purpose IN ('login','verify','reset','step_up')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts <= 5),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON otp_challenge (credential_id, created_at DESC);

-- [T] The bridge: this account, in this tenant, acts as this person.
CREATE TABLE membership (
  -- + standard column set
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES person(id),
  status     text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended')),
  UNIQUE (tenant_id, account_id, person_id)
);
CREATE INDEX ON membership (tenant_id, account_id);
CREATE INDEX ON membership (account_id);       -- context resolution at login
CREATE UNIQUE INDEX ON membership (tenant_id, person_id)
  WHERE deleted_at IS NULL;                    -- one login per person per tenant

-- [T] Roles are data. tenant_id NULL is impossible here — platform TEMPLATE
-- roles live in role_template and are copied at provisioning.
CREATE TABLE role (
  -- + standard column set
  code      text NOT NULL,
  name_bn   text NOT NULL,
  name_en   text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,    -- seeded; cannot be deleted
  UNIQUE (tenant_id, code)
);

CREATE TABLE role_permission (
  -- + standard column set
  role_id        uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permission(key),
  UNIQUE (tenant_id, role_id, permission_key)
);

CREATE TABLE membership_role (
  -- + standard column set
  membership_id uuid NOT NULL REFERENCES membership(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES role(id),
  -- { campusIds?, classIds?, sectionIds?, subjectIds? } — absent key means
  -- unrestricted WITHIN the tenant. Never across tenants.
  scope         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, membership_id, role_id)
);
CREATE INDEX ON membership_role (tenant_id, membership_id);

-- [P] The permission vocabulary, generated FROM the TypeScript union (§9).
-- Code is the source of truth; this table exists for the role-editor UI and
-- for the FK above.
CREATE TABLE permission (
  key            text PRIMARY KEY,
  module         text NOT NULL,
  description_bn text NOT NULL,
  description_en text NOT NULL,
  is_dangerous   boolean NOT NULL DEFAULT false   -- fee.waive, result.publish…
);

-- [P] Template roles copied into each tenant at provisioning.
CREATE TABLE role_template (
  code        text PRIMARY KEY,
  name_bn     text NOT NULL,
  name_en     text NOT NULL,
  permissions text[] NOT NULL
);
```

### Two design points worth defending

**`membership` is `[T]`, not `[G]`.** It carries `tenant_id`, so RLS applies and
one tenant cannot enumerate another's memberships. The cross-tenant fan-out at
login is done by the `sm_platform` role during context resolution only
([§8.2](08-auth-and-session.md)), never by a tenant-scoped query.

**`role.tenant_id` is never NULL.** Phase 1's §11.2 sketch allowed NULL for
platform template roles; that would have punched a hole in RLS, because a NULL
`tenant_id` matches no policy and the row becomes invisible to everyone —
including the tenant that needs it. Templates therefore live in a separate
`role_template` table and are *copied* at provisioning. This is a deliberate
correction to the Phase 1 sketch, not a drift from it.

## 3.4 Cross-cutting

```sql
-- [T] Invariant 7: every mutation. Partition when > 100 M rows (§10.7).
CREATE TABLE audit_log (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  at               timestamptz NOT NULL DEFAULT now(),
  actor_person_id  uuid REFERENCES person(id),
  actor_account_id uuid REFERENCES account(id),
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  action           text NOT NULL,
  before           jsonb,                      -- REDACTED: ids only, no PII
  after            jsonb,
  reason           text,
  request_id       text NOT NULL,
  impersonated_by  uuid REFERENCES account(id),   -- ADR-0029
  ip               inet,
  user_agent       text
);
CREATE INDEX ON audit_log (tenant_id, entity_type, entity_id, at DESC);
CREATE INDEX ON audit_log (tenant_id, at DESC);

-- [T] Invariant: money and bulk endpoints are idempotent (FR-X.6).
CREATE TABLE idempotency_key (
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    bytea NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX ON idempotency_key (expires_at);

-- [T] Emitted events, for observability and replay (§9.4).
CREATE TABLE domain_event (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  type           text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  payload        jsonb NOT NULL,               -- IDS ONLY (§14.16)
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  request_id     text
);
CREATE INDEX ON domain_event (tenant_id, occurred_at DESC);
CREATE INDEX ON domain_event (tenant_id, aggregate_type, aggregate_id);
```

`audit_log.before`/`after` hold **ids and changed field names, not values** —
invariant 12. A diff of a `person` row records that `phone` changed, not the old
and new numbers. The audit answers "who changed what, when and why", which does
not require storing the PII a second time.
