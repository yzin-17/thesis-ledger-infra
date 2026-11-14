import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.mjs'],
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 10_000,
  },
});
