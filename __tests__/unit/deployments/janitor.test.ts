import { describe, expect, it, vi } from 'vitest';
import { BUILD_TAG, janitorPlan, runJanitor, type JanitorCloud, type JanitorServer, type JanitorVolume } from '../../../src/deployments/janitor';
import { pinnedIdleMaxMs } from '../../../src/deployments/index';

// Owner's ask (06/10/2026): what is idle or left over stops billing on its own, from inside the gateway.
const H = 3_600_000;
const NOW = 100 * H;
const limits = { buildMaxMs: 3 * H, volumeMaxMs: H };

const server = (id: string, ageH: number, tags = [BUILD_TAG]): JanitorServer => ({ id, zone: 'fr-par-2', name: id, tags, createdAt: NOW - ageH * H });
const volume = (id: string, over: Partial<JanitorVolume> = {}): JanitorVolume => ({
  id, zone: 'fr-par-2', name: 'Ubuntu Noble GPU OS 12 passthrough_sbs_volume_0', status: 'available', attached: false,
  updatedAt: NOW - 2 * H, sizeGb: 120, ...over,
});

describe('janitorPlan', () => {
  it('deletes build machines older than the limit, never a young one or one without the build tag', () => {
    const plan = janitorPlan({ builds: [server('old', 4), server('young', 1), server('replica', 9, ['aigw-deploy'])], volumes: [], now: NOW, limits });
    expect(plan.servers.map(s => s.id)).toEqual(['old']);
  });

  it('deletes only auto-created SBS volumes left detached past the limit', () => {
    const plan = janitorPlan({ builds: [], now: NOW, limits, volumes: [
      volume('leftover'),
      volume('in-use', { attached: true, status: 'in_use' }),
      volume('just-detached', { updatedAt: NOW - 10 * 60_000 }),
      volume('named-on-purpose', { name: 'training-data' }),
    ] });
    expect(plan.volumes.map(v => v.id)).toEqual(['leftover']);
  });
});

describe('runJanitor', () => {
  it('deletes the plan and keeps going when one delete fails', async () => {
    const cloud: JanitorCloud = {
      listServersByTag: async () => [server('b1', 5)],
      listVolumes: async () => [volume('v1'), volume('v2')],
      deleteServer: vi.fn(async () => {}),
      deleteVolume: vi.fn(async (v: JanitorVolume) => { if (v.id === 'v1') throw new Error('HTTP 409'); }),
    };
    const result = await runJanitor({ cloud, limits, now: () => NOW });
    expect(result).toEqual({ deleted: ['b1', 'v2'], failed: ['v1'] });
  });
});

describe('DEPLOYMENTS_PINNED_IDLE_MAX_MINUTES', () => {
  it('defaults to 60 min; 0 turns the guard off', () => {
    expect(pinnedIdleMaxMs({})).toBe(60 * 60_000);
    expect(pinnedIdleMaxMs({ DEPLOYMENTS_PINNED_IDLE_MAX_MINUTES: '15' })).toBe(15 * 60_000);
    expect(pinnedIdleMaxMs({ DEPLOYMENTS_PINNED_IDLE_MAX_MINUTES: '0' })).toBe(0);
  });
});
