-- 0010 — staff invitations.
--
-- Staff are provisioned with a SINGLE-USE INVITE LINK and set their own
-- password. No password is ever transmitted, by SMS or email (§8.4).
--
-- Guardians never appear here: their login is phone OTP, which is also how
-- credential distribution to thousands of them is solved — there is nothing to
-- distribute (§8.2).

SET lock_timeout = '3s';
SET statement_timeout = '5min';

CREATE TABLE staff_invite (
  id            uuid PRIMARY KEY,
  -- account and credential are GLOBAL (no tenant_id), so these stay simple
  -- foreign keys — there is no tenant column to compose with (ADR-0032).
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES credential(id) ON DELETE CASCADE,
  -- Tenant-owned, so this one gets a composite key below.
  membership_id uuid NOT NULL,
  person_id     uuid NOT NULL,
  -- Hashed at rest, exactly like OTP codes and session tokens: a leak of this
  -- table must not yield usable invite links.
  token_hash    bytea NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  revoked_at    timestamptz,
  revoke_reason text,
  invited_by    uuid,
  CONSTRAINT staff_invite_revoked_has_reason
    CHECK (revoked_at IS NULL OR revoke_reason IS NOT NULL)
);
SELECT app.make_tenant_table('staff_invite');

-- Globally unique: the token is looked up before any tenant is known, so it
-- cannot be scoped by tenant_id at lookup time.
CREATE UNIQUE INDEX staff_invite_token_idx ON staff_invite (token_hash);

CREATE INDEX staff_invite_account_idx ON staff_invite (tenant_id, account_id);
CREATE INDEX staff_invite_expiry_idx ON staff_invite (expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- At most one live invite per membership: two valid links for one person
-- doubles the window in which a leaked link is usable.
CREATE UNIQUE INDEX staff_invite_one_live_idx
  ON staff_invite (tenant_id, membership_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL AND deleted_at IS NULL;

SELECT app.tenantize_fk('staff_invite', 'membership_id', 'membership', 'CASCADE');
SELECT app.tenantize_fk('staff_invite', 'person_id',     'person');
SELECT app.tenantize_fk('staff_invite', 'invited_by',    'person');
