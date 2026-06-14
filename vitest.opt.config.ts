/**
 * Deterministic config for the optimization-implementation test suite
 * (`__tests__/opt/**`).
 *
 * Intentionally does NOT use `mergeConfig` with the base config: mergeConfig
 * concatenates arrays, which would re-add the base `setupFiles` (loadEnv reads
 * .env/vault and hangs in CI) and the base `include`. We only reuse the base
 * `resolve.alias` map so tests can import `src/` and `server/` modules with the
 * project's import conventions, and define a fresh, fast `test` block.
 */
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  resolve: (base as any).resolve,
  test: {
    include: ['__tests__/opt/**/*.test.ts'],
    changed: false,
    retry: 0,
    setupFiles: [],
    sequence: { concurrent: false },
    testTimeout: 15_000,
    hookTimeout: 10_000,
    dangerouslyIgnoreUnhandledErrors: true,
    env: {
      SKIP_GPU_TESTS: '1',
      SKIP_LIVE_TESTS: '1',
      AIGW_LABEL_OPTIONAL: '1',
    },
    server: { deps: { inline: ['zod'] } },
  },
});
