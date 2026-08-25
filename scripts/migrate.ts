/**
 * Forward-only migration runner.
 *
 * Rollback is achieved by deploying the previous application version, which is
 * why every migration must be backwards compatible with the release before it
 * (§7.1). There are deliberately no down-migrations: they are written under
 * stress and rarely tested.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL_APP;
if (!url) {
  console.error('Set DATABASE_URL_MIGRATOR (or DATABASE_URL_APP) before migrating.');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });

async function main(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id          text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await pool.query<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM schema_migration',
  );
  const applied = new Map(rows.map((r) => [r.id, r.checksum]));

  let ran = 0;
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = await sha256(sql);

    const previous = applied.get(id);
    if (previous !== undefined) {
      if (previous !== checksum) {
        // An applied migration was edited. That silently diverges environments.
        console.error(
          `Migration ${id} has changed since it was applied.\n` +
            'Applied migrations are immutable — add a new migration instead.',
        );
        process.exit(1);
      }
      continue;
    }

    const started = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migration (id, checksum, duration_ms) VALUES ($1, $2, $3)',
        [id, checksum, Date.now() - started],
      );
      await client.query('COMMIT');
      console.log(`applied ${id} (${Date.now() - started} ms)`);
      ran++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`FAILED ${id}:`, e instanceof Error ? e.message : e);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log(ran === 0 ? 'nothing to apply' : `applied ${ran} migration(s)`);
  await pool.end();
}

async function sha256(text: string): Promise<string> {
  // Normalise line endings so a Windows checkout and a Linux CI runner agree.
  const normalised = text.replace(/\r\n/g, '\n');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalised));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

await main();
