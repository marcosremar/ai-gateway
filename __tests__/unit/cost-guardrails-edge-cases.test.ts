/**
 * Cost guardrails — edge cases.
 *
 * These exist to prevent the three classes of regression that would silently
 * re-introduce the money leaks the main suite fixed:
 *   1. destroyTimer: restart races, corrupted persist file, double-schedule
 *   2. orphan sweep: concurrent sweeps, provider errors, tracked-pod safety
 *   3. cost audit: destroy-gate belt-and-braces, volume-delete-failure paths
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DESTROY_TIMER_FILE = join(homedir(), '.babelcast', 'destroy_timer.json');

// ─────────────────────────────────────────────────────────────────────────────
// destroyTimer edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('destroyTimer — edge cases', () => {
  beforeEach(() => {
    try { mkdirSync(join(homedir(), '.babelcast'), { recursive: true }); } catch { /* exists */ }
    if (existsSync(DESTROY_TIMER_FILE)) unlinkSync(DESTROY_TIMER_FILE);
    vi.resetModules();
  });

  afterEach(() => {
    if (existsSync(DESTROY_TIMER_FILE)) unlinkSync(DESTROY_TIMER_FILE);
  });

  const mockDeps = (podId: string) => {
    vi.doMock('../../server/state', () => ({
      activeProvider: 'vast',
      deployState: { podId, deployId: 'd1', provider: 'vast' },
      standbyDeployState: { podId: '' },
    }));
    vi.doMock('../../server/ws-state', () => ({ broadcastWs: () => {} }));
  };

  it('recoverPersistedDestroyTimer handles corrupted JSON without crashing', async () => {
    writeFileSync(DESTROY_TIMER_FILE, '{this is not valid json');
    mockDeps('any-pod');
    vi.doMock('../../server/gpu-terminate', () => ({ autoTerminateGpu: async () => {} }));

    const { recoverPersistedDestroyTimer } = await import('../../server/gpu-destroy-timer');
    await expect(recoverPersistedDestroyTimer()).resolves.toBeUndefined();
    // Corrupt file must be removed so it doesn't poison the next boot
    expect(existsSync(DESTROY_TIMER_FILE)).toBe(false);
  });

  it('recoverPersistedDestroyTimer is a no-op when no persisted file exists', async () => {
    const terminated: string[] = [];
    mockDeps('any-pod');
    vi.doMock('../../server/gpu-terminate', () => ({
      autoTerminateGpu: async (r: string) => { terminated.push(r); },
    }));

    const { recoverPersistedDestroyTimer } = await import('../../server/gpu-destroy-timer');
    await recoverPersistedDestroyTimer();
    expect(terminated).toEqual([]);
  });

  it('scheduleAutoDestroy twice — second call overwrites, no leak', async () => {
    mockDeps('pod-abc');
    vi.doMock('../../server/gpu-terminate', () => ({ autoTerminateGpu: async () => {} }));

    const { scheduleAutoDestroy, clearAutoDestroyTimer } = await import('../../server/gpu-destroy-timer');
    scheduleAutoDestroy(60_000);
    const first = JSON.parse(readFileSync(DESTROY_TIMER_FILE, 'utf-8'));

    scheduleAutoDestroy(300_000);  // much later deadline
    const second = JSON.parse(readFileSync(DESTROY_TIMER_FILE, 'utf-8'));

    expect(second.deadlineMs).toBeGreaterThan(first.deadlineMs);
    expect(second.podId).toBe('pod-abc');
    clearAutoDestroyTimer();
  });

  it('clearAutoDestroyTimer is safe when nothing was scheduled', async () => {
    mockDeps('pod-abc');
    vi.doMock('../../server/gpu-terminate', () => ({ autoTerminateGpu: async () => {} }));

    const { clearAutoDestroyTimer } = await import('../../server/gpu-destroy-timer');
    expect(() => clearAutoDestroyTimer()).not.toThrow();
    expect(existsSync(DESTROY_TIMER_FILE)).toBe(false);
  });

  it('recoverPersistedDestroyTimer handles empty-object JSON (missing fields)', async () => {
    writeFileSync(DESTROY_TIMER_FILE, '{}');
    mockDeps('pod-abc');
    const terminated: string[] = [];
    vi.doMock('../../server/gpu-terminate', () => ({
      autoTerminateGpu: async (r: string) => { terminated.push(r); },
    }));

    const { recoverPersistedDestroyTimer } = await import('../../server/gpu-destroy-timer');
    await expect(recoverPersistedDestroyTimer()).resolves.toBeUndefined();
    // No podId in persisted → mismatch → dropped, no terminate
    expect(terminated).toEqual([]);
    expect(existsSync(DESTROY_TIMER_FILE)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isAccountOwned / prefix selection edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('isAccountOwned — env parsing edge cases', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore to clean slate
    for (const k of ['VAST_ACCOUNT_OWNED', 'RUNPOD_ACCOUNT_OWNED', 'TENSORDOCK_ACCOUNT_OWNED', 'MODAL_ACCOUNT_OWNED', 'HYPERSTACK_ACCOUNT_OWNED']) {
      if (originalEnv[k] !== undefined) process.env[k] = originalEnv[k];
      else delete process.env[k];
    }
  });

  it('empty string VAST_ACCOUNT_OWNED="" uses default (=true)', async () => {
    process.env.VAST_ACCOUNT_OWNED = '';
    const { isAccountOwned } = await import('../../server/gpu-orphan-cleanup');
    // Using ?? '1' default: empty string is falsy for ?? only if null/undefined,
    // but '' is kept. Then '' !== '0' → true. Good — stays account-owned.
    expect(isAccountOwned('vast')).toBe(true);
  });

  it('literal string "true" for RUNPOD_ACCOUNT_OWNED is NOT accepted (only "1")', async () => {
    // Prevent accidental opt-in via truthy-looking strings.
    process.env.RUNPOD_ACCOUNT_OWNED = 'true';
    const { isAccountOwned } = await import('../../server/gpu-orphan-cleanup');
    expect(isAccountOwned('runpod')).toBe(false);
  });

  it('any value other than "1" means NOT owned for non-Vast providers', async () => {
    const { isAccountOwned } = await import('../../server/gpu-orphan-cleanup');
    for (const bad of ['0', 'no', 'false', 'yes', '2', ' 1 ', 'on']) {
      process.env.TENSORDOCK_ACCOUNT_OWNED = bad;
      expect(isAccountOwned('tensordock')).toBe(false);
    }
  });

  it('prefixesForProvider returns [] iff isAccountOwned returns true', async () => {
    const { prefixesForProvider, isAccountOwned, GATEWAY_NAME_PREFIXES } = await import('../../server/gpu-orphan-cleanup');
    for (const p of ['vast', 'runpod', 'tensordock', 'modal', 'hyperstack'] as const) {
      if (isAccountOwned(p)) expect(prefixesForProvider(p)).toEqual([]);
      else expect(prefixesForProvider(p)).toEqual(GATEWAY_NAME_PREFIXES);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cost audit edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('auditGpuCosts — destroy-gate belt-and-braces', () => {
  beforeEach(() => { vi.resetModules(); });

  const mockEverything = (opts: {
    volumes?: Array<{ id: string; name: string; size: number; dataCenterId: string }>;
    deleteThrows?: boolean;
  } = {}) => {
    const deletedVolumes: string[] = [];
    vi.doMock('../../server/state', () => ({
      deployApiKey: 'fake-rp-key',
      deployState: { podId: 'tracked-pod' },
      standbyDeployState: { podId: '' },
    }));
    vi.doMock('../../server/providers', () => ({
      runpod: {
        listNetworkVolumes: async () => opts.volumes ?? [],
        deleteNetworkVolume: async (id: string) => {
          if (opts.deleteThrows) throw new Error('simulated 500');
          deletedVolumes.push(id);
        },
      },
      vast: {
        listInstances: async () => [],
      },
    }));
    return { deletedVolumes };
  };

  it('destroyOrphans=true WITHOUT RUNPOD_VOLUME_SWEEP_DESTROY=1 deletes nothing', async () => {
    delete process.env.RUNPOD_VOLUME_SWEEP_DESTROY;
    const { deletedVolumes } = mockEverything({
      volumes: [{ id: 'vol-x', name: 'random', size: 50, dataCenterId: 'US-OR-1' }],
    });
    const { auditGpuCosts } = await import('../../server/gpu-cost-audit');
    const report = await auditGpuCosts({ destroyOrphans: true });
    expect(report.volumes.orphanCount).toBe(1);
    expect(deletedVolumes).toEqual([]);  // gate held
  });

  it('destroyOrphans=false WITH RUNPOD_VOLUME_SWEEP_DESTROY=1 still deletes nothing', async () => {
    process.env.RUNPOD_VOLUME_SWEEP_DESTROY = '1';
    const { deletedVolumes } = mockEverything({
      volumes: [{ id: 'vol-y', name: 'random', size: 100, dataCenterId: 'US-OR-1' }],
    });
    try {
      const { auditGpuCosts } = await import('../../server/gpu-cost-audit');
      const report = await auditGpuCosts({ destroyOrphans: false });
      expect(report.volumes.orphanCount).toBe(1);
      expect(deletedVolumes).toEqual([]);  // gate held
    } finally {
      delete process.env.RUNPOD_VOLUME_SWEEP_DESTROY;
    }
  });

  it('BOTH gates set: deletes orphan volumes', async () => {
    process.env.RUNPOD_VOLUME_SWEEP_DESTROY = '1';
    const { deletedVolumes } = mockEverything({
      volumes: [
        { id: 'vol-1', name: 'random-a', size: 10, dataCenterId: 'US-OR-1' },
        { id: 'vol-2', name: 'random-b', size: 20, dataCenterId: 'EU-RO-1' },
      ],
    });
    try {
      const { auditGpuCosts } = await import('../../server/gpu-cost-audit');
      await auditGpuCosts({ destroyOrphans: true });
      expect(deletedVolumes.sort()).toEqual(['vol-1', 'vol-2']);
    } finally {
      delete process.env.RUNPOD_VOLUME_SWEEP_DESTROY;
    }
  });

  it('deleteNetworkVolume failure is captured in warnings, not thrown', async () => {
    process.env.RUNPOD_VOLUME_SWEEP_DESTROY = '1';
    mockEverything({
      volumes: [{ id: 'vol-broken', name: 'x', size: 10, dataCenterId: 'US' }],
      deleteThrows: true,
    });
    try {
      const { auditGpuCosts } = await import('../../server/gpu-cost-audit');
      const report = await auditGpuCosts({ destroyOrphans: true });
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.warnings.some(w => w.includes('vol-broken'))).toBe(true);
      // Report still produced — one bad volume doesn't tank the whole audit
      expect(report.volumes.runpod.length).toBe(1);
    } finally {
      delete process.env.RUNPOD_VOLUME_SWEEP_DESTROY;
    }
  });

  it('listNetworkVolumes failure captured in warnings, audit continues', async () => {
    vi.doMock('../../server/state', () => ({
      deployApiKey: 'fake-key',
      deployState: { podId: '' },
      standbyDeployState: { podId: '' },
    }));
    vi.doMock('../../server/providers', () => ({
      runpod: {
        listNetworkVolumes: async () => { throw new Error('network timeout'); },
        deleteNetworkVolume: async () => {},
      },
      vast: { listInstances: async () => [] },
    }));

    const { auditGpuCosts } = await import('../../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.warnings.some(w => w.includes('runpod volume list'))).toBe(true);
    expect(report.volumes.runpod).toEqual([]);
    // Vast branch still ran
    expect(Array.isArray(report.stoppedPods)).toBe(true);
  });

  it('zero-size volume: estMonthlyUsd is 0 and no divide-by-zero', async () => {
    mockEverything({
      volumes: [{ id: 'vol-0', name: 'empty', size: 0, dataCenterId: 'US' }],
    });
    const { auditGpuCosts } = await import('../../server/gpu-cost-audit');
    const report = await auditGpuCosts();
    expect(report.volumes.runpod[0].estMonthlyUsd).toBe(0);
    expect(report.volumes.totalMonthlyUsd).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sweepOrphanInstances edge cases — provider failure isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('sweepOrphanInstances — provider failure isolation', () => {
  beforeEach(() => { vi.resetModules(); });

  it('one provider throwing does not stop the others from being swept', async () => {
    const terminated: Array<{ provider: string; id: string }> = [];
    vi.doMock('../../server/state', () => ({
      deployApiKey: 'rp-key',
      deployVastApiKey: 'vast-key',
      deployTensordockApiKey: '',
      deployModalApiKey: '',
      deployHyperstackApiKey: '',
      deployTensordockAuthId: '',
      deployState: { podId: '' },
      standbyDeployState: { podId: '' },
    }));
    vi.doMock('../../server/providers', () => ({
      runpod: {
        listInstances: async () => { throw new Error('runpod down'); },
        deleteInstance: async () => {},
      },
      vast: {
        listInstances: async () => [
          { instanceId: 'vast-1', instanceName: 'stray', status: 'running' },
        ],
        deleteInstance: async (id: string) => { terminated.push({ provider: 'vast', id }); },
      },
      tensordock: { listInstances: async () => [], deleteInstance: async () => {} },
      modal: { listInstances: async () => [], deleteInstance: async () => {} },
      hyperstack: { listInstances: async () => [], deleteInstance: async () => {} },
    }));

    const { sweepOrphanInstances } = await import('../../server/gpu-orphan-cleanup');
    const result = await sweepOrphanInstances();
    // RunPod error → skipped, Vast still swept
    expect(terminated).toEqual([{ provider: 'vast', id: 'vast-1' }]);
    expect(result.terminated).toBe(1);
  });

  it('deleteInstance throwing for one VM still attempts the rest', async () => {
    const attempted: string[] = [];
    vi.doMock('../../server/state', () => ({
      deployApiKey: '',
      deployVastApiKey: 'vast-key',
      deployTensordockApiKey: '',
      deployModalApiKey: '',
      deployHyperstackApiKey: '',
      deployTensordockAuthId: '',
      deployState: { podId: '' },
      standbyDeployState: { podId: '' },
    }));
    vi.doMock('../../server/providers', () => ({
      runpod: { listInstances: async () => [], deleteInstance: async () => {} },
      vast: {
        listInstances: async () => [
          { instanceId: 'good-1', status: 'running' },
          { instanceId: 'bad-api', status: 'running' },
          { instanceId: 'good-2', status: 'running' },
        ],
        deleteInstance: async (id: string) => {
          attempted.push(id);
          if (id === 'bad-api') throw new Error('429 rate limit');
        },
      },
      tensordock: { listInstances: async () => [], deleteInstance: async () => {} },
      modal: { listInstances: async () => [], deleteInstance: async () => {} },
      hyperstack: { listInstances: async () => [], deleteInstance: async () => {} },
    }));

    const { sweepOrphanInstances } = await import('../../server/gpu-orphan-cleanup');
    const result = await sweepOrphanInstances();
    expect(attempted.sort()).toEqual(['bad-api', 'good-1', 'good-2']);
    // Found 3, terminated 2 (one threw)
    expect(result.found).toBe(3);
    expect(result.terminated).toBe(2);
  });
});
