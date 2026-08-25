/**
 * Sets passwords for the four database roles. DEVELOPMENT AND CI ONLY.
 *
 * Production passwords are set by `scripts/provision-host.sh` from the host's
 * environment file and never pass through Git — a migration is checked in, and
 * a credential must not be (migration 0001).
 *
 * This exists because the isolation suite is meaningless unless it connects as
 * `sm_app`. A superuser bypasses row-level security entirely, so a suite run as
 * `postgres` would pass while proving nothing.
 */

import { Pool } from 'pg';

const url = process.env.DATABASE_URL_MIGRATOR;
if (!url) {
  console.error('DATABASE_URL_MIGRATOR must point at a superuser connection.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run in production. Use scripts/provision-host.sh.');
  process.exit(1);
}

const password = process.env.DEV_DB_PASSWORD ?? 'devpassword';
const roles = ['sm_app', 'sm_readonly', 'sm_platform', 'sm_migrator'] as const;

const pool = new Pool({ connectionString: url, max: 1 });

try {
  for (const role of roles) {
    // Role names are from a fixed list above, never from input.
    await pool.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
    console.log(`set password for ${role}`);
  }

  // In CI the tables are created by the superuser rather than by sm_migrator,
  // so ALTER DEFAULT PRIVILEGES FOR ROLE sm_migrator does not apply to them.
  // Grant explicitly so the suite exercises real, least-privilege access.
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sm_app, sm_platform;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO sm_readonly;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sm_app, sm_platform;
  `);
  console.log('granted table access to sm_app, sm_readonly, sm_platform');
} finally {
  await pool.end();
}
