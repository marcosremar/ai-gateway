import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ai-gateway\/(.*)$/, replacement: `${path.resolve(__dirname, 'src')}/$1` },
      { find: '@ai-gateway', replacement: path.resolve(__dirname, 'src/index.ts') },
    ],
  },
  test: {
    include: ['__tests__/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    env: {
      SKIP_GPU_TESTS: '1',
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
