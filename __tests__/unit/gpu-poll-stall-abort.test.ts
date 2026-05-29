/**
 * gpu-poll-stall-abort.test.ts
 *
 * Verifies that pollHealthUntilReady returns { result: 'timeout' } when it
 * receives 20 consecutive identical /health responses (stalled-download guard).
 *
 * Strategy: mock fetch to always return { status: 'loading' }, use fake timers
 * to skip the 30-second poll sleep, and drive the loop until it aborts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock all server-layer dependencies before importing the module ────────────

vi.mock('../../server/state', () => {
  const state: Record<string, unknown> = {
    status: 'idle',
    deployId: 'test-deploy-id',
    podId: '',
    endpoint: '',
    gpuType: '',
    dockerImage: '',
    message: '',
    step: '',
    stepDetail: '',
    startedAt: 0,
    retryCount: 0,
    provider: '',
    alert: '',
    sshHost: '',
    sshPort: 0,
    lastLogs: '',
    deployDurationMs: 0,
    costPerHr: 0,
    providerMeta: {},
    transitions: [],
    readinessProbe: 'http', // must be 'http' so we don't enter SSH mode
    deployCancelled: false,
  };
  return {
    get deployState() { return state; },
    setDeployState: vi.fn((patch: Record<string, unknown>) => { Object.assign(state, patch); }),
    deployCancelled: false,
    setLastRequestTime: vi.fn(),
    updateGpuModelWarmth: vi.fn(),
  };
});

vi.mock('../../server/ws-state', () => ({
  broadcastWs: vi.fn(),
}));

vi.mock('../../server/providers', () => ({
  registry: {},
}));

// Mock pull-time-estimator (dynamically imported inside pollHealthUntilReady)
vi.mock('../../src/gpu-providers/pull-time-estimator', () => ({
  estimatePullTimeout: vi.fn(async () => ({
    timeoutMs: 30 * 60_000, // 30-minute pull timeout
    confidence: 'low',
    basis: 'default',
  })),
  deriveHostKey: vi.fn(() => 'test-host'),
}));

// Mock docker-registry (dynamically imported for auto-registration)
vi.mock('../../src/gateway/providers/gpu/docker-registry', () => ({
  autoRegisterDockerProvider: vi.fn(async () => {}),
}));

// Mock deploy-settings to return a large overall timeout (avoid global timeout)
vi.mock('../../src/gpu-providers/deploy-settings', () => ({
  getDeployTimeoutMin: vi.fn(() => 45),
  getDeployTimeoutMinForProvider: vi.fn(() => 45),
}));

// Mock docker-manifest validation
vi.mock('../../src/gateway/providers/gpu/docker-manifest', () => ({
  validateDockerContractManifest: vi.fn(async () => null),
  defaultApiPathsForCapabilities: vi.fn(() => []),
}));

// Mock RunpodClient (imported at module level)
vi.mock('../../src/gpu-providers/runpod-client', () => ({
  RunpodClient: class {
    providerId = 'runpod';
    bootTimeSecs = 120;
    discoverInstance = vi.fn(async () => null);
    createInstance = vi.fn(async () => ({}));
    startInstance = vi.fn(async () => {});
    stopInstance = vi.fn(async () => {});
    deleteInstance = vi.fn(async () => {});
    getInstanceStatus = vi.fn(async () => 'running');
    listInstances = vi.fn(async () => []);
    resolveInstanceEndpoint = vi.fn(async () => null);
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { pollHealthUntilReady } from '../../server/gpu-poll-health';
import type { GpuProviderClient, ProviderCredentials } from '../../src/gpu-providers/types';

// ── Minimal mock provider ─────────────────────────────────────────────────────

function makeMockProvider(): GpuProviderClient {
  return {
    providerId: 'mock',
    bootTimeSecs: 10,
    discoverInstance: vi.fn(async () => null),
    createInstance: vi.fn(async () => ({} as any)),
    startInstance: vi.fn(async () => {}),
    stopInstance: vi.fn(async () => {}),
    deleteInstance: vi.fn(async () => {}),
    getInstanceStatus: vi.fn(async () => 'running'),
    listInstances: vi.fn(async () => []),
    resolveInstanceEndpoint: vi.fn(async () => null),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('pollHealthUntilReady — stall abort after 20 identical /health responses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns { result: "timeout" } after 20 consecutive identical /health responses', async () => {
    // Always return { status: 'loading' } — the same body every poll
    const healthBody = JSON.stringify({ status: 'loading' });

    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      if (urlStr.includes('/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'loading' }),
          text: async () => healthBody,
        } as Response;
      }
      // Any other request (preflight, speed test) — connection refused equivalent
      throw new Error('connect ECONNREFUSED');
    });

    const provider = makeMockProvider();
    const deployStartedAt = Date.now();

    // Start the poll loop and drive fake timers concurrently
    const pollPromise = pollHealthUntilReady(
      provider,
      'mock',
      'test-api-key',
      'pod-123',
      'http://localhost:9999',
      deployStartedAt,
      'test-image:latest',
      {},       // providerMeta
      [],       // expectedApiPaths
      [],       // expectedCapabilities
      false,    // requireDockerManifest
      false,    // runSmokeTests — skip smoke tests entirely
    );

    // Drive the async loop: each poll iteration awaits setTimeout(r, pollMs).
    // After health responds (ok=true, allServicesLoaded=false) pollMs=2000;
    // after allServicesLoaded pollMs=30000. We need at least 21 health calls
    // (first sets lastHealthBody, then 20 more identical ones trigger abort).
    //
    // Use a loop that repeatedly flushes microtasks + advances fake time until
    // the promise settles.
    const advanceLoop = async () => {
      for (let i = 0; i < 30; i++) {
        // Let all pending microtasks run (fetch resolution, etc.)
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        // Advance fake clock past the poll sleep (up to 30s per tick)
        vi.advanceTimersByTime(30_000);
        // Check if promise resolved by racing with a settled check
      }
    };

    const [result] = await Promise.all([pollPromise, advanceLoop()]);

    expect(result.result).toBe('timeout');
    // fetch should have been called at least 21 times (1 seed + 20 identical)
    const healthCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => String(url).includes('/health'),
    );
    expect(healthCalls.length).toBeGreaterThanOrEqual(21);
  });
});
