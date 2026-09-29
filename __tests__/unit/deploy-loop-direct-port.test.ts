/**
 * deploy-loop-direct-port.test.ts
 *
 * Verifies that startDeployLoop with extra.requireDirectPort = true:
 *   1. Passes directPortRequired=1 to createInstance
 *   2. When Phase-1 returns 0 direct-port offers (mock throws "No GPUs available"),
 *      Phase-2 (SSH-only fallback) is NOT attempted
 *   3. Deploy fails with a message matching "No GPUs available" (not a tunnel hang)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all server/state dependencies BEFORE importing the module under test ──

const stateObj = {
  status: 'idle' as string,
  deployId: 'test-deploy-id',
  podId: '',
  endpoint: '',
  gpuType: '',
  dockerImage: '',
  message: '',
  step: '',
  stepDetail: '',
  startedAt: Date.now(),
  retryCount: 0,
  provider: '',
  alert: '',
  alertLevel: 'info' as string,
  sshHost: '',
  sshPort: 0,
  lastLogs: '',
  deployDurationMs: 0,
  costPerHr: 0,
  providerMeta: {} as Record<string, unknown>,
  transitions: [] as unknown[],
  gpuTemp: 0,
  gpuUtil: -1,
  gpuMemUsed: 0,
  gpuMemTotal: 0,
  canary: null,
  canaryEvalTimer: null,
  templateHashId: undefined,
  deployCancelled: false,
};

vi.mock('../../server/state', () => ({
  get deployState() { return stateObj; },
  setDeployState: vi.fn((patch: Record<string, unknown>) => { Object.assign(stateObj, patch); }),
  deployCancelled: false,
  setDeployCancelled: vi.fn(),
  getDeployAbortSignal: () => new AbortController().signal,
  setActiveProvider: vi.fn(),
  setGpuHealthy: vi.fn(),
  setLastRequestTime: vi.fn(),
  deploymentSM: {
    startDeploying: vi.fn(),
    startBooting: vi.fn(),
    markReady: vi.fn(),
    markError: vi.fn(),
    markStopped: vi.fn(),
    reset: vi.fn(),
    get isStopped() { return false; },
  },
}));

vi.mock('../../server/metrics', () => ({
  logGpuEvent: vi.fn(),
}));

vi.mock('../../server/ws-state', () => ({
  broadcastWs: vi.fn(),
  broadcastProviderStatus: vi.fn(),
}));

vi.mock('../../server/gpu-poll-health', () => ({
  pollHealthUntilReady: vi.fn(),
}));

vi.mock('../../server/gpu-deploy-canary', () => ({
  startCanaryIfEnabled: vi.fn(),
}));

vi.mock('../../server/tier-ranking', () => ({
  recordTierLatency: vi.fn(),
}));

vi.mock('../../server/gpu-health-monitor', () => ({
  startGpuMonitoring: vi.fn(),
  startBackgroundWarmthMonitor: vi.fn(),
}));

vi.mock('../../src/errors/deploy-errors', () => ({
  categorizeDeployError: vi.fn((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    return { message: msg, code: 'NO_OFFERS', category: 'offer' };
  }),
}));

vi.mock('../../src/error-summary', () => ({
  errorSummary: { record: vi.fn() },
}));

vi.mock('../../src/auto-remediation', () => ({
  tryAutoRemediation: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../src/logger', () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/gpu-providers/deploy-orchestrator', () => ({
  PROVIDER_LABELS: { vast: 'Vast.ai', runpod: 'RunPod', tensordock: 'TensorDock', modal: 'Modal', snapgpu: 'SnapGPU', 'vast-vm': 'Vast.ai VM', hyperstack: 'Hyperstack' },
  DEFAULT_STORAGE_GB: { vast: 40, runpod: 50, tensordock: 50, modal: 50, snapgpu: 50, 'vast-vm': 50, hyperstack: 50 },
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('startDeployLoop — requireDirectPort=true', () => {
  // Build a minimal mock GpuProviderClient
  const mockCreateInstance = vi.fn();

  const providerClient = {
    createInstance: mockCreateInstance,
    deleteInstance: vi.fn(),
    discoverInstance: vi.fn(() => Promise.resolve(null)),
    startInstance: vi.fn(),
    resolveInstanceEndpoint: vi.fn(),
    listInstances: vi.fn(() => Promise.resolve([])),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset state object
    Object.assign(stateObj, {
      status: 'idle',
      message: '',
      step: '',
      podId: '',
      endpoint: '',
      gpuType: '',
    });
  });

  it('fails immediately with "No GPUs available" when Phase-1 returns 0 direct-port offers', async () => {
    // Simulate what vast-client throws when Phase-1 returns 0 offers AND
    // directPortRequired suppresses Phase-2.
    mockCreateInstance.mockRejectedValueOnce(
      new Error('No GPUs available on Vast.ai (0 offers matched). GPU filter: [RTX 4090], disk: 40GB'),
    );

    const { startDeployLoop } = await import('../../server/gpu-deploy-loop');

    await startDeployLoop(
      providerClient as any,
      'vast',
      'fake-api-key',
      'myrepo/myimage:latest',
      ['NVIDIA GeForce RTX 4090'],
      undefined,
      { requireDirectPort: true },
    );

    // createInstance must have been called exactly once (no retries for "no offers")
    expect(mockCreateInstance).toHaveBeenCalledTimes(1);

    // The spec passed to createInstance must include directPortRequired: 1
    const callArgs = mockCreateInstance.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.directPortRequired).toBe(1);

    // Final deploy state must reflect failure, not a tunnel-hang "booting" state
    expect(stateObj.status).toBe('error');
    expect(stateObj.message).toMatch(/no gpus available|vast\.ai failed/i);
  });

  it('does NOT call createInstance a second time (no Phase-2 retry) when no direct-port offers found', async () => {
    mockCreateInstance.mockRejectedValue(
      new Error('No GPUs available on Vast.ai (0 offers matched). GPU filter: [RTX 4090], disk: 40GB'),
    );

    const { startDeployLoop } = await import('../../server/gpu-deploy-loop');

    await startDeployLoop(
      providerClient as any,
      'vast',
      'fake-api-key',
      'myrepo/myimage:latest',
      ['NVIDIA GeForce RTX 4090'],
      undefined,
      { requireDirectPort: true },
    );

    // "No GPUs available" is non-retryable — createInstance called only once
    expect(mockCreateInstance).toHaveBeenCalledTimes(1);
    expect(stateObj.status).toBe('error');
  });

  it('passes directPortRequired=1 in createInstance spec', async () => {
    mockCreateInstance.mockRejectedValueOnce(
      new Error('No GPUs available on Vast.ai (0 offers matched). GPU filter: [RTX 4090], disk: 40GB'),
    );

    const { startDeployLoop } = await import('../../server/gpu-deploy-loop');

    await startDeployLoop(
      providerClient as any,
      'vast',
      'fake-api-key',
      'myrepo/myimage:latest',
      ['NVIDIA GeForce RTX 4090'],
      undefined,
      { requireDirectPort: true },
    );

    const spec = mockCreateInstance.mock.calls[0][0] as Record<string, unknown>;
    expect(spec).toMatchObject({ directPortRequired: 1 });
    // SSH tunnel flag must NOT be set (would defeat the purpose)
    expect(spec.forceSshTunnel).toBeUndefined();
  });

  it('succeeds normally (no direct-port constraint) when requireDirectPort is omitted', async () => {
    // When requireDirectPort is not set, createInstance should NOT receive directPortRequired
    mockCreateInstance.mockRejectedValueOnce(
      new Error('No GPUs available on Vast.ai (0 offers matched). GPU filter: [RTX 4090], disk: 40GB'),
    );

    const { startDeployLoop } = await import('../../server/gpu-deploy-loop');

    await startDeployLoop(
      providerClient as any,
      'vast',
      'fake-api-key',
      'myrepo/myimage:latest',
      ['NVIDIA GeForce RTX 4090'],
      undefined,
      {}, // no requireDirectPort
    );

    const spec = mockCreateInstance.mock.calls[0][0] as Record<string, unknown>;
    // directPortRequired should be absent (falsy) — Phase-2 would be allowed inside vast-client
    expect(spec.directPortRequired).toBeFalsy();
  });
});
