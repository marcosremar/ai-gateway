import { describe, expect, it } from 'bun:test';
import {
  detectOrphanInstances,
  listVastInstancesDirect,
  runOrphanSweep,
  type VastInstanceLite,
} from './orphan-sweep-vast';

const owned: VastInstanceLite = {
  id: 1,
  imageUuid: 'marcosremar/trellis2:latest',
  dphTotal: 1.13,
  startDate: 1778286504,
};
const orphanA: VastInstanceLite = {
  id: 2,
  imageUuid: 'ghcr.io/marcosremar/qwen3-tts:latest',
  dphTotal: 0.525,
  startDate: 1778286504,
};
const orphanB: VastInstanceLite = {
  id: 3,
  imageUuid: 'ghcr.io/marcosremar/qwen3-tts:latest',
  dphTotal: 0.469,
  startDate: 1778286504,
};
const allowlist = ['marcosremar/trellis2', 'marcosremar/hunyuan3d'];

describe('detectOrphanInstances', () => {
  it('flags instances whose image is not in the allowlist', () => {
    const r = detectOrphanInstances([owned, orphanA, orphanB], allowlist);
    expect(r.orphans).toHaveLength(2);
    expect(r.orphans.map((o) => o.id).sort()).toEqual([2, 3]);
  });

  it('sums billed dollars/hour across orphans (the actual cost leak)', () => {
    const r = detectOrphanInstances([orphanA, orphanB], allowlist);
    // Mirrors the May 2026 incident where two qwen3-tts pods burned ~$1/h.
    expect(r.burnPerHourUsd).toBeCloseTo(0.994, 3);
  });

  it('treats an empty allowlist as everything-is-orphan', () => {
    const r = detectOrphanInstances([owned, orphanA], []);
    expect(r.orphans).toHaveLength(2);
  });

  it('returns no orphans when every instance is owned', () => {
    const r = detectOrphanInstances([owned], allowlist);
    expect(r.orphans).toEqual([]);
    expect(r.burnPerHourUsd).toBe(0);
  });
});

describe('runOrphanSweep', () => {
  it('reports orphans without terminating when autoTerminate is off', async () => {
    const lines: string[] = [];
    const r = await runOrphanSweep({
      listInstances: async () => [owned, orphanA, orphanB],
      allowlistImagePrefixes: allowlist,
      log: (line) => lines.push(line),
    });
    expect(r.terminatedIds).toEqual([]);
    expect(r.orphans).toHaveLength(2);
    expect(lines.some((l) => l.includes('$0.99/h'))).toBe(true);
  });

  it('terminates each orphan when autoTerminate is on', async () => {
    const terminated: number[] = [];
    const r = await runOrphanSweep({
      listInstances: async () => [orphanA, orphanB],
      terminate: async (id) => {
        terminated.push(id);
      },
      autoTerminate: true,
      allowlistImagePrefixes: allowlist,
      log: () => {},
    });
    expect(terminated.sort()).toEqual([2, 3]);
    expect(r.terminatedIds.sort()).toEqual([2, 3]);
  });

  it('keeps going when one terminate fails', async () => {
    const r = await runOrphanSweep({
      listInstances: async () => [orphanA, orphanB],
      terminate: async (id) => {
        if (id === 2) throw new Error('vast unreachable');
      },
      autoTerminate: true,
      allowlistImagePrefixes: allowlist,
      log: () => {},
    });
    expect(r.terminatedIds).toEqual([3]);
    expect(r.errors).toEqual([{ id: 2, message: 'vast unreachable' }]);
  });
});

describe('listVastInstancesDirect', () => {
  function fakeFetch(body: unknown, status = 200): typeof fetch {
    return (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  it('normalizes the snake_case shape returned by vast.ai', async () => {
    const fakeBody = {
      instances: [
        {
          id: 99,
          image_uuid: 'marcosremar/trellis2:latest',
          dph_total: 1.13,
          start_date: 1778286504,
          status: 'running',
        },
      ],
    };
    const out = await listVastInstancesDirect('k', fakeFetch(fakeBody));
    expect(out).toEqual([
      {
        id: 99,
        imageUuid: 'marcosremar/trellis2:latest',
        dphTotal: 1.13,
        startDate: 1778286504,
        status: 'running',
      },
    ]);
  });

  it('throws on non-2xx so the sweep fails closed instead of silently returning []', async () => {
    await expect(listVastInstancesDirect('k', fakeFetch({}, 401))).rejects.toThrow(/HTTP 401/);
  });
});
