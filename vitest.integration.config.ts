import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests — real PostgreSQL, real module wiring.
 *
 * Separate from both the unit suite (which must run with no database, so
 * `pnpm test` works from a fresh clone) and the isolation suite (which is a
 * gate on tenancy and runs first, alone, so its failures are unmistakable).
 *
 * Runs serially: these tests seed and mutate shared rows, and parallel files
 * would interfere.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@modules': fileURLToPath(new URL('./src/modules', import.meta.url)),
      '@db': fileURLToPath(new URL('./src/db', import.meta.url)),
    },
  },
});
