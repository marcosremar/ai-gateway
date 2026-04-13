import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ai-gateway\/(.*)$/, replacement: `${path.resolve(__dirname, 'src')}/$1` },
      { find: '@ai-gateway', replacement: path.resolve(__dirname, 'src/index.ts') },
      // @prisma/client is not installed in this package (no hard dep by design).
      // Alias it to a mock so tests that exercise DatabaseService.prisma or
      // server/state.ts can run without the real package.
      { find: '@prisma/client', replacement: path.resolve(__dirname, '__tests__/__mocks__/prisma-client-mock.ts') },
    ],
  },
  test: {
    include: ['__tests__/*.test.ts'],
    setupFiles: ['__tests__/vitest-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    retry: 1, // Retry failed tests once (handles Groq rate limit in full-suite runs)
    env: {
      // Set to '0' to run live/GPU tests (require running gateway + GPU pod)
      SKIP_GPU_TESTS: process.env.SKIP_GPU_TESTS ?? '1',
      SKIP_LIVE_TESTS: process.env.SKIP_LIVE_TESTS ?? '1',
    },
    server: {
      deps: {
        // Zod v4 changed its ESM structure; inline it so vitest bundles it
        // through the normal pipeline instead of SSR (where z is undefined).
        inline: ['zod'],
      },
    },
  },
});
