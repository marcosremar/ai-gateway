/**
 * Stall Abort Boundary Tests — gpu-poll-health.ts
 *
 * Verifies the exact boundary of the identicalHealthCount >= 20 stall abort
 * logic inside pollHealthUntilReady's /health polling loop.
 *
 * Strategy: mock fetch + provider client + all server deps, then drive
 * pollHealthUntilReady with a controlled sequence of health responses.
 * We also mock setTimeout so the poll delay doesn't slow the test suite down.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. Mock server/state (must come before any import of the module) ──────────

const _state: Record<string, unknown> = {
  status: 'idle',
  deployId: 'test-deploy',
  podId: 'pod-123',
  endpoint: 'http://gpu:8000',
  gpuType: '',
  dockerImage: 'test-image:latest',
  message: '',
  step: '',
  stepDetail: '',
  startedAt: 0,
  retryCount: 0,
  provider: '',
  alert: '',
  alertLevel: 'info',
  sshHost: '',
  sshPort: 0,
  lastLogs: '',
  deployDurationMs: 0,
  costPerHr: 0,
  providerMeta: {},
  transitions: [],
  gpuTemp: 0,
  gpuUtil: -1,
  gpuMemUsed: 0,
  gpuMemTotal: 0,
  canary: null,
  canaryEvalTimer: null,
  templateHashId: undefined,
  deployCancelled: false,
  pullHistory: [],
  warmingStatus: null,
  networkDegraded: false,
  readinessProbe: 'http',
};

vi.mock('../../server/state', () => ({
  get deployState() { return _state; },
  setDeployState: vi.fn((patch: Record<string, unknown>) => { Object.assign(_state, patch); }),
  get deployCancelled() { return _state.deployCancelled as boolean; },
  setLastRequestTime: vi.fn(),
  updateGpuModelWarmth: vi.fn(),
  setDeployCancelled: vi.fn(),
  setDeployLock: vi.fn(),
  clearPersistedDeploy: vi.fn(),
}));

vi.mock('../../server/ws-state', () => ({
  broadcastWs: vi.fn(),
}));

vi.mock('../../server/providers', () => ({
  registry: {},
}));

// ── 2. Mock pull-time-estimator (async import inside pollHealthUntilReady) ────

vi.mock('../../src/gpu-providers/pull-time-estimator', () => ({
  estimatePullTimeout: vi.fn(() =>
    Promise.resolve({ timeoutMs: 10 * 60_000, confidence: 'low', basis: 'test' })
  ),
  deriveHostKey: vi.fn(() => 'test-host-key'),
}));

// ── 3. Mock docker-registry (async import inside pollHealthUntilReady) ─────────

vi.mock('../../src/gateway/providers/gpu/docker-registry', () => ({
  autoRegisterDockerProvider: vi.fn(() => Promise.resolve()),
}));

// ── 4. Mock deploy-settings so per-provider timeout is large (no global bail) ─

vi.mock('../../src/gpu-providers/deploy-settings', () => ({
  getDeployTimeoutMin: vi.fn(() => 60),
  getDeployTimeoutMinForProvider: vi.fn(() => 60),
}));

// ── 5. Mock logger ─────────────────────────────────────────────────────────────

vi.mock('../../src/logger', () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ── 6. Mock RunpodClient (imported in gpu-poll-health.ts top-level) ───────────

vi.mock('../../src/gpu-providers/runpod-client', () => ({
  RunpodClient: vi.fn(),
}));

// ── 7. Mock docker-manifest ───────────────────────────────────────────────────

vi.mock('../../src/gateway/providers/gpu/docker-manifest', () => ({
  validateDockerContractManifest: vi.fn(() => ({ ok: true, errors: [], paths: [] })),
  defaultApiPathsForCapabilities: vi.fn(() => []),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import type { GpuProviderClient, ProviderCredentials } from '../../src/gpu-providers/types';

/** Minimal provider client — never terminates the pod, reports it as 'running'. */
function makeProviderClient(): GpuProviderClient {
  return {
    listOffers: vi.fn(() => Promise.resolve([])),
    createInstance: vi.fn(() => Promise.resolve({ instanceId: 'pod-123' })),
    getInstanceStatus: vi.fn(() => Promise.resolve('running')),
    getInstanceDetail: vi.fn(() => Promise.resolve(null)),
    stopInstance: vi.fn(() => Promise.resolve()),
    deleteInstance: vi.fn(() => Promise.resolve()),
    resolveInstanceEndpoint: vi.fn(() => Promise.resolve(null)),
    checkBalance: vi.fn(() => Promise.resolve(null)),
  } as unknown as GpuProviderClient;
}

/**
 * Build a fetch mock that returns a fixed loading health body N times, then
 * optionally switches to a different body.
 *
 * Returns { fetchMock, callCount } so tests can inspect invocations.
 */
function makeFetchSequence(sequence: Array<{ body: object; status?: number }>): {
  fetchMock: typeof fetch;
  getCallCount: () => number;
} {
  let callCount = 0;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    // Provider status endpoint or any non-health URL → 404 (ignored by logic)
    if (!url.includes('/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 }) as Response;
    }

    const idx = Math.min(callCount, sequence.length - 1);
    const { body, status = 200 } = sequence[idx];
    callCount++;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }) as Response;
  }) as unknown as typeof fetch;

  return { fetchMock, getCallCount: () => callCount };
}

/** Suppress the real setTimeout delays inside the polling loop. */
function patchSetTimeout() {
  const real = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    (fn: TimerHandler, _delay?: number, ...args: unknown[]) => {
      // Run the callback synchronously so the loop doesn't actually wait.
      if (typeof fn === 'function') fn(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
  );
  return () => { spy.mockRestore(); void real; };
}

// ── Import the module under test AFTER all vi.mock() calls ────────────────────

import { pollHealthUntilReady } from '../../server/gpu-poll-health';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('stall abort boundary — identicalHealthCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mutable deploy state between tests
    Object.assign(_state, {
      status: 'idle',
      deployCancelled: false,
      sshHost: '',
      sshPort: 0,
      readinessProbe: 'http',
      pullHistory: [],
      alert: '',
      alertLevel: 'info',
      warmingStatus: null,
      networkDegraded: false,
    });
  });

  /**
   * Helper: run pollHealthUntilReady with a Vast-like provider client
   * and a pre-built fetch mock. The endpoint is set so /health is probed
   * on the very first iteration. Container is pre-marked as started
   * (containerStartedAt tracked internally by the function, but the
   * provider returns 'running' from tick 1 so the fn will mark it started).
   */
  async function runPoll(fetchMock: typeof fetch): Promise<import('../../server/gpu-poll-health').PollHealthResult> {
    const provider = makeProviderClient();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    const restore = patchSetTimeout();
    try {
      return await pollHealthUntilReady(
        provider,
        'vast',               // providerName
        'test-api-key',       // apiKey
        'pod-123',            // podId
        'http://gpu:8000',    // endpoint — set so /health is immediately probed
        Date.now() - 1000,    // deployStartedAt — 1s ago (well within timeouts)
        'test-image:latest',  // dockerImage
        { inetDown: 500, diskGb: 20 }, // providerMeta
        [],                   // expectedApiPaths
        [],                   // expectedCapabilities
        false,                // requireDockerManifest
        false,                // runSmokeTests
      );
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  }

  // ── Shared health bodies ────────────────────────────────────────────────────

  const LOADING_BODY = {
    status: 'loading',
    services: { whisper: 'downloading', llama_cpp: 'loading', tts: 'loading' },
  };

  const LOADING_BODY_V2 = {
    status: 'loading',
    services: { whisper: 'loading', llama_cpp: 'loading', tts: 'loading' },
  };

  const READY_BODY = {
    status: 'healthy',
    services: { whisper: 'loaded', llama_cpp: 'ready', tts: 'loaded' },
  };

  // ── Test 1: 19 identical responses → does NOT abort ────────────────────────

  it('19 identical /health responses do NOT trigger stall abort', async () => {
    // 19 identical loading responses, then a ready body so the loop exits cleanly
    const sequence = [
      ...Array.from({ length: 19 }, () => ({ body: LOADING_BODY })),
      { body: READY_BODY },
    ];

    // STT inference call will be attempted when services are loaded — return empty 200
    const { fetchMock } = makeFetchSequence(sequence);

    // Augment: any non-/health URL (inference tests) → always 200 with valid response
    const wrappedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/audio/transcriptions') || url.includes('/v1/translate') || url.includes('/v1/chat') || url.includes('/v1/audio/speech')) {
        // Return a valid STT response so the inference test passes
        return new Response(JSON.stringify({ text: '' }), { status: 200 }) as Response;
      }
      return fetchMock(input, init);
    }) as unknown as typeof fetch;

    const result = await runPoll(wrappedFetch);

    // Should complete as ready — not timeout
    expect(result.result).toBe('ready');
  }, 30_000);

  // ── Test 2: 20 identical responses → DOES abort with result 'timeout' ──────

  it('20 identical /health responses trigger stall abort with result "timeout"', async () => {
    // 20 identical loading responses — never becomes ready
    const sequence = Array.from({ length: 25 }, () => ({ body: LOADING_BODY }));
    const { fetchMock } = makeFetchSequence(sequence);

    const result = await runPoll(fetchMock as unknown as typeof fetch);

    expect(result.result).toBe('timeout');
  }, 30_000);

  // ── Test 3: counter resets on body change ──────────────────────────────────

  it('counter resets if body changes at count=15, new stall from 0', async () => {
    // 15 identical → body changes (resets counter) → 19 more identical (count=19, no abort)
    // then a ready body to exit cleanly
    const sequence = [
      ...Array.from({ length: 15 }, () => ({ body: LOADING_BODY })),
      { body: LOADING_BODY_V2 },                                      // change at 15 → counter resets
      ...Array.from({ length: 19 }, () => ({ body: LOADING_BODY_V2 })), // 19 more identical → count=19, no abort
      { body: READY_BODY },                                           // finally ready
    ];

    const wrappedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/audio/transcriptions') || url.includes('/v1/translate') || url.includes('/v1/chat') || url.includes('/v1/audio/speech')) {
        return new Response(JSON.stringify({ text: '' }), { status: 200 }) as Response;
      }
      return makeFetchSequence(sequence).fetchMock(input, init);
    }) as unknown as typeof fetch;

    // Build a proper sequential fetch for /health — the inner helper is stateful
    let idx = 0;
    const seqFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/health')) {
        const entry = sequence[Math.min(idx, sequence.length - 1)];
        idx++;
        return new Response(JSON.stringify(entry.body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as Response;
      }
      // inference / manifest / openapi endpoints
      if (url.includes('/v1/audio/transcriptions')) {
        return new Response(JSON.stringify({ text: '' }), { status: 200 }) as Response;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 }) as Response;
    }) as unknown as typeof fetch;

    const result = await runPoll(seqFetch);

    // Should resolve ready (counter reset means stall never hit 20)
    expect(result.result).toBe('ready');
  }, 30_000);

  // ── Test 3b: variant — change at 15, then 20 MORE identical → abort ─────────

  it('change at count=15 resets counter; 20 additional identical responses abort', async () => {
    // 15 identical → 1 different → 20 identical again → abort
    const allLoading1 = Array.from({ length: 15 }, () => ({ body: LOADING_BODY }));
    const changeOnce = [{ body: LOADING_BODY_V2 }];
    const allLoading2 = Array.from({ length: 25 }, () => ({ body: LOADING_BODY_V2 }));
    const sequence = [...allLoading1, ...changeOnce, ...allLoading2];

    let idx = 0;
    const seqFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/health')) {
        const entry = sequence[Math.min(idx, sequence.length - 1)];
        idx++;
        return new Response(JSON.stringify(entry.body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as Response;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 }) as Response;
    }) as unknown as typeof fetch;

    const result = await runPoll(seqFetch);

    expect(result.result).toBe('timeout');
  }, 30_000);
});
