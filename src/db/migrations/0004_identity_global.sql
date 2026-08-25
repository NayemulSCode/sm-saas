-- 0004 — global identity. Deliberately NOT tenant-scoped.
--
-- An account is who LOGS IN; a person is a human inside one school (ADR-0006).
-- These tables hold no personal data beyond a login identifier, so a breach
-- here yields phone numbers and Argon2id hashes — not a single student record.
-- Everything about a child lives in `person` (0005), behind RLS.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

CREATE TABLE account (
  id              uuid PRIMARY KEY,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','locked','disabled')),
  locale          text NOT NULL DEFAULT 'bn' CHECK (locale IN ('bn','en')),
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_secret_enc  bytea,                                -- app-level encryption
  last_login_at   timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

/*
 * One phone or email is ONE login, globally.
 *
 * A phone number is unique as a LOGIN IDENTIFIER and non-unique as a CONTACT
 * DETAIL — the contact copy lives on person.phone (0005). Different columns,
 * different tables, different meanings. Collapsing them is what breaks
 * siblings, shared handsets and separated parents.
 */
CREATE TABLE credential (
  id            uuid PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('phone','email')),
  value         text NOT NULL,
  password_hash text,                                  -- argon2id; NULL = OTP-only
  verified_at   timestamptz,
  is_primary    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value),
  -- Normalised to E.164 before any lookup or insert, so 01711…, +88 01711…
  -- and 8801711… resolve to one account.
  CONSTRAINT credential_phone_e164
    CHECK (kind <> 'phone' OR value ~ '^\+8801[3-9][0-9]{8}$'),
  CONSTRAINT credential_email_shape
    CHECK (kind <> 'email' OR value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);
CREATE INDEX credential_account_idx ON credential (account_id);
CREATE UNIQUE INDEX credential_one_primary_idx ON credential (account_id) WHERE is_primary;

/*
 * Opaque server-side sessions. NOT JWTs.
 *
 * Revocation must take effect within 60 seconds (NFR §4.6), and a stateless
 * token cannot do that without a revocation list — which is a session table
 * with worse ergonomics. Stored as sha256(token), so a database leak does not
 * yield usable session cookies.
 */
CREATE TABLE session (
  id                   uuid PRIMARY KEY,
  account_id           uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  token_hash           bytea NOT NULL UNIQUE,
  -- FK to membership is added in 0006: membership is tenant-owned and cannot
  -- exist before `person`.
  active_membership_id uuid,
  issued_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  revoked_at           timestamptz,
  ip                   inet,
  user_agent           text
);
CREATE INDEX session_account_active_idx ON session (account_id) WHERE revoked_at IS NULL;
CREATE INDEX session_expiry_idx ON session (expires_at);   -- nightly purge

-- Hashed, single-use, rate-limited. One of only two tables that is ever
-- hard-deleted (invariant 6); the other is `session`.
CREATE TABLE otp_challenge (
  id            uuid PRIMARY KEY,
  credential_id uuid NOT NULL REFERENCES credential(id) ON DELETE CASCADE,
  code_hash     bytea NOT NULL,
  purpose       text NOT NULL
                  CHECK (purpose IN ('login','verify','reset','step_up')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_credential_idx ON otp_challenge (credential_id, created_at DESC);
CREATE INDEX otp_expiry_idx ON otp_challenge (expires_at);

SELECT app.grant_table_access('account');
SELECT app.grant_table_access('credential');
SELECT app.grant_table_access('session');
SELECT app.grant_table_access('otp_challenge');

SELECT app.attach_touch_trigger('account');
SELECT app.attach_touch_trigger('credential');
