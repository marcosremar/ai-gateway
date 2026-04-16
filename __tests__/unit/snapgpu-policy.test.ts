import { describe, it, expect } from 'vitest';
import { shouldUseSnapshot, type PersistedSnapshot } from '../src/autoscaler/snapgpu-policy';
import type { GpuTierConfig } from '../src/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTier(overrides: Partial<GpuTierConfig> = {}): GpuTierConfig {
  return {
    provider: 'snapgpu',
    apiKey: 'test',
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    snapgpuBackend: 'runpod',
    snapgpuPreloadApp: 'default',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PersistedSnapshot> = {}): PersistedSnapshot {
  return {
    snapshotId: 'snap-abc123',
    appName: 'default',
    createdAt: Date.now(),
    imageRef: 'marcosremar/babelcast-subtitle:latest',
    backend: 'runpod',
    ...overrides,
  };
}

// ── Happy path ───────────────────────────────────────────────────────────────

describe('shouldUseSnapshot — happy path', () => {
  it('approves a fresh snapshot on a privileged backend', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier(),
      snapshot: makeSnapshot(),
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(true);
    if (result.use) expect(result.snapshotId).toBe('snap-abc123');
  });

  it('honors explicit snapgpuRestoreFromSnapshot override even without a persisted record', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier({ snapgpuRestoreFromSnapshot: 'snap-manual' }),
      snapshot: null,
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(true);
    if (result.use) expect(result.snapshotId).toBe('snap-manual');
  });

  it('honors explicit override even when auto-disabled', () => {
    // Manual override should skip the auto-disable gate — the caller knows
    // what they're doing and the override is a deliberate opt-in.
    const result = shouldUseSnapshot({
      tierConfig: makeTier({ snapgpuRestoreFromSnapshot: 'snap-manual' }),
      snapshot: null,
      autoDisabled: true,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(true);
  });
});

// ── Rejection reasons ────────────────────────────────────────────────────────

describe('shouldUseSnapshot — rejection reasons', () => {
  it('rejects when no snapshot persisted', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier(),
      snapshot: null,
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('no_snapshot');
  });

  it('rejects when backend is vast (strips --privileged)', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier({ snapgpuBackend: 'vast' }),
      snapshot: makeSnapshot(),
      autoDisabled: false,
      resolvedBackend: 'vast',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('provider_not_privileged');
  });

  it('rejects when backend is modal (no CRIU surface)', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier(),
      snapshot: makeSnapshot(),
      autoDisabled: false,
      resolvedBackend: 'modal',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('provider_not_privileged');
  });

  it('rejects when metrics auto-disabled the workload', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier(),
      snapshot: makeSnapshot(),
      autoDisabled: true,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('auto_disabled');
  });

  it('rejects when snapshot is older than 7 days', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const result = shouldUseSnapshot({
      tierConfig: makeTier(),
      snapshot: makeSnapshot({ createdAt: eightDaysAgo }),
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('stale_age');
  });

  it('accepts a snapshot just under the 7-day limit', () => {
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    const result = shouldUseSnapshot({
      tierConfig: makeTier(),
      snapshot: makeSnapshot({ createdAt: sixDaysAgo }),
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(true);
  });

  it('rejects when persisted imageRef differs from tierConfig.dockerImage', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier({ dockerImage: 'marcosremar/babelcast-subtitle:v2' }),
      snapshot: makeSnapshot({ imageRef: 'marcosremar/babelcast-subtitle:v1' }),
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('image_mismatch');
  });

  it('allows match when imageRef missing from snapshot (legacy data)', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier(),
      snapshot: makeSnapshot({ imageRef: undefined }),
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(true);
  });

  it('rejects GGUF workloads where CRIU is empirically slower', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier({ dockerImage: 'marcosremar/mistral-7b-gguf:latest' }),
      snapshot: makeSnapshot({ imageRef: 'marcosremar/mistral-7b-gguf:latest' }),
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('workload_unsuitable');
  });

  it('rejects llama.cpp workloads', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier({ dockerImage: 'marcosremar/llama-cpp-server:v1' }),
      snapshot: makeSnapshot({ imageRef: 'marcosremar/llama-cpp-server:v1' }),
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('workload_unsuitable');
  });

  it('rejects ollama workloads', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier({ dockerImage: 'ollama/ollama:latest' }),
      snapshot: makeSnapshot({ imageRef: 'ollama/ollama:latest' }),
      autoDisabled: false,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('workload_unsuitable');
  });
});

// ── Ordering / precedence ────────────────────────────────────────────────────

describe('shouldUseSnapshot — precedence', () => {
  it('explicit override beats provider check (caller takes responsibility)', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier({ snapgpuRestoreFromSnapshot: 'snap-forced', snapgpuBackend: 'vast' }),
      snapshot: null,
      autoDisabled: false,
      resolvedBackend: 'vast',
    });
    expect(result.use).toBe(true);
  });

  it('no_snapshot is checked before auto_disabled when snapshot is null', () => {
    const result = shouldUseSnapshot({
      tierConfig: makeTier(),
      snapshot: null,
      autoDisabled: true,
      resolvedBackend: 'runpod',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('no_snapshot');
  });

  it('auto_disabled is checked before provider capability', () => {
    // This ordering means a disabled workload on an unprivileged provider
    // reports the disable reason, which is more actionable.
    const result = shouldUseSnapshot({
      tierConfig: makeTier({ snapgpuBackend: 'vast' }),
      snapshot: makeSnapshot(),
      autoDisabled: true,
      resolvedBackend: 'vast',
    });
    expect(result.use).toBe(false);
    if (!result.use) expect(result.reason).toBe('auto_disabled');
  });
});
