import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only — pure helpers, no database, no network (see PLAN §6).
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
