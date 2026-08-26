/**
 * Platform reference data: the permission vocabulary and the role templates.
 *
 * Both are DERIVED from `src/shared/permissions.ts`, which is the single source
 * of truth (§9.1). Writing them as a SQL migration would mean transcribing the
 * closed union by hand into a file that then drifts from it silently — so they
 * are seeded from the union itself, idempotently, and a companion integration
 * test fails the build if the table and the union ever disagree.
 *
 * Safe to re-run: every statement is an upsert. Nothing is deleted, because
 * `role_permission.permission_key` has a foreign key to `permission(key)` and
 * a tenant may already have granted a key we no longer ship. Orphans are
 * REPORTED instead, for a human to retire deliberately.
 *
 *   pnpm db:migrate && pnpm seed
 */

import { Pool } from 'pg';
import { PERMISSIONS, DANGEROUS_PERMISSIONS } from '../src/shared/permissions';
import {
  ROLE_TEMPLATES,
  LIVE_IN_3A,
  moduleOf,
} from '../src/shared/role-templates';

const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL_APP;
if (!url) {
  console.error('Set DATABASE_URL_MIGRATOR (or DATABASE_URL_APP) before seeding.');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });

async function main(): Promise<void> {
  const modules = moduleOf();
  const dangerous = new Set<string>(DANGEROUS_PERMISSIONS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const key of PERMISSIONS) {
      await client.query(
        `INSERT INTO permission (key, module, is_dangerous)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE
           SET module = EXCLUDED.module, is_dangerous = EXCLUDED.is_dangerous`,
        [key, modules.get(key), dangerous.has(key)],
      );
    }

    for (const [i, t] of ROLE_TEMPLATES.entries()) {
      const granted = t.permissions.filter((p) => LIVE_IN_3A.has(p));
      await client.query(
        `INSERT INTO role_template (code, name_bn, name_en, permissions, sequence)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE
           SET name_bn = EXCLUDED.name_bn,
               name_en = EXCLUDED.name_en,
               permissions = EXCLUDED.permissions,
               sequence = EXCLUDED.sequence`,
        [t.code, t.nameBn, t.nameEn, granted, i],
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('seed failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    client.release();
  }

  const { rows } = await pool.query<{ key: string }>(
    `SELECT key FROM permission WHERE key <> ALL($1::text[])`,
    [PERMISSIONS as readonly string[]],
  );
  if (rows.length > 0) {
    // Not deleted: a tenant may already have granted these, and the foreign key
    // would refuse anyway. resolveAuthContext drops unknown keys, so they are
    // inert — but a human should retire them deliberately.
    console.warn(
      `warning: ${rows.length} permission row(s) are no longer in the union and were left in place: ` +
        rows.map((r) => r.key).join(', '),
    );
  }

  console.log(
    `seeded ${PERMISSIONS.length} permissions and ${ROLE_TEMPLATES.length} role templates`,
  );
  await pool.end();
}

await main();
