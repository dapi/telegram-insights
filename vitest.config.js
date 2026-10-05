import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: true,
  },
});
