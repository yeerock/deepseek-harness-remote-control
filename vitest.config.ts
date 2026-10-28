import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: {
      '@dsh-link/protocol': new URL('./packages/protocol/src/index.ts', import.meta.url).pathname,
      '@dsh-link/mux': new URL('./packages/mux/src/index.ts', import.meta.url).pathname,
    },
  },
});
