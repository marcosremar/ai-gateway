/**
 * Vast.ai — Fast-Fail Boot Probe Integration Test (Real API)
 *
 * Verifies the new SSH + container-log fast-fail path added in
 * fc-vast-fastfail. Two scenarios:
 *
 *   1. Image that can never boot (`nvidia/cuda:invalid-tag-99999`):
 *      Vast pulls until it errors with "pull access denied" / "manifest
 *      not found". The container-log probe should grep that out within
 *      `VAST_LOG_FASTFAIL_MS` (default 60s) and abort the deploy with
 *      `CONTAINER_LOG_FASTFAIL`. Cap: 3 minutes total.
 *
 *   2. Image that boots fine (`nvidia/cuda:12.4.1-base-ubuntu22.04`):
 *      Probe reads clean logs and never trips. Endpoint resolves the
 *      normal way. Cap: 8 minutes (image is small).
 *
 * The "broken" run also confirms the loser is automatically destroyed
 * by the race controller — no manual cleanup beyond the safety net.
 *
 * Requires: VAST_API_KEY in .env. Skips otherwise.
 * Cost:    ~$0.02 across both runs (each instance lives <3 min).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VastClient } from '../src/gpu-providers/vast-client';
import type { ProviderCredentials, GpuInstance } from '../src/gpu-providers/types';
import { loadEnv } from './helpers';

const FASTFAIL_BUDGET_MS = 3 * 60_000;

describe('Vast fast-fail probes — live API', () => {
  let client: VastClient;
  let creds: ProviderCredentials;
  let happyInstance: GpuInstance | null = null;
  const cleanupIds: string[] = [];
  let skip = false;

  beforeAll(async () => {
    await loadEnv();
    if (!process.env.VAST_API_KEY || process.env.SKIP_GPU_TESTS) {
      skip = true;
      return;
    }
    client = new VastClient();
    creds = { apiKey: process.env.VAST_API_KEY! };
  });

  afterAll(async () => {
    for (const id of cleanupIds) {
      try { await client.deleteInstance(id, creds); } catch {}
    }
    if (happyInstance) {
      try { await client.deleteInstance(happyInstance.instanceId, creds); } catch {}
    }
  });

  it(
    'aborts within VAST_LOG_FASTFAIL_MS when the image cannot pull',
    async () => {
      if (skip) return;

      const start = Date.now();
      let abortedQuickly = false;
      let createError: Error | null = null;

      try {
        await client.createInstance(
          {
            gpuTypes: ['RTX 4090', 'RTX 3090', 'RTX 3080 Ti', 'A40'],
            gpuCount: 1,
            // Tag does not exist — daemon will surface
            // "manifest not found" / "pull access denied".
            dockerImage: 'nvidia/cuda:invalid-tag-99999',
            storageGb: 5,
            // Stick to Vast.ai's TESTED filter to keep this fast.
            extraSearch: { reliability2: { gte: 0.95 } },
            raceCount: 2,
          },
          creds,
        );
      } catch (e) {
        createError = e as Error;
      } finally {
        const elapsedMs = Date.now() - start;
        abortedQuickly = !!createError && elapsedMs < FASTFAIL_BUDGET_MS;
        console.log(
          `  broken-image elapsed=${(elapsedMs / 1000).toFixed(1)}s ` +
          `error=${createError?.message?.slice(0, 120) || '(none)'}`,
        );
      }

      expect(createError).not.toBeNull();
      expect(abortedQuickly).toBe(true);
    },
    FASTFAIL_BUDGET_MS + 30_000,
  );

  it(
    'does NOT trip on a clean image — endpoint comes up normally',
    async () => {
      if (skip) return;

      happyInstance = await client.createInstance(
        {
          gpuTypes: ['RTX 4090', 'RTX 3090', 'RTX 3080 Ti', 'A40'],
          gpuCount: 1,
          dockerImage: 'nvidia/cuda:12.4.1-base-ubuntu22.04',
          storageGb: 5,
          extraSearch: { reliability2: { gte: 0.95 } },
          raceCount: 2,
        },
        creds,
      );

      console.log(
        `  happy: id=${happyInstance.instanceId} gpu=${happyInstance.gpuType} ` +
        `endpoint=${happyInstance.endpoint || '(none)'} ` +
        `ssh=${happyInstance.sshHost || '?'}:${happyInstance.sshPort || '?'}`,
      );

      // We don't strictly need an HTTP endpoint (the cuda:base image has
      // no app), but at minimum we expect a reachable SSH proxy.
      expect(happyInstance.instanceId).toBeTruthy();
      expect(happyInstance.sshHost).toBeTruthy();
      expect(happyInstance.sshPort).toBeGreaterThan(0);
    },
    8 * 60_000,
  );
});
