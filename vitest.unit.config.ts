/**
 * Unit test configuration — fast subset for CI gating.
 *
 * Excludes integration/live/benchmark/soak tests that either hit the network,
 * take >30s, or require external services. The goal is a <90s run that every
 * PR can afford to block on. Slower tiers run in scheduled jobs.
 */

import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // The base config sets `changed: true` (only tests touched by uncommitted edits) for the
      // local watch loop. In CI the checkout is clean, so the PR gate ran zero test files and
      // exited 0. The unit tier must always run the whole unit set.
      changed: false,
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        // Live API calls / require credentials
        '__tests__/**/*-real-api.test.ts',
        '__tests__/**/*-live*.test.ts',
        '__tests__/**/*-integration.test.ts',
        '__tests__/**/gateway-live.test.ts',
        '__tests__/**/e2e-*.test.ts',
        '__tests__/**/*real-gateway*.test.ts',
        // GPU lifecycle (real provider calls)
        '__tests__/**/*-lifecycle.test.ts',
        '__tests__/**/gpu-lifecycle-*.test.ts',
        '__tests__/**/runpod-*.test.ts',
        // Top-level vast-*.test.ts hit the real Vast API. The pure unit ones under __tests__/unit/
        // (offer policy, hot pool, desktop policy client, vast-client) must run in the PR gate;
        // the three below stay out as before (they need the real image/SSH/template stack).
        '__tests__/vast-*.test.ts',
        '__tests__/unit/vast-image-login.test.ts',
        '__tests__/unit/vast-template-ssh-tunnel.test.ts',
        '__tests__/**/tensordock-*.test.ts',
        '__tests__/**/modal-*.test.ts',
        // Benchmarks / soaks / slow suites
        '__tests__/**/*-benchmark.test.ts',
        '__tests__/**/benchmarking-*.test.ts',
        '__tests__/**/snapgpu-benchmark.test.ts',
        '__tests__/**/soak-*.test.ts',
        '__tests__/**/memory-soak.test.ts',
        '__tests__/**/breaking-point.test.ts',
        '__tests__/**/network-stress.test.ts',
        '__tests__/load/**',
        '__tests__/**/cold-start*.test.ts',
        '__tests__/**/stt-load.test.ts',
        '__tests__/**/load-*.test.ts',
        '__tests__/**/zero-downtime-deploy.test.ts',
        '__tests__/**/cache-effectiveness.test.ts',
        '__tests__/**/coalescer-effectiveness.test.ts',
        // GPU provider unit tests are slow due to retry/backoff timers
        // (keep them for nightly but exclude from PR gate)
        '__tests__/**/gpu-provider-runpod.test.ts',
        '__tests__/**/gpu-provider-vast.test.ts',
        '__tests__/**/gpu-provider-tensordock.test.ts',
        '__tests__/**/gpu-providers-unit.test.ts',
        '__tests__/**/vast-client-*.test.ts',
        '__tests__/**/vast-improvements.test.ts',
      ],
      // Stricter timeout for unit tests — anything slower should move to integration tier
      testTimeout: 15_000,
      hookTimeout: 10_000,
    },
  }),
);
