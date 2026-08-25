import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // In-process only: pure helpers plus integration tests on an embedded
    // PGlite Postgres. No external network, no credentials (PLAN §6).
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
