/**
 * Unit tests for server/latency-scheduler.ts
 *
 * Tests the background scheduler that discovers GPU hosts and probes them on
 * adaptive intervals. All external I/O is mocked.
 *
 * Strategy:
 *   - No vi.resetModules() — module state (_timer, _running) managed manually.
 *   - Explicit mockResolvedValue/mockReturnValue per test for predictable returns.
 *   - afterEach waits for any in-flight runCycle to complete so _running is
 *     always false before the next test starts.
 *
 * Mocks: latency-db, gpu-latency, deploy-settings, logger, safe-catch, providers
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Shared settingsState snapshot ───────────────────────────────────────────

const settingsState = {
  intervalMin: 120,
  lastRunAt: 0,
  maxLatencyMs: 100,
  gpuPriorityList: ['NVIDIA GeForce RTX 4090'] as string[],
  gpuPriorityByProvider: { vast: [], runpod: [] } as Record<string, string[]>,
  gpuSortBy: 'balanced' as const,
  deployTimeoutMin: 30,
  deployRegion: '',
  deployDockerImage: '',
  minVramGb: 16,
  preferSsd: false,
};

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../server/latency-db', () => ({
  getHostsToProbe: vi.fn(async () => []),
  saveProbeResult: vi.fn(async () => {}),
  upsertHostMeta: vi.fn(async () => {}),
}));

vi.mock('../server/gpu-latency', () => ({
  probeHostFull: vi.fn(async () => ({ medianMs: 15, p90Ms: 25, samples: 5 })),
}));

vi.mock('../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/safe-catch', () => ({
  safeCatch: () => () => { /* no-op */ },
}));

vi.mock('../src/gpu-providers/deploy-settings', () => ({
  loadDeploySettings: vi.fn(async () => {}),
  saveDeploySettings: vi.fn(async () => {}),
  getDeploySettingsSnapshot: vi.fn(() => ({ ...settingsState })),
  setLastRunAt: vi.fn((ts: number) => { settingsState.lastRunAt = ts; }),
  getLatencyIntervalMin: vi.fn(() => settingsState.intervalMin),
  setLatencyIntervalMin: vi.fn(),
  getLatencyMaxMs: vi.fn(() => settingsState.maxLatencyMs),
  setLatencyMaxMs: vi.fn(),
  getGpuPriorityList: vi.fn(() => settingsState.gpuPriorityList),
  setGpuPriorityList: vi.fn(),
  getDefaultGpuPriority: vi.fn(() => []),
  getGpuPriorityForProvider: vi.fn(() => []),
  setGpuPriorityForProvider: vi.fn(),
  getDefaultGpuPriorityByProvider: vi.fn(() => ({})),
  getGpuSortBy: vi.fn(() => settingsState.gpuSortBy),
  setGpuSortBy: vi.fn(),
  getDeployTimeoutMin: vi.fn(() => settingsState.deployTimeoutMin),
  setDeployTimeoutMin: vi.fn(),
  getDeployRegion: vi.fn(() => settingsState.deployRegion),
  setDeployRegion: vi.fn(),
  getMinVramGb: vi.fn(() => settingsState.minVramGb),
  setMinVramGb: vi.fn(),
  getPreferSsd: vi.fn(() => settingsState.preferSsd),
  setPreferSsd: vi.fn(),
}));

const vastListOffersMock = vi.fn(async () => [] as any[]);
vi.mock('../server/providers', () => ({
  vast: { listOffers: vastListOffersMock },
}));

// ── Lazy imports (stable module instances throughout the test file) ─────────

let getLatencySchedulerStatus: typeof import('../server/latency-scheduler').getLatencySchedulerStatus;
let startLatencyScheduler: typeof import('../server/latency-scheduler').startLatencyScheduler;
let stopLatencyScheduler: typeof import('../server/latency-scheduler').stopLatencyScheduler;
let triggerLatencyRun: typeof import('../server/latency-scheduler').triggerLatencyRun;
let isLatencyRunning: typeof import('../server/latency-scheduler').isLatencyRunning;

let getHostsToProbe: typeof import('../server/latency-db').getHostsToProbe;
let saveProbeResult: typeof import('../server/latency-db').saveProbeResult;
let upsertHostMeta: typeof import('../server/latency-db').upsertHostMeta;
let probeHostFull: typeof import('../server/gpu-latency').probeHostFull;
let loadDeploySettings: typeof import('../src/gpu-providers/deploy-settings').loadDeploySettings;
let setLastRunAt: typeof import('../src/gpu-providers/deploy-settings').setLastRunAt;

// Import all modules once before tests run
beforeEach(async () => {
  if (!getLatencySchedulerStatus) {
    // Lazy one-time import
    const sched = await import('../server/latency-scheduler');
    getLatencySchedulerStatus = sched.getLatencySchedulerStatus;
    startLatencyScheduler = sched.startLatencyScheduler;
    stopLatencyScheduler = sched.stopLatencyScheduler;
    triggerLatencyRun = sched.triggerLatencyRun;
    isLatencyRunning = sched.isLatencyRunning;

    const db = await import('../server/latency-db');
    getHostsToProbe = db.getHostsToProbe;
    saveProbeResult = db.saveProbeResult;
    upsertHostMeta = db.upsertHostMeta;

    const gpu = await import('../server/gpu-latency');
    probeHostFull = gpu.probeHostFull;

    const settings = await import('../src/gpu-providers/deploy-settings');
    loadDeploySettings = settings.loadDeploySettings;
    setLastRunAt = settings.setLastRunAt;
  }

  // Reset shared state
  settingsState.intervalMin = 120;
  settingsState.lastRunAt = 0;
  settingsState.gpuPriorityList = ['NVIDIA GeForce RTX 4090'];
  settingsState.deployRegion = '';
  settingsState.maxLatencyMs = 100;
  settingsState.gpuSortBy = 'balanced';

  delete process.env.VAST_API_KEY;

  // Reset all mock call history and implementations
  vi.clearAllMocks();

  // Restore default implementations after clearAllMocks
  vi.mocked(getHostsToProbe).mockResolvedValue([]);
  vi.mocked(saveProbeResult).mockResolvedValue(undefined as any);
  vi.mocked(upsertHostMeta).mockResolvedValue(undefined as any);
  vi.mocked(probeHostFull).mockResolvedValue({ medianMs: 15, p90Ms: 25, samples: 5 });
  vi.mocked(loadDeploySettings).mockResolvedValue(undefined as any);
  vi.mocked(setLastRunAt).mockImplementation((ts: number) => { settingsState.lastRunAt = ts; });
  vastListOffersMock.mockResolvedValue([]);

  // Ensure no in-flight runCycle from a previous test
  stopLatencyScheduler();
  await vi.waitFor(() => {
    expect(isLatencyRunning()).toBe(false);
  }, { timeout: 3000 }).catch(() => { /* ignore if already false */ });
});

afterEach(() => {
  stopLatencyScheduler();
  vi.restoreAllMocks();
});

// ── Tests: getLatencySchedulerStatus ──────────────────────────────────────

describe('getLatencySchedulerStatus', () => {
  it('returns intervalMin from settings snapshot', () => {
    settingsState.intervalMin = 60;
    expect(getLatencySchedulerStatus().intervalMin).toBe(60);
  });

  it('returns lastRunAt from settings snapshot', () => {
    settingsState.lastRunAt = 1_234_567;
    expect(getLatencySchedulerStatus().lastRunAt).toBe(1_234_567);
  });

  it('computes nextRunAt = lastRunAt + intervalMin * 60_000', () => {
    settingsState.lastRunAt = 1_000_000;
    settingsState.intervalMin = 30;
    expect(getLatencySchedulerStatus().nextRunAt).toBe(1_000_000 + 30 * 60_000);
  });

  it('returns running=false when no cycle is active', () => {
    expect(getLatencySchedulerStatus().running).toBe(false);
  });

  it('returns maxLatencyMs from settings snapshot', () => {
    settingsState.maxLatencyMs = 250;
    expect(getLatencySchedulerStatus().maxLatencyMs).toBe(250);
  });

  it('returns gpuPriorityList from settings snapshot', () => {
    settingsState.gpuPriorityList = ['NVIDIA RTX A6000', 'NVIDIA GeForce RTX 4090'];
    expect(getLatencySchedulerStatus().gpuPriorityList).toEqual([
      'NVIDIA RTX A6000',
      'NVIDIA GeForce RTX 4090',
    ]);
  });

  it('returns gpuSortBy from settings snapshot', () => {
    settingsState.gpuSortBy = 'latency' as any;
    expect(getLatencySchedulerStatus().gpuSortBy).toBe('latency');
  });

  it('returns deployRegion from settings snapshot', () => {
    settingsState.deployRegion = 'EU';
    expect(getLatencySchedulerStatus().deployRegion).toBe('EU');
  });
});

// ── Tests: isLatencyRunning ────────────────────────────────────────────────

describe('isLatencyRunning', () => {
  it('returns false before any cycle starts', () => {
    expect(isLatencyRunning()).toBe(false);
  });
});

// ── Tests: startLatencyScheduler / stopLatencyScheduler ───────────────────

describe('startLatencyScheduler / stopLatencyScheduler', () => {
  it('calls loadDeploySettings on start', async () => {
    // Stub timers to prevent real background cycles
    const setTimeoutStub = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(1 as any);
    const setIntervalStub = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as any);

    await startLatencyScheduler();
    expect(loadDeploySettings).toHaveBeenCalledTimes(1);

    setTimeoutStub.mockRestore();
    setIntervalStub.mockRestore();
    stopLatencyScheduler();
  });

  it('is idempotent — loadDeploySettings called only once on double-start', async () => {
    // Return truthy timer IDs so the _timer !== null guard works
    const setTimeoutStub = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(99 as any);
    const setIntervalStub = vi.spyOn(globalThis, 'setInterval').mockReturnValue(99 as any);

    await startLatencyScheduler();
    await startLatencyScheduler(); // second call should bail early
    expect(vi.mocked(loadDeploySettings)).toHaveBeenCalledTimes(1);

    setTimeoutStub.mockRestore();
    setIntervalStub.mockRestore();
    stopLatencyScheduler();
  });

  it('schedules initial runCycle after 10s', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(1 as any);
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as any);

    await startLatencyScheduler();

    const initialTimers = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 10_000);
    expect(initialTimers.length).toBeGreaterThanOrEqual(1);

    vi.restoreAllMocks();
    stopLatencyScheduler();
  });

  it('sets up periodic 30-min interval', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue(1 as any);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as any);

    await startLatencyScheduler();

    const intervals = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 30 * 60_000);
    expect(intervals.length).toBeGreaterThanOrEqual(1);

    vi.restoreAllMocks();
    stopLatencyScheduler();
  });

  it('stopLatencyScheduler calls clearInterval', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue(1 as any);
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(42 as any);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    await startLatencyScheduler();
    stopLatencyScheduler();

    expect(clearIntervalSpy).toHaveBeenCalledWith(42);
    vi.restoreAllMocks();
  });

  it('stopLatencyScheduler is safe to call when not started', () => {
    expect(() => stopLatencyScheduler()).not.toThrow();
  });
});

// ── Tests: triggerLatencyRun (concurrent guard) ────────────────────────────

describe('triggerLatencyRun', () => {
  it('fires runCycle — getHostsToProbe is called', async () => {
    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(getHostsToProbe).toHaveBeenCalled();
    }, { timeout: 2000 });
  });

  it('no-ops when already running (concurrent guard)', async () => {
    // Use a resolvable promise so we can unblock runCycle at the end
    let resolveHosts: (h: any[]) => void = () => {};
    vi.mocked(getHostsToProbe).mockImplementation(
      () => new Promise(r => { resolveHosts = r as any; }),
    );

    triggerLatencyRun(); // first call — hangs on getHostsToProbe

    // Wait until the first cycle is in progress
    await vi.waitFor(() => {
      expect(getHostsToProbe).toHaveBeenCalledTimes(1);
    }, { timeout: 1000 });

    triggerLatencyRun(); // second call — should be a no-op

    // Give it time; if the guard is broken, a second call appears
    await new Promise(r => setTimeout(r, 60));
    expect(getHostsToProbe).toHaveBeenCalledTimes(1);

    // Unblock so _running resets before the next test's beforeEach
    resolveHosts([]);
    await vi.waitFor(() => expect(isLatencyRunning()).toBe(false), { timeout: 2000 });
  });
});

// ── Tests: runCycle — discovery ────────────────────────────────────────────

describe('runCycle — discovery', () => {
  it('calls vast.listOffers when VAST_API_KEY is set (forceDiscovery=true via triggerLatencyRun)', async () => {
    process.env.VAST_API_KEY = 'test-key';

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(vastListOffersMock).toHaveBeenCalled();
    }, { timeout: 2000 });
  });

  it('does NOT call vast.listOffers when VAST_API_KEY is absent', async () => {
    delete process.env.VAST_API_KEY;

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(getHostsToProbe).toHaveBeenCalled();
    }, { timeout: 2000 });

    expect(vastListOffersMock).not.toHaveBeenCalled();
  });

  it('updates lastRunAt after discovery', async () => {
    process.env.VAST_API_KEY = 'test-key';

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(vi.mocked(setLastRunAt)).toHaveBeenCalled();
    }, { timeout: 2000 });

    const ts = vi.mocked(setLastRunAt).mock.calls[0][0];
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThan(0);
  });

  it('passes gpuTypes and limit=500 to vast.listOffers', async () => {
    process.env.VAST_API_KEY = 'vk-123';
    settingsState.gpuPriorityList = ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000'];

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(vastListOffersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000'],
          limit: 500,
        }),
        expect.objectContaining({ apiKey: 'vk-123' }),
      );
    }, { timeout: 2000 });
  });
});

// ── Tests: runCycle — host probing ─────────────────────────────────────────

describe('runCycle — host probing', () => {
  it('does not call probeHostFull when no stale hosts', async () => {
    vi.mocked(getHostsToProbe).mockResolvedValue([]);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(getHostsToProbe).toHaveBeenCalled();
    }, { timeout: 2000 });

    await new Promise(r => setTimeout(r, 50));
    expect(probeHostFull).not.toHaveBeenCalled();
  });

  it('calls probeHostFull for each stale host', async () => {
    vi.mocked(getHostsToProbe).mockResolvedValue([
      { host_id: 'h1', host_ip: '10.0.0.1', direct_port: null } as any,
      { host_id: 'h2', host_ip: '10.0.0.2', direct_port: null } as any,
    ]);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(probeHostFull).toHaveBeenCalledTimes(2);
    }, { timeout: 2000 });

    expect(probeHostFull).toHaveBeenCalledWith('10.0.0.1', []);
    expect(probeHostFull).toHaveBeenCalledWith('10.0.0.2', []);
  });

  it('passes direct_port as extra port array when set', async () => {
    vi.mocked(getHostsToProbe).mockResolvedValue([
      { host_id: 'h1', host_ip: '10.0.0.5', direct_port: 8022 } as any,
    ]);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(probeHostFull).toHaveBeenCalledWith('10.0.0.5', [8022]);
    }, { timeout: 2000 });
  });

  it('saves probe result for each successfully probed host', async () => {
    const probeResult = { medianMs: 20, p90Ms: 30, samples: 4 };
    vi.mocked(getHostsToProbe).mockResolvedValue([
      { host_id: 'h1', host_ip: '10.0.0.1', direct_port: null } as any,
    ]);
    vi.mocked(probeHostFull).mockResolvedValue(probeResult);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(saveProbeResult).toHaveBeenCalledWith('h1', probeResult);
    }, { timeout: 2000 });
  });

  it('continues probing other hosts when one probe fails', async () => {
    vi.mocked(getHostsToProbe).mockResolvedValue([
      { host_id: 'h1', host_ip: '10.0.0.1', direct_port: null } as any,
      { host_id: 'h2', host_ip: '10.0.0.2', direct_port: null } as any,
    ]);
    vi.mocked(probeHostFull)
      .mockRejectedValueOnce(new Error('timeout'))  // h1 fails
      .mockResolvedValueOnce({ medianMs: 20, p90Ms: 35, samples: 3 }); // h2 ok

    triggerLatencyRun();

    await vi.waitFor(() => {
      // h1 failed so saveProbeResult only called once (for h2)
      expect(saveProbeResult).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    expect(saveProbeResult).toHaveBeenCalledWith('h2', expect.any(Object));
  });

  it('resets _running to false after cycle completes', async () => {
    vi.mocked(getHostsToProbe).mockResolvedValue([]);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(isLatencyRunning()).toBe(false);
    }, { timeout: 2000 });
  });

  it('resets _running to false even when discovery throws', async () => {
    process.env.VAST_API_KEY = 'test-key';
    vastListOffersMock.mockRejectedValueOnce(new Error('network error'));

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(isLatencyRunning()).toBe(false);
    }, { timeout: 2000 });
  });
});

// ── Tests: discoverHosts upsert behaviour ─────────────────────────────────

describe('discoverHosts — upsert', () => {
  it('upserts each offer with both hostId and hostIp', async () => {
    process.env.VAST_API_KEY = 'vk-123';
    vastListOffersMock.mockResolvedValueOnce([
      { hostId: 'h1', hostIp: '1.2.3.4', provider: 'vast', gpuName: 'RTX 4090', geolocation: 'US', pricePerHr: 0.5, hostDirectPort: 8022 },
      { hostId: 'h2', hostIp: '5.6.7.8', provider: 'vast', gpuName: 'RTX 4090', geolocation: 'EU', pricePerHr: 0.6 },
    ] as any);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(upsertHostMeta).toHaveBeenCalledTimes(2);
    }, { timeout: 2000 });

    expect(upsertHostMeta).toHaveBeenCalledWith('h1', expect.any(Object));
    expect(upsertHostMeta).toHaveBeenCalledWith('h2', expect.any(Object));
  });

  it('skips offers missing hostId', async () => {
    process.env.VAST_API_KEY = 'vk-123';
    vastListOffersMock.mockResolvedValueOnce([
      { hostId: undefined, hostIp: '1.2.3.4', provider: 'vast', gpuName: 'RTX 4090', geolocation: '', pricePerHr: 0 },
    ] as any);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(getHostsToProbe).toHaveBeenCalled();
    }, { timeout: 2000 });

    expect(upsertHostMeta).not.toHaveBeenCalled();
  });

  it('skips offers missing hostIp', async () => {
    process.env.VAST_API_KEY = 'vk-123';
    vastListOffersMock.mockResolvedValueOnce([
      { hostId: 'h1', hostIp: undefined, provider: 'vast', gpuName: 'RTX 4090', geolocation: '', pricePerHr: 0 },
    ] as any);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(getHostsToProbe).toHaveBeenCalled();
    }, { timeout: 2000 });

    expect(upsertHostMeta).not.toHaveBeenCalled();
  });

  it('upserts correct meta fields from offer', async () => {
    process.env.VAST_API_KEY = 'vk-123';
    vastListOffersMock.mockResolvedValueOnce([
      {
        hostId: 'h1',
        hostIp: '10.1.2.3',
        provider: 'vast',
        gpuName: 'NVIDIA GeForce RTX 4090',
        geolocation: 'US',
        pricePerHr: 0.75,
        hostDirectPort: 9000,
      },
    ] as any);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(upsertHostMeta).toHaveBeenCalledWith('h1', expect.objectContaining({
        hostIp: '10.1.2.3',
        provider: 'vast',
        gpuName: 'NVIDIA GeForce RTX 4090',
        geolocation: 'US',
        priceUsd: 0.75,
        directPort: 9000,
      }));
    }, { timeout: 2000 });
  });

  it('falls back to empty string/zero for missing optional offer fields', async () => {
    process.env.VAST_API_KEY = 'vk-123';
    vastListOffersMock.mockResolvedValueOnce([
      { hostId: 'h1', hostIp: '10.1.2.3' }, // provider, gpuName, geolocation, pricePerHr missing
    ] as any);

    triggerLatencyRun();

    await vi.waitFor(() => {
      expect(upsertHostMeta).toHaveBeenCalledWith('h1', expect.objectContaining({
        provider: '',
        gpuName: '',
        geolocation: '',
        priceUsd: 0,
      }));
    }, { timeout: 2000 });
  });
});
