// ── GPU Cost Audit unit tests ────────────────────────────────────────────────
// Tests the auditGpuCosts function: volume tracking, cost estimation,
// stopped-pod detection, warning collection, and destroyOrphans gating.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../src/logger', () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  }),
}));

// State is varied per test group via module-level mutable objects.
const mockDeployState: Record<string, unknown> = {};
const mockStandbyDeployState: Record<string, unknown> = {};
let mockDeployApiKey = '';

vi.mock('../server/state', () => ({
  get deployApiKey() { return mockDeployApiKey; },
  get deployState() { return mockDeployState; },
  get standbyDeployState() { return mockStandbyDeployState; },
}));

// Provider mocks — replaced per test via .mockResolvedValue / .mockRejectedValue
const listNetworkVolumesMock = vi.fn();
const deleteNetworkVolumeMock = vi.fn();
const listInstancesMock = vi.fn();

vi.mock('../server/providers', () => ({
  get runpod() {
    return {
      listNetworkVolumes: listNetworkVolumesMock,
      deleteNetworkVolume: deleteNetworkVolumeMock,
    };
  },
  get vast() {
    return {
      listInstances: listInstancesMock,
    };
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeVolume(id: string, name: string, sizeGb: number, dataCenterId = 'US-TX-3') {
  return { id, name, size: sizeGb, dataCenterId };
}

function makeVastInstance(instanceId: string, status: string, gpuType = 'RTX 4090') {
  return { instanceId, status, gpuType };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('auditGpuCosts', () => {
  beforeEach(() => {
    vi.resetModules();
    // Reset shared state
    for (const k of Object.keys(mockDeployState)) delete mockDeployState[k];
    for (const k of Object.keys(mockStandbyDeployState)) delete mockStandbyDeployState[k];
    mockDeployApiKey = '';
    listNetworkVolumesMock.mockReset();
    deleteNetworkVolumeMock.mockReset();
    listInstancesMock.mockReset();
    delete process.env.RUNPOD_API_KEY;
    delete process.env.VAST_API_KEY;
    delete process.env.RUNPOD_VOLUME_SWEEP_DESTROY;
  });

  // ── Report shape ────────────────────────────────────────────────────────

  it('returns a report with a ts string and empty arrays when no keys configured', async () => {
    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(typeof report.ts).toBe('string');
    expect(report.ts.length).toBeGreaterThan(0);
    expect(report.volumes.runpod).toEqual([]);
    expect(report.volumes.totalMonthlyUsd).toBe(0);
    expect(report.volumes.orphanCount).toBe(0);
    expect(report.stoppedPods).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  // ── Volume cost estimation ───────────────────────────────────────────────

  it('estimates monthly cost at $0.10/GB/month', async () => {
    mockDeployApiKey = 'rp-key';
    listNetworkVolumesMock.mockResolvedValue([makeVolume('v1', 'my-vol', 50)]);
    listInstancesMock.mockResolvedValue([]);
    process.env.VAST_API_KEY = 'vast-key';

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.volumes.runpod).toHaveLength(1);
    expect(report.volumes.runpod[0].estMonthlyUsd).toBeCloseTo(5.0, 5); // 50 * 0.10
    expect(report.volumes.totalMonthlyUsd).toBeCloseTo(5.0, 5);
  });

  it('accumulates totalMonthlyUsd across multiple volumes', async () => {
    mockDeployApiKey = 'rp-key';
    listNetworkVolumesMock.mockResolvedValue([
      makeVolume('v1', 'a', 10),
      makeVolume('v2', 'b', 20),
      makeVolume('v3', 'c', 30),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    // 10*0.10 + 20*0.10 + 30*0.10 = 6.00
    expect(report.volumes.totalMonthlyUsd).toBeCloseTo(6.0, 5);
  });

  // ── Volume tracking (isTrackedByName) ───────────────────────────────────

  it('marks volume as tracked when name contains active podId', async () => {
    mockDeployApiKey = 'rp-key';
    mockDeployState.podId = 'pod-abc123';
    listNetworkVolumesMock.mockResolvedValue([
      makeVolume('v1', 'vol-pod-abc123-storage', 10),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.volumes.runpod[0].tracked).toBe(true);
    expect(report.volumes.orphanCount).toBe(0);
  });

  it('marks volume as tracked when name contains standby podId', async () => {
    mockDeployApiKey = 'rp-key';
    mockStandbyDeployState.podId = 'pod-standby99';
    listNetworkVolumesMock.mockResolvedValue([
      makeVolume('v1', 'prefix-pod-standby99-suffix', 10),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.volumes.runpod[0].tracked).toBe(true);
    expect(report.volumes.orphanCount).toBe(0);
  });

  it('marks volume as orphan when name does not match any tracked pod', async () => {
    mockDeployApiKey = 'rp-key';
    mockDeployState.podId = 'pod-abc';
    listNetworkVolumesMock.mockResolvedValue([
      makeVolume('v1', 'unrelated-volume', 10),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.volumes.runpod[0].tracked).toBe(false);
    expect(report.volumes.orphanCount).toBe(1);
  });

  it('does NOT mark every volume as tracked when podId is empty string', async () => {
    mockDeployApiKey = 'rp-key';
    // Both pod IDs are empty strings — this is the critical guard.
    // '' includes '' is true, so without the activePodId.length>0 guard
    // every volume would be incorrectly marked as tracked.
    mockDeployState.podId = '';
    mockStandbyDeployState.podId = '';
    listNetworkVolumesMock.mockResolvedValue([
      makeVolume('v1', 'old-orphan-vol', 20),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.volumes.runpod[0].tracked).toBe(false);
    expect(report.volumes.orphanCount).toBe(1);
  });

  it('counts orphanCount correctly across mixed tracked/orphan volumes', async () => {
    mockDeployApiKey = 'rp-key';
    mockDeployState.podId = 'pod-xyz';
    listNetworkVolumesMock.mockResolvedValue([
      makeVolume('v1', 'vol-pod-xyz-main', 10),   // tracked
      makeVolume('v2', 'orphan-a', 5),              // orphan
      makeVolume('v3', 'orphan-b', 5),              // orphan
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.volumes.orphanCount).toBe(2);
    expect(report.volumes.runpod.filter(v => v.tracked)).toHaveLength(1);
    expect(report.volumes.runpod.filter(v => !v.tracked)).toHaveLength(2);
  });

  // ── VolumeAudit fields ──────────────────────────────────────────────────

  it('populates all VolumeAudit fields from provider response', async () => {
    mockDeployApiKey = 'rp-key';
    listNetworkVolumesMock.mockResolvedValue([
      makeVolume('vol-42', 'my-cache', 100, 'EU-DE-1'),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    const v = report.volumes.runpod[0];
    expect(v.id).toBe('vol-42');
    expect(v.name).toBe('my-cache');
    expect(v.sizeGb).toBe(100);
    expect(v.dataCenterId).toBe('EU-DE-1');
    expect(typeof v.tracked).toBe('boolean');
    expect(typeof v.estMonthlyUsd).toBe('number');
  });

  // ── Stopped pods (Vast.ai) ──────────────────────────────────────────────

  it('includes exited Vast.ai instances (not tracked) in stoppedPods', async () => {
    process.env.VAST_API_KEY = 'vast-key';
    listInstancesMock.mockResolvedValue([
      makeVastInstance('inst-1', 'exited'),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.stoppedPods).toHaveLength(1);
    expect(report.stoppedPods[0].provider).toBe('vast');
    expect(report.stoppedPods[0].instanceId).toBe('inst-1');
    expect(report.stoppedPods[0].status).toBe('exited');
    expect(report.stoppedPods[0].gpuType).toBe('RTX 4090');
  });

  it('includes stopped Vast.ai instances (not tracked) in stoppedPods', async () => {
    process.env.VAST_API_KEY = 'vast-key';
    listInstancesMock.mockResolvedValue([
      makeVastInstance('inst-2', 'stopped'),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.stoppedPods).toHaveLength(1);
    expect(report.stoppedPods[0].status).toBe('stopped');
  });

  it('excludes running Vast.ai instances from stoppedPods', async () => {
    process.env.VAST_API_KEY = 'vast-key';
    listInstancesMock.mockResolvedValue([
      makeVastInstance('inst-3', 'running'),
      makeVastInstance('inst-4', 'loading'),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.stoppedPods).toHaveLength(0);
  });

  it('excludes stopped Vast.ai instances that are tracked by deployState', async () => {
    process.env.VAST_API_KEY = 'vast-key';
    mockDeployState.podId = 'inst-tracked';
    listInstancesMock.mockResolvedValue([
      makeVastInstance('inst-tracked', 'exited'),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    // tracked pod must not appear in stoppedPods
    expect(report.stoppedPods).toHaveLength(0);
  });

  it('excludes stopped Vast.ai instances tracked by standbyDeployState', async () => {
    process.env.VAST_API_KEY = 'vast-key';
    mockStandbyDeployState.podId = 'inst-standby';
    listInstancesMock.mockResolvedValue([
      makeVastInstance('inst-standby', 'stopped'),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.stoppedPods).toHaveLength(0);
  });

  it('handles mixed running/exited/stopped Vast.ai instances', async () => {
    process.env.VAST_API_KEY = 'vast-key';
    listInstancesMock.mockResolvedValue([
      makeVastInstance('i1', 'running'),
      makeVastInstance('i2', 'exited'),
      makeVastInstance('i3', 'stopped'),
      makeVastInstance('i4', 'loading'),
    ]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.stoppedPods).toHaveLength(2);
    const ids = report.stoppedPods.map(p => p.instanceId);
    expect(ids).toContain('i2');
    expect(ids).toContain('i3');
  });

  // ── Warning collection ───────────────────────────────────────────────────

  it('adds a warning when RunPod listNetworkVolumes throws', async () => {
    mockDeployApiKey = 'rp-key';
    listNetworkVolumesMock.mockRejectedValue(new Error('network timeout'));

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.warnings.some(w => w.includes('runpod volume list failed'))).toBe(true);
    expect(report.warnings.some(w => w.includes('network timeout'))).toBe(true);
  });

  it('adds a warning when Vast.ai listInstances throws', async () => {
    process.env.VAST_API_KEY = 'vast-key';
    listInstancesMock.mockRejectedValue(new Error('auth error'));

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.warnings.some(w => w.includes('vast stopped-pod list failed'))).toBe(true);
    expect(report.warnings.some(w => w.includes('auth error'))).toBe(true);
  });

  it('continues with Vast.ai check even if RunPod fails', async () => {
    mockDeployApiKey = 'rp-key';
    process.env.VAST_API_KEY = 'vast-key';
    listNetworkVolumesMock.mockRejectedValue(new Error('rp down'));
    listInstancesMock.mockResolvedValue([makeVastInstance('i1', 'exited')]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.warnings).toHaveLength(1);
    expect(report.stoppedPods).toHaveLength(1);
  });

  it('handles non-Error throws gracefully in warnings', async () => {
    mockDeployApiKey = 'rp-key';
    listNetworkVolumesMock.mockRejectedValue('string error');

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.warnings.some(w => w.includes('runpod volume list failed'))).toBe(true);
  });

  // ── destroyOrphans gating ───────────────────────────────────────────────

  it('does not delete volumes without destroyOrphans opt-in', async () => {
    mockDeployApiKey = 'rp-key';
    process.env.RUNPOD_VOLUME_SWEEP_DESTROY = '1';
    listNetworkVolumesMock.mockResolvedValue([makeVolume('v1', 'orphan', 10)]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    await auditGpuCosts(); // destroyOrphans not set (defaults false)
    expect(deleteNetworkVolumeMock).not.toHaveBeenCalled();
  });

  it('does not delete volumes when destroyOrphans=true but env var not set', async () => {
    mockDeployApiKey = 'rp-key';
    // RUNPOD_VOLUME_SWEEP_DESTROY is NOT set
    listNetworkVolumesMock.mockResolvedValue([makeVolume('v1', 'orphan', 10)]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    await auditGpuCosts({ destroyOrphans: true });
    expect(deleteNetworkVolumeMock).not.toHaveBeenCalled();
  });

  it('deletes orphan volumes when destroyOrphans=true AND env var is set', async () => {
    mockDeployApiKey = 'rp-key';
    process.env.RUNPOD_VOLUME_SWEEP_DESTROY = '1';
    listNetworkVolumesMock.mockResolvedValue([
      makeVolume('v1', 'orphan-a', 10),
      makeVolume('v2', 'orphan-b', 5),
    ]);
    deleteNetworkVolumeMock.mockResolvedValue(undefined);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    await auditGpuCosts({ destroyOrphans: true });
    expect(deleteNetworkVolumeMock).toHaveBeenCalledTimes(2);
    expect(deleteNetworkVolumeMock).toHaveBeenCalledWith('v1', { apiKey: 'rp-key' });
    expect(deleteNetworkVolumeMock).toHaveBeenCalledWith('v2', { apiKey: 'rp-key' });
  });

  it('does not delete tracked volumes even when destroyOrphans=true', async () => {
    mockDeployApiKey = 'rp-key';
    process.env.RUNPOD_VOLUME_SWEEP_DESTROY = '1';
    mockDeployState.podId = 'pod-keep';
    listNetworkVolumesMock.mockResolvedValue([
      makeVolume('v1', 'vol-pod-keep-data', 10),  // tracked → skip
      makeVolume('v2', 'orphan', 10),               // orphan → delete
    ]);
    deleteNetworkVolumeMock.mockResolvedValue(undefined);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    await auditGpuCosts({ destroyOrphans: true });
    expect(deleteNetworkVolumeMock).toHaveBeenCalledTimes(1);
    expect(deleteNetworkVolumeMock).toHaveBeenCalledWith('v2', { apiKey: 'rp-key' });
  });

  it('adds warning when volume deletion fails during destroyOrphans pass', async () => {
    mockDeployApiKey = 'rp-key';
    process.env.RUNPOD_VOLUME_SWEEP_DESTROY = '1';
    listNetworkVolumesMock.mockResolvedValue([makeVolume('v1', 'orphan', 10)]);
    deleteNetworkVolumeMock.mockRejectedValue(new Error('permission denied'));

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts({ destroyOrphans: true });
    expect(report.warnings.some(w => w.includes('delete volume v1 failed'))).toBe(true);
    expect(report.warnings.some(w => w.includes('permission denied'))).toBe(true);
  });

  // ── Both providers active ───────────────────────────────────────────────

  it('combines RunPod volumes and Vast.ai stopped pods in a single report', async () => {
    mockDeployApiKey = 'rp-key';
    process.env.VAST_API_KEY = 'vast-key';
    listNetworkVolumesMock.mockResolvedValue([makeVolume('v1', 'old-vol', 20)]);
    listInstancesMock.mockResolvedValue([makeVastInstance('i1', 'exited')]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.volumes.runpod).toHaveLength(1);
    expect(report.stoppedPods).toHaveLength(1);
    expect(report.warnings).toHaveLength(0);
  });

  // ── API key resolution ──────────────────────────────────────────────────

  it('uses RUNPOD_API_KEY env var when deployApiKey is empty', async () => {
    process.env.RUNPOD_API_KEY = 'env-rp-key';
    listNetworkVolumesMock.mockResolvedValue([makeVolume('v1', 'vol', 10)]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.volumes.runpod).toHaveLength(1);
    // Verify the env key was passed to the provider
    expect(listNetworkVolumesMock).toHaveBeenCalledWith({ apiKey: 'env-rp-key' });
  });

  it('prefers deployApiKey over RUNPOD_API_KEY env var', async () => {
    mockDeployApiKey = 'deploy-key';
    process.env.RUNPOD_API_KEY = 'env-key';
    listNetworkVolumesMock.mockResolvedValue([]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    await auditGpuCosts();
    expect(listNetworkVolumesMock).toHaveBeenCalledWith({ apiKey: 'deploy-key' });
  });

  it('skips RunPod check entirely when no RunPod key is available', async () => {
    // No deployApiKey, no RUNPOD_API_KEY
    process.env.VAST_API_KEY = 'vast-key';
    listInstancesMock.mockResolvedValue([]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    await auditGpuCosts();
    expect(listNetworkVolumesMock).not.toHaveBeenCalled();
  });

  it('skips Vast.ai check entirely when no VAST_API_KEY is available', async () => {
    mockDeployApiKey = 'rp-key';
    listNetworkVolumesMock.mockResolvedValue([]);

    const { auditGpuCosts } = await import('../server/gpu-cost-audit');
    await auditGpuCosts();
    expect(listInstancesMock).not.toHaveBeenCalled();
  });
});
