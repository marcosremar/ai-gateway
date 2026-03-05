/**
 * Tests for autoscaler/config-loader.ts
 * - loadAutoscalerConfig()
 * - resolveApiKey via provider
 * - buildTier logic
 * - Dynamic instances, tiers array, profile-based config
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadAutoscalerConfig } from '../src/autoscaler/config-loader';
import type { SettingsStore } from '../src/deps';

function makeSettingsStore(settings: Record<string, unknown>): SettingsStore {
  return {
    async get(_userId: string) { return settings; },
    async patch(_userId: string, _partial: Record<string, unknown>) {},
  };
}

const BASE_AUTOSCALER = {
  enabled: true,
  threshold: 5,
  windowMinutes: 10,
  maxLatencyMs: 1500,
  idleGraceMinutes: 15,
};

describe('loadAutoscalerConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Clear relevant env vars
    for (const key of ['TENSORDOCK_API_TOKEN', 'TENSORDOCK_AUTH_ID', 'RUNPOD_API_KEY', 'VAST_API_KEY', 'MODAL_API_KEY', 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'HF_TOKEN', 'PARLE_DOCKER_IMAGE']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('returns null when autoscaler is disabled', async () => {
    const store = makeSettingsStore({ autoscaler: { enabled: false } });
    const result = await loadAutoscalerConfig('user-1', store);
    expect(result).toBeNull();
  });

  it('returns null when autoscaler settings missing', async () => {
    const store = makeSettingsStore({});
    const result = await loadAutoscalerConfig('user-1', store);
    expect(result).toBeNull();
  });

  it('returns null when enabled flag missing', async () => {
    const store = makeSettingsStore({ autoscaler: { threshold: 5 } });
    const result = await loadAutoscalerConfig('user-1', store);
    expect(result).toBeNull();
  });

  it('loads config with explicit tiers array', async () => {
    const store = makeSettingsStore({
      autoscaler: {
        ...BASE_AUTOSCALER,
        tiers: [
          {
            provider: 'runpod',
            instanceId: 'pod-123',
            endpoint: 'http://pod-123.runpod.io:8000',
          },
        ],
      },
      skypilot: { runpodApiKey: 'rp-key-123' },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.tiers).toHaveLength(1);
    expect(config!.tiers[0].provider).toBe('runpod');
    expect(config!.tiers[0].instanceId).toBe('pod-123');
    expect(config!.tiers[0].apiKey).toBe('rp-key-123');
  });

  it('applies default values for threshold, windowMinutes, maxLatencyMs', async () => {
    const store = makeSettingsStore({
      autoscaler: { enabled: true },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config).not.toBeNull();
    expect(config!.threshold).toBe(5);
    expect(config!.windowMinutes).toBe(10);
    expect(config!.maxLatencyMs).toBe(1500);
  });

  it('uses custom values when provided', async () => {
    const store = makeSettingsStore({
      autoscaler: {
        enabled: true,
        threshold: 10,
        windowMinutes: 20,
        maxLatencyMs: 3000,
        idleGraceMinutes: 30,
      },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.threshold).toBe(10);
    expect(config!.windowMinutes).toBe(20);
    expect(config!.maxLatencyMs).toBe(3000);
    expect(config!.idleGraceMinutes).toBe(30);
  });

  it('injects apiKey from skypilot settings into tiers', async () => {
    const store = makeSettingsStore({
      autoscaler: {
        ...BASE_AUTOSCALER,
        tiers: [{ provider: 'tensordock', instanceId: 'td-123' }],
      },
      skypilot: {
        tensordockApiKey: 'td-key',
        tensordockAuthId: 'td-auth',
      },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers[0].apiKey).toBe('td-key');
    expect(config!.tiers[0].authId).toBe('td-auth');
  });

  it('injects apiKey from env vars when skypilot missing', async () => {
    process.env.RUNPOD_API_KEY = 'env-rp-key';
    const store = makeSettingsStore({
      autoscaler: {
        ...BASE_AUTOSCALER,
        tiers: [{ provider: 'runpod', instanceId: 'pod-456' }],
      },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers[0].apiKey).toBe('env-rp-key');
  });

  it('builds modal API key from MODAL_TOKEN_ID + MODAL_TOKEN_SECRET', async () => {
    process.env.MODAL_TOKEN_ID = 'tid';
    process.env.MODAL_TOKEN_SECRET = 'tsec';
    const store = makeSettingsStore({
      autoscaler: {
        ...BASE_AUTOSCALER,
        tiers: [{ provider: 'modal', instanceId: 'modal-inst' }],
      },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers[0].apiKey).toBe('tid:tsec');
  });

  it('builds config from omni profiles (runpod)', async () => {
    const store = makeSettingsStore({
      autoscaler: { enabled: true },
      skypilot: { runpodApiKey: 'rp-key' },
      profiles: [
        { pipelineMode: 'omni', provider: 'runpod' },
      ],
      runpodPod: { podId: 'pod-789', directUrl: 'http://pod-789.runpod.io' },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config).not.toBeNull();
    expect(config!.tiers).toHaveLength(1);
    expect(config!.tiers[0].provider).toBe('runpod');
    expect(config!.tiers[0].instanceId).toBe('pod-789');
  });

  it('builds config from omni profiles (tensordock)', async () => {
    const store = makeSettingsStore({
      autoscaler: { enabled: true },
      skypilot: { tensordockApiKey: 'td-key', tensordockAuthId: 'td-auth' },
      profiles: [
        { pipelineMode: 'omni', provider: 'tensordock' },
      ],
      tensordockInstance: { instanceId: 'td-inst-1', endpoint: 'http://td-inst-1:8000' },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers).toHaveLength(1);
    expect(config!.tiers[0].provider).toBe('tensordock');
  });

  it('builds config from omni profiles (vast)', async () => {
    const store = makeSettingsStore({
      autoscaler: { enabled: true },
      skypilot: { vastApiKey: 'vast-key' },
      profiles: [
        { pipelineMode: 'omni', provider: 'vast' },
      ],
      vastInstance: { instanceId: 'vast-inst-1', endpoint: 'http://vast-1:8000' },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers).toHaveLength(1);
    expect(config!.tiers[0].provider).toBe('vast');
  });

  it('reads dynamic instances', async () => {
    const store = makeSettingsStore({
      autoscaler: {
        enabled: true,
        dynamicInstances: [
          { provider: 'runpod', podId: 'dynamic-pod-1', directUrl: 'http://dynamic.runpod.io' },
        ],
      },
      skypilot: { runpodApiKey: 'rp-key' },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers).toHaveLength(1);
    expect(config!.tiers[0].provider).toBe('runpod');
  });

  it('caps tiers at 10', async () => {
    const tiers = Array.from({ length: 15 }, (_, i) => ({
      provider: 'runpod',
      instanceId: `pod-${i}`,
    }));
    const store = makeSettingsStore({
      autoscaler: { ...BASE_AUTOSCALER, tiers },
      skypilot: { runpodApiKey: 'rp-key' },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers).toHaveLength(10);
  });

  it('skips non-omni profiles', async () => {
    const store = makeSettingsStore({
      autoscaler: { enabled: true },
      profiles: [
        { pipelineMode: 'pipeline', provider: 'openai' },
      ],
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers).toHaveLength(0);
  });

  it('skips profiles without GPU providers', async () => {
    const store = makeSettingsStore({
      autoscaler: { enabled: true },
      profiles: [
        { pipelineMode: 'omni', provider: 'openai' },
      ],
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers).toHaveLength(0);
  });

  it('returns null on store error', async () => {
    const store: SettingsStore = {
      async get() { throw new Error('DB error'); },
      async patch() {},
    };
    const config = await loadAutoscalerConfig('user-1', store);
    expect(config).toBeNull();
  });

  it('handles invalid Zod config gracefully (raw fallback)', async () => {
    // enabled=true but other fields invalid types
    const store = makeSettingsStore({
      autoscaler: {
        enabled: true,
        threshold: 'not-a-number', // invalid but enabled=true
      },
    });

    // Should still return a config (using raw fallback)
    const config = await loadAutoscalerConfig('user-1', store);
    // enabled=true, so should return config
    expect(config).not.toBeNull();
  });

  it('includes gpuTypes in config when set', async () => {
    const store = makeSettingsStore({
      autoscaler: {
        ...BASE_AUTOSCALER,
        gpuTypes: ['RTX3090', 'A100'],
      },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.gpuTypes).toEqual(['RTX3090', 'A100']);
  });

  it('sets backward-compat fields from first tier', async () => {
    const store = makeSettingsStore({
      autoscaler: {
        ...BASE_AUTOSCALER,
        tiers: [{ provider: 'runpod', instanceId: 'pod-1', endpoint: 'http://pod-1' }],
      },
      skypilot: { runpodApiKey: 'rp-key' },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.gpuProvider).toBe('runpod');
    expect(config!.gpuInstanceId).toBe('pod-1');
    expect(config!.gpuEndpoint).toBe('http://pod-1');
  });

  it('includes hfToken and dockerImage in tiers', async () => {
    const store = makeSettingsStore({
      autoscaler: {
        ...BASE_AUTOSCALER,
        tiers: [{ provider: 'runpod', instanceId: 'pod-1' }],
      },
      skypilot: {
        runpodApiKey: 'rp-key',
        hfToken: 'hf-token-123',
        dockerImage: 'myimage:latest',
      },
    });

    const config = await loadAutoscalerConfig('user-1', store);
    expect(config!.tiers[0].hfToken).toBe('hf-token-123');
    expect(config!.tiers[0].dockerImage).toBe('myimage:latest');
  });
});
