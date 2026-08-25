import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * The tenant isolation suite runs under its OWN config.
 *
 * `vitest.config.ts` excludes `src/db/__tests__/**` so the unit suite does not
 * need a database — but that exclude also swallowed the file when it was named
 * explicitly, and `pnpm test:isolation` reported "No test files found". The
 * guard was inert while appearing to be configured. Caught by CI; the fix is a
 * separate config rather than an exclude that has to be remembered.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/db/__tests__/**/*.test.ts'],
    // Never pass on an empty run: an isolation suite that matches nothing must
    // fail loudly, because a silent zero-test pass is worse than no guard.
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@db': fileURLToPath(new URL('./src/db', import.meta.url)),
    },
  },
});
