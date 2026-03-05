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
  },
});
