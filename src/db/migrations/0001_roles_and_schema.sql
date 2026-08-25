-- 0001 — roles and the app schema.
--
-- Runs BEFORE any table. The isolation guarantee is a property of these roles:
-- sm_app has no BYPASSRLS and is not a superuser, so a forgotten WHERE clause
-- returns zero rows instead of another school's students (ADR-0003).
--
-- Passwords are NOT set here. A migration is checked into Git; a credential
-- must never be. `scripts/provision-host.sh` sets them from the host's
-- environment file, and local development uses trust auth.

SET lock_timeout = '3s';
SET statement_timeout = '5min';

DO $$
BEGIN
  -- Owns the schema, runs DDL. NEVER used by the running application.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sm_migrator') THEN
    CREATE ROLE sm_migrator LOGIN;
  END IF;

  -- The application and worker. DML only.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sm_app') THEN
    CREATE ROLE sm_app LOGIN;
  END IF;

  -- Reporting and the replica. SELECT only; RLS still applies.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sm_readonly') THEN
    CREATE ROLE sm_readonly LOGIN;
  END IF;

  -- The ONE role permitted past RLS: operator console, cross-tenant jobs and
  -- login-time context resolution. Separate credentials, separate pool, every
  -- use audited (ADR-0029).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sm_platform') THEN
    CREATE ROLE sm_platform LOGIN BYPASSRLS;
  END IF;
END $$;

-- Belt and braces: assert the app role can never bypass RLS, even if an
-- earlier hand-run ALTER granted it. CI re-checks this on every deploy (§5.6).
ALTER ROLE sm_app       NOBYPASSRLS NOSUPERUSER;
ALTER ROLE sm_readonly  NOBYPASSRLS NOSUPERUSER;
ALTER ROLE sm_migrator  NOBYPASSRLS NOSUPERUSER;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION sm_migrator;

GRANT USAGE ON SCHEMA app, public TO sm_app, sm_readonly, sm_platform;

ALTER DEFAULT PRIVILEGES FOR ROLE sm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sm_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO sm_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE sm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sm_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE sm_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sm_app, sm_platform;

-- An interactive request must not hold a connection for five minutes; a
-- five-minute report must not run under the interactive limit. The worker
-- raises its own per transaction.
ALTER ROLE sm_app      SET statement_timeout = '15s';
ALTER ROLE sm_readonly SET statement_timeout = '5min';
ALTER ROLE sm_platform SET statement_timeout = '60s';

ALTER ROLE sm_app      SET timezone = 'Asia/Dhaka';
ALTER ROLE sm_readonly SET timezone = 'Asia/Dhaka';
ALTER ROLE sm_platform SET timezone = 'Asia/Dhaka';
ALTER ROLE sm_migrator SET timezone = 'Asia/Dhaka';
