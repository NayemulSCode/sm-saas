import { defineConfig } from 'vitest/config';

/**
 * HTTP-level tests: a real Next server, real requests, real cookies, real
 * database.
 *
 * These are the only tests that exercise the transport layer — the response
 * envelope, the error→status mapping, the HttpOnly cookie and the rate
 * limiter. Everything beneath them is covered by the integration suite; this
 * proves the wiring between the two.
 *
 * Serial and slow by nature: the suite boots a production build once.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.http.test.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    reporters: ['default'],
  },
});
