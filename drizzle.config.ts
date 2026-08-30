/**
 * `drizzle-kit check` configuration.
 *
 * SQL migrations under `src/db/migrations/` are the source of truth (§7.1);
 * this only lets `drizzle-kit` compare the typed mirror in `src/db/schema/`
 * against them and flag drift — it never generates or applies a migration
 * itself. `pnpm db:migrate` (scripts/migrate.ts) is the only writer.
 *
 * Uses `DATABASE_URL_MIGRATOR`, the same role every migration runs as —
 * checking schema drift is a migration-adjacent concern, not an app-runtime
 * one.
 */

import type { Config } from 'drizzle-kit';

export default {
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL_MIGRATOR'] ?? '',
  },
} satisfies Config;
