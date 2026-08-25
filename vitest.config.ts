import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // The isolation suite needs a real PostgreSQL and runs as its own CI step,
    // so a tenancy regression is the first thing that fails and is unmistakable
    // in the log rather than one red dot among four hundred.
    exclude: ['node_modules/**', '.next/**', 'src/db/__tests__/**'],
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
