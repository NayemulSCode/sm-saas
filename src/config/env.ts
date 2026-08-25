import { z } from 'zod';

/**
 * Environment, validated at boot. The process REFUSES TO START on a missing or
 * malformed value rather than failing at 02:00 on the first request that needs
 * it (§11.4).
 *
 * Three separate database URLs is the point: the operator pool is a different
 * connection string, so `sm_platform` cannot be reached by accident from tenant
 * request code (§5.1).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url(),
  PLATFORM_HOST: z.string().min(1),

  DATABASE_URL_APP: z.string().min(1), // sm_app — no BYPASSRLS
  DATABASE_URL_PLATFORM: z.string().min(1).optional(), // sm_platform — audited use only
  DATABASE_URL_MIGRATOR: z.string().min(1).optional(), // migrations only
  DATABASE_URL_READONLY: z.string().min(1).optional(), // replica, reporting
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(15),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),

  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  // Modest on purpose: the app shares an 8 GB host with PostgreSQL and
  // Chromium, and a 64 MiB setting under a login burst competes with the
  // database (§8.3).
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(19_456),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),

  SMS_PROVIDER: z.enum(['mock', 'provider_a', 'provider_b']).default('mock'),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Platform timezone is fixed. A different value is a misconfiguration, not a
  // preference (§22.x).
  TZ: z.literal('Asia/Dhaka').default('Asia/Dhaka'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only: reset the memoised value. */
export function resetEnvCache(): void {
  cached = undefined;
}
