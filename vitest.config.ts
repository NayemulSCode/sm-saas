import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // `pnpm test` must run from a fresh clone with NO database. Anything that
    // needs PostgreSQL lives in its own config and its own CI step:
    //   - src/db/__tests__/**          the tenancy gate (vitest.isolation.config.ts)
    //   - **/*.integration.test.ts     module wiring (vitest.integration.config.ts)
    exclude: [
      'node_modules/**',
      '.next/**',
      'src/db/__tests__/**',
      'src/**/*.integration.test.ts',
      'src/**/*.http.test.ts',
    ],
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
