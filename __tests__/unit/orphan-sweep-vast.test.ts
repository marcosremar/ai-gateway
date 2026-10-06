/**
 * Tests for server/orphan-sweep-vast.ts — port of the bun:test suite to vitest
 * so this cost-safety module is exercised in the standard CI run.
 *
 * Background: In May 2026, pods started outside the gateway's tracked state
 * burned ~$1/h unnoticed. The orphan-sweep module was introduced to detect and
 * optionally terminate those. These tests pin the core detection + sweep logic.
 */

import { describe, it, expect } from 'vitest';
import {
  detectOrphanInstances,
  listVastInstancesDirect,
  runOrphanSweep,
  type VastInstanceLite,
} from '../../server/orphan-sweep-vast';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const owned: VastInstanceLite = {
  id: 1,
  imageUuid: 'marcosremar/trellis2:latest',
  dphTotal: 1.13,
  startDate: 1_778_286_504,
};
const orphanA: VastInstanceLite = {
  id: 2,
  imageUuid: 'ghcr.io/marcosremar/qwen3-tts:latest',
  dphTotal: 0.525,
  startDate: 1_778_286_504,
};
const orphanB: VastInstanceLite = {
  id: 3,
  imageUuid: 'ghcr.io/marcosremar/qwen3-tts:latest',
  dphTotal: 0.469,
  startDate: 1_778_286_504,
};

const allowlist = ['marcosremar/trellis2', 'marcosremar/hunyuan3d'];

// ── detectOrphanInstances ─────────────────────────────────────────────────────

describe('detectOrphanInstances', () => {
  it('flags instances whose image is not in the allowlist', () => {
    const r = detectOrphanInstances([owned, orphanA, orphanB], allowlist);
    expect(r.orphans).toHaveLength(2);
    expect(r.orphans.map((o) => o.id).sort()).toEqual([2, 3]);
  });

  it('sums billed dollars/hour across orphans', () => {
    const r = detectOrphanInstances([orphanA, orphanB], allowlist);
    // 0.525 + 0.469 = 0.994 — mirrors the May 2026 incident burn rate
    expect(r.burnPerHourUsd).toBeCloseTo(0.994, 3);
  });

  it('treats an empty allowlist as everything-is-orphan', () => {
    const r = detectOrphanInstances([owned, orphanA], []);
    expect(r.orphans).toHaveLength(2);
    expect(r.burnPerHourUsd).toBeCloseTo(1.13 + 0.525, 3);
  });

  it('returns no orphans when every instance is owned', () => {
    const r = detectOrphanInstances([owned], allowlist);
    expect(r.orphans).toEqual([]);
    expect(r.burnPerHourUsd).toBe(0);
  });

  it('returns no orphans on empty instance list', () => {
    const r = detectOrphanInstances([], allowlist);
    expect(r.orphans).toEqual([]);
    expect(r.burnPerHourUsd).toBe(0);
  });

  it('uses prefix matching — partial prefix match is enough', () => {
    const partial: VastInstanceLite = {
      id: 10,
      imageUuid: 'marcosremar/trellis2:cuda12.4',
      dphTotal: 0.5,
      startDate: 0,
    };
    const r = detectOrphanInstances([partial], allowlist);
    expect(r.orphans).toHaveLength(0);
  });

  it('does not match when prefix is a substring in the middle', () => {
    const sneaky: VastInstanceLite = {
      id: 11,
      imageUuid: 'evil/marcosremar/trellis2:latest',
      dphTotal: 0.1,
      startDate: 0,
    };
    const r = detectOrphanInstances([sneaky], allowlist);
    expect(r.orphans).toHaveLength(1);
  });
});

// ── runOrphanSweep ────────────────────────────────────────────────────────────

describe('runOrphanSweep', () => {
  it('reports orphans without terminating when autoTerminate is off (default)', async () => {
    const lines: string[] = [];
    const r = await runOrphanSweep({
      listInstances: async () => [owned, orphanA, orphanB],
      allowlistImagePrefixes: allowlist,
      log: (line) => lines.push(line),
    });
    expect(r.terminatedIds).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.orphans).toHaveLength(2);
    expect(r.burnPerHourUsd).toBeCloseTo(0.994, 3);
    expect(lines.some((l) => l.includes('orphan'))).toBe(true);
  });

  it('returns empty report when no orphans', async () => {
    const lines: string[] = [];
    const r = await runOrphanSweep({
      listInstances: async () => [owned],
      allowlistImagePrefixes: allowlist,
      log: (line) => lines.push(line),
    });
    expect(r.orphans).toHaveLength(0);
    expect(r.terminatedIds).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it('terminates all orphans when autoTerminate is true', async () => {
    const terminated: number[] = [];
    const r = await runOrphanSweep({
      listInstances: async () => [orphanA, orphanB],
      terminate: async (id) => { terminated.push(id); },
      autoTerminate: true,
      allowlistImagePrefixes: allowlist,
      log: () => {},
    });
    expect(terminated.sort()).toEqual([2, 3]);
    expect(r.terminatedIds.sort()).toEqual([2, 3]);
    expect(r.errors).toEqual([]);
  });

  it('continues terminating remaining orphans after one failure', async () => {
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

  it('does not call terminate when terminate fn is undefined even if autoTerminate=true', async () => {
    // No terminate fn provided — should not throw, just report.
    const r = await runOrphanSweep({
      listInstances: async () => [orphanA],
      autoTerminate: true,
      allowlistImagePrefixes: allowlist,
      log: () => {},
    });
    expect(r.terminatedIds).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('uses console.warn as default log sink when log is not provided', async () => {
    // Should not throw — just smoke-test the default.
    const r = await runOrphanSweep({
      listInstances: async () => [orphanA],
      allowlistImagePrefixes: allowlist,
    });
    expect(r.orphans).toHaveLength(1);
  });
});

// ── listVastInstancesDirect ───────────────────────────────────────────────────

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('listVastInstancesDirect', () => {
  it('normalizes the snake_case response shape from vast.ai', async () => {
    const fakeBody = {
      instances: [
        {
          id: 99,
          image_uuid: 'marcosremar/trellis2:latest',
          dph_total: 1.13,
          start_date: 1_778_286_504,
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
        startDate: 1_778_286_504,
        status: 'running',
      },
    ]);
  });

  it('returns an empty array when instances is empty', async () => {
    const out = await listVastInstancesDirect('k', fakeFetch({ instances: [] }));
    expect(out).toEqual([]);
  });

  it('returns an empty array when instances key is missing', async () => {
    const out = await listVastInstancesDirect('k', fakeFetch({}));
    expect(out).toEqual([]);
  });

  it('throws on 401 so the sweep fails closed instead of silently returning []', async () => {
    await expect(listVastInstancesDirect('bad-key', fakeFetch({}, 401))).rejects.toThrow('HTTP 401');
  });

  it('throws on 500 server error', async () => {
    await expect(listVastInstancesDirect('k', fakeFetch({}, 500))).rejects.toThrow('HTTP 500');
  });

  it('handles instances with missing optional fields gracefully', async () => {
    const fakeBody = {
      instances: [
        { id: 7, image_uuid: 'some/image:tag', dph_total: 0.3, start_date: 0 },
      ],
    };
    const out = await listVastInstancesDirect('k', fakeFetch(fakeBody));
    expect(out[0].status).toBeUndefined();
    expect(out[0].id).toBe(7);
  });

  it('filters out non-object items in instances array', async () => {
    const fakeBody = {
      instances: [
        null,
        'string',
        42,
        { id: 5, image_uuid: 'a/b:c', dph_total: 0.1, start_date: 0 },
      ],
    };
    const out = await listVastInstancesDirect('k', fakeFetch(fakeBody));
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(5);
  });

  it('coerces numeric strings to numbers', async () => {
    const fakeBody = {
      instances: [
        { id: '42', image_uuid: 'x/y:z', dph_total: '0.55', start_date: '12345' },
      ],
    };
    const out = await listVastInstancesDirect('k', fakeFetch(fakeBody));
    expect(out[0].id).toBe(42);
    expect(out[0].dphTotal).toBe(0.55);
    expect(out[0].startDate).toBe(12345);
  });
});
