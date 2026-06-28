// ── Pull Time Estimator — unit suite ─────────────────────────────────────────
// Validates: toJSON/fromJSON, deriveHostKey, recordPullTime, getObservationCount,
// estimatePullTimeout (in-memory history paths), estimateRemainingMs,
// recordDownloadSpeed/getHostDownloadSpeed, and the persist hook wiring.
// Fetch is stubbed for the Docker Hub API paths; no real network calls.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/logger', () => ({
  defaultLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// pull-time-estimator uses module-level state (pullHistory, downloadSpeedHistory).
// We reset via fromJSON([]) before each test to get a clean slate.

import {
  toJSON,
  fromJSON,
  getHistorySize,
  deriveHostKey,
  recordPullTime,
  getObservationCount,
  estimatePullTimeout,
  estimateRemainingMs,
  recordDownloadSpeed,
  getHostDownloadSpeed,
  setPullHistoryPersistHook,
} from '../../../src/gateway/providers/gpu/pull-time-estimator';

// ── reset in-memory state before each test ────────────────────────────────────
beforeEach(() => {
  fromJSON([]); // wipe pull history
  setPullHistoryPersistHook(null);
});

// ── deriveHostKey ─────────────────────────────────────────────────────────────

describe('deriveHostKey', () => {
  it('uses machineId when present', () => {
    expect(deriveHostKey('runpod', { machineId: 'abc123' })).toBe('runpod:abc123');
  });

  it('uses machine_id (snake_case alias)', () => {
    expect(deriveHostKey('vastai', { machine_id: 'vm-99' })).toBe('vastai:vm-99');
  });

  it('uses hostId as fallback', () => {
    expect(deriveHostKey('tensordock', { hostId: 'h-1' })).toBe('tensordock:h-1');
  });

  it('uses publicIp when no machine id', () => {
    expect(deriveHostKey('vastai', { publicIp: '1.2.3.4' })).toBe('vastai:1.2.3.4');
  });

  it('uses public_ipaddr alias', () => {
    expect(deriveHostKey('runpod', { public_ipaddr: '5.6.7.8' })).toBe('runpod:5.6.7.8');
  });

  it('uses ip as final fallback', () => {
    expect(deriveHostKey('modal', { ip: '9.9.9.9' })).toBe('modal:9.9.9.9');
  });

  it('returns unknown when meta has no useful fields', () => {
    expect(deriveHostKey('runpod', {})).toBe('runpod:unknown');
  });

  it('returns unknown when meta is undefined', () => {
    expect(deriveHostKey('runpod')).toBe('runpod:unknown');
  });

  it('machineId takes priority over ip', () => {
    expect(deriveHostKey('vastai', { machineId: 'm1', publicIp: '1.2.3.4' })).toBe('vastai:m1');
  });
});

// ── recordPullTime / getHistorySize / getObservationCount ─────────────────────

describe('recordPullTime', () => {
  it('increments history size', () => {
    expect(getHistorySize()).toBe(0);
    recordPullTime('img:latest', 120, 500, 'runpod:m1');
    expect(getHistorySize()).toBe(1);
  });

  it('records multiple observations', () => {
    recordPullTime('img:latest', 100, 500, 'runpod:m1');
    recordPullTime('img:latest', 110, 500, 'runpod:m2');
    expect(getHistorySize()).toBe(2);
  });

  it('getObservationCount counts by image', () => {
    recordPullTime('img-a:latest', 90, 500);
    recordPullTime('img-a:latest', 95, 500);
    recordPullTime('img-b:latest', 80, 500);
    expect(getObservationCount('img-a:latest')).toBe(2);
    expect(getObservationCount('img-b:latest')).toBe(1);
  });

  it('getObservationCount counts by image+host', () => {
    recordPullTime('img:latest', 90, 500, 'runpod:h1');
    recordPullTime('img:latest', 95, 500, 'runpod:h2');
    recordPullTime('img:latest', 88, 500, 'runpod:h1');
    expect(getObservationCount('img:latest', 'runpod:h1')).toBe(2);
    expect(getObservationCount('img:latest', 'runpod:h2')).toBe(1);
  });

  it('fires persist hook when set', () => {
    const hook = vi.fn();
    setPullHistoryPersistHook(hook);
    recordPullTime('img:latest', 100, 500);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not throw when persist hook throws', () => {
    setPullHistoryPersistHook(() => { throw new Error('disk full'); });
    expect(() => recordPullTime('img:latest', 100, 500)).not.toThrow();
  });

  it('does not fire hook when hook is null', () => {
    // no hook registered — should not throw
    expect(() => recordPullTime('img:latest', 100, 500)).not.toThrow();
  });

  it('uses 500 Mbps default when inetDownMbps omitted', () => {
    recordPullTime('img:latest', 120);
    const records = toJSON();
    expect(records[0].inetDownMbps).toBe(500);
  });

  it('uses pullTimeS as bootTimeS when bootTimeS omitted', () => {
    recordPullTime('img:latest', 120, 500, 'h1');
    const records = toJSON();
    expect(records[0].bootTimeS).toBe(120);
  });

  it('stores explicit bootTimeS separately from pullTimeS', () => {
    recordPullTime('img:latest', 120, 500, 'h1', 200);
    const records = toJSON();
    expect(records[0].pullTimeS).toBe(120);
    expect(records[0].bootTimeS).toBe(200);
  });
});

// ── toJSON / fromJSON ─────────────────────────────────────────────────────────

describe('toJSON / fromJSON', () => {
  it('toJSON returns empty array on fresh state', () => {
    expect(toJSON()).toEqual([]);
  });

  it('round-trips records accurately', () => {
    recordPullTime('img:v1', 90, 600, 'runpod:m1', 150);
    const json = toJSON();
    fromJSON(json);
    const again = toJSON();
    expect(again).toHaveLength(1);
    expect(again[0].dockerImage).toBe('img:v1');
    expect(again[0].pullTimeS).toBe(90);
    expect(again[0].inetDownMbps).toBe(600);
    expect(again[0].hostKey).toBe('runpod:m1');
    expect(again[0].bootTimeS).toBe(150);
  });

  it('fromJSON replaces existing history', () => {
    recordPullTime('old-img:latest', 100, 500);
    const saved = toJSON();
    recordPullTime('other-img:latest', 200, 500); // would be 2 entries
    fromJSON(saved);
    expect(getHistorySize()).toBe(1);
    expect(toJSON()[0].dockerImage).toBe('old-img:latest');
  });

  it('fromJSON returns count of loaded records', () => {
    recordPullTime('img:v1', 90, 500);
    recordPullTime('img:v2', 95, 500);
    const json = toJSON();
    fromJSON([]);
    const count = fromJSON(json);
    expect(count).toBe(2);
  });

  it('fromJSON silently drops invalid entries', () => {
    const invalid = [
      { dockerImage: 42, hostKey: 'h1', pullTimeS: 90, recordedAt: Date.now() }, // bad type
      null,
      { dockerImage: 'img:v1', pullTimeS: 90, recordedAt: Date.now() }, // missing hostKey
    ];
    const count = fromJSON(invalid);
    expect(count).toBe(0);
    expect(getHistorySize()).toBe(0);
  });

  it('fromJSON accepts records without inetDownMbps and defaults to 500', () => {
    const records = [
      { dockerImage: 'img:v1', hostKey: 'h1', pullTimeS: 100, recordedAt: Date.now() },
    ];
    fromJSON(records);
    expect(toJSON()[0].inetDownMbps).toBe(500);
  });

  it('fromJSON handles non-array gracefully', () => {
    const count = fromJSON('not an array');
    expect(count).toBe(0);
    expect(getHistorySize()).toBe(0);
  });

  it('fromJSON handles null gracefully', () => {
    expect(fromJSON(null)).toBe(0);
  });
});

// ── estimatePullTimeout — in-memory history paths ─────────────────────────────

describe('estimatePullTimeout', () => {
  it('returns default 30min timeout when no history', async () => {
    const result = await estimatePullTimeout({ dockerImage: 'new-image:latest', inetDownMbps: 500 });
    expect(result.confidence).toBe('default');
    expect(result.timeoutMs).toBe(1_800_000);
  });

  it('returns calculated/generous timeout with <10 image observations', async () => {
    for (let i = 0; i < 5; i++) {
      recordPullTime('img:latest', 120 + i * 10, 500, `runpod:host${i}`);
    }
    const result = await estimatePullTimeout({ dockerImage: 'img:latest', inetDownMbps: 500 });
    expect(result.confidence).toBe('calculated');
    // timeoutMs should be clamped between MIN (120s) and MAX (1800s)
    expect(result.timeoutMs).toBeGreaterThanOrEqual(120_000);
    expect(result.timeoutMs).toBeLessThanOrEqual(1_800_000);
  });

  it('returns historical confidence with ≥10 image observations', async () => {
    for (let i = 0; i < 12; i++) {
      recordPullTime('img:latest', 150, 500, `runpod:host${i}`);
    }
    const result = await estimatePullTimeout({ dockerImage: 'img:latest', inetDownMbps: 500 });
    expect(result.confidence).toBe('historical');
    // avg pull = 150s, timeout = 150 * 1.3 * 1000 = 195_000
    expect(result.timeoutMs).toBeCloseTo(195_000, -3);
  });

  it('adjusts timeout by host speed ratio with image-level history', async () => {
    // 10 observations at 500 Mbps, avg 150s
    for (let i = 0; i < 10; i++) {
      recordPullTime('img:latest', 150, 500, `host${i}`);
    }
    // Query at 1000 Mbps — should be ~half as long
    const result = await estimatePullTimeout({ dockerImage: 'img:latest', inetDownMbps: 1000 });
    expect(result.confidence).toBe('historical');
    // adjusted = 150 * (500/1000) = 75s, timeout = 75 * 1.3 * 1000 = 97_500 → but clamped to MIN 120_000
    expect(result.timeoutMs).toBeGreaterThanOrEqual(120_000);
    expect(result.timeoutMs).toBeLessThan(150_000);
  });

  it('uses host-specific history over image-level when ≥3 host observations', async () => {
    // Slow image-level average
    for (let i = 0; i < 10; i++) {
      recordPullTime('img:latest', 600, 500, `host-slow${i}`);
    }
    // Fast host-specific average (3 runs)
    recordPullTime('img:latest', 100, 500, 'fast-host');
    recordPullTime('img:latest', 110, 500, 'fast-host');
    recordPullTime('img:latest', 90, 500, 'fast-host');

    const result = await estimatePullTimeout({ dockerImage: 'img:latest', inetDownMbps: 500, hostKey: 'fast-host' });
    expect(result.confidence).toBe('historical');
    // avg of fast-host = 100s, timeout = 100 * 1.3 * 1000 = 130_000
    expect(result.timeoutMs).toBeCloseTo(130_000, -3);
  });

  it('falls through to image-level when host has <3 observations', async () => {
    for (let i = 0; i < 10; i++) {
      recordPullTime('img:latest', 200, 500, `host${i}`);
    }
    // Only 2 host-specific records — not enough for priority 1
    recordPullTime('img:latest', 100, 500, 'sparse-host');
    recordPullTime('img:latest', 110, 500, 'sparse-host');

    const result = await estimatePullTimeout({ dockerImage: 'img:latest', inetDownMbps: 500, hostKey: 'sparse-host' });
    expect(result.confidence).toBe('historical');
    // Should use image-level avg (≈190s across 12 records including sparse-host's)
    expect(result.timeoutMs).toBeGreaterThan(120_000);
  });

  it('clamps timeout to MIN 2 minutes', async () => {
    // Very fast pull times
    for (let i = 0; i < 3; i++) {
      recordPullTime('tiny-img:latest', 5, 5000, `fast-host`);
    }
    const result = await estimatePullTimeout({ dockerImage: 'tiny-img:latest', inetDownMbps: 5000, hostKey: 'fast-host' });
    expect(result.timeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it('clamps timeout to MAX 30 minutes', async () => {
    // Absurdly slow pull times
    for (let i = 0; i < 3; i++) {
      recordPullTime('huge-img:latest', 10000, 10, `slow-host`);
    }
    const result = await estimatePullTimeout({ dockerImage: 'huge-img:latest', inetDownMbps: 10, hostKey: 'slow-host' });
    expect(result.timeoutMs).toBeLessThanOrEqual(1_800_000);
  });
});

// ── estimateRemainingMs ───────────────────────────────────────────────────────

describe('estimateRemainingMs', () => {
  it('pulling phase returns low confidence', () => {
    const result = estimateRemainingMs('pulling', 0, 500);
    expect(result.confidence).toBe('low');
    expect(result.etaMs).toBeGreaterThan(0);
  });

  it('pulling phase decreases ETA as elapsed increases', () => {
    const r1 = estimateRemainingMs('pulling', 0, 500);
    const r2 = estimateRemainingMs('pulling', 30_000, 500);
    expect(r1.etaMs).toBeGreaterThan(r2.etaMs);
  });

  it('pulling phase returns 0 when download already elapsed', () => {
    // 15 GB at 500 Mbps = 15*8*1024/500 ≈ 245s = 245_000ms
    const r = estimateRemainingMs('pulling', 300_000, 500);
    expect(r.etaMs).toBe(0);
  });

  it('pulling phase is faster at higher bandwidth', () => {
    const rSlow = estimateRemainingMs('pulling', 0, 100);
    const rFast = estimateRemainingMs('pulling', 0, 1000);
    expect(rSlow.etaMs).toBeGreaterThan(rFast.etaMs);
  });

  it('booting phase returns medium confidence', () => {
    const result = estimateRemainingMs('booting', 0, 500);
    expect(result.confidence).toBe('medium');
    expect(result.etaMs).toBeLessThanOrEqual(30_000);
  });

  it('booting phase returns 0 when >30s elapsed', () => {
    const result = estimateRemainingMs('booting', 60_000, 500);
    expect(result.etaMs).toBe(0);
  });

  it('loading_models phase returns low confidence', () => {
    const result = estimateRemainingMs('loading_models', 0, 500, 10);
    expect(result.confidence).toBe('low');
    expect(result.etaMs).toBeGreaterThan(0);
  });

  it('loading_models phase uses modelSizeGb when provided', () => {
    const rSmall = estimateRemainingMs('loading_models', 0, 500, 1);
    const rLarge = estimateRemainingMs('loading_models', 0, 500, 100);
    expect(rLarge.etaMs).toBeGreaterThan(rSmall.etaMs);
  });

  it('loading_models phase defaults to 10GB model size when omitted', () => {
    const rDefault = estimateRemainingMs('loading_models', 0, 500);
    const rExplicit = estimateRemainingMs('loading_models', 0, 500, 10);
    expect(rDefault.etaMs).toBe(rExplicit.etaMs);
  });

  it('loading_models ETA decreases as elapsed increases', () => {
    const r1 = estimateRemainingMs('loading_models', 0, 500, 10);
    const r2 = estimateRemainingMs('loading_models', 30_000, 500, 10);
    expect(r1.etaMs).toBeGreaterThan(r2.etaMs);
  });

  it('loading_models returns 0 when fully elapsed', () => {
    const result = estimateRemainingMs('loading_models', 10_000_000, 500, 10);
    expect(result.etaMs).toBe(0);
  });
});

// ── recordDownloadSpeed / getHostDownloadSpeed ────────────────────────────────

describe('recordDownloadSpeed / getHostDownloadSpeed', () => {
  it('returns null when no observations exist', () => {
    expect(getHostDownloadSpeed('runpod:unknown-host')).toBeNull();
  });

  it('records speed and can retrieve it', () => {
    // speedMbps = (10 * 8 * 1024) / 100 = 819.2 Mbps
    recordDownloadSpeed('runpod:single-host', 10, 100);
    const speed = getHostDownloadSpeed('runpod:single-host');
    expect(speed).not.toBeNull();
    expect(speed!).toBeCloseTo(819.2, 0);
  });

  it('averages multiple observations', () => {
    const host = 'runpod:avg-test-host';
    // 10 GB at 100s = (10 * 8 * 1024) / 100 = 819.2 Mbps
    recordDownloadSpeed(host, 10, 100);
    // 10 GB at 200s = (10 * 8 * 1024) / 200 = 409.6 Mbps
    recordDownloadSpeed(host, 10, 200);
    const speed = getHostDownloadSpeed(host);
    expect(speed).not.toBeNull();
    // average of 819.2 and 409.6 = 614.4
    expect(speed!).toBeCloseTo(614.4, 0);
  });

  it('does not mix records from different hosts', () => {
    recordDownloadSpeed('runpod:mix-h1', 10, 100);
    recordDownloadSpeed('runpod:mix-h2', 10, 200);
    const h1Speed = getHostDownloadSpeed('runpod:mix-h1');
    const h2Speed = getHostDownloadSpeed('runpod:mix-h2');
    expect(h1Speed).not.toBeCloseTo(h2Speed!, 0);
  });

  it('ignores records with pullTimeS <= 0', () => {
    recordDownloadSpeed('runpod:zero-time', 10, 0);
    expect(getHostDownloadSpeed('runpod:zero-time')).toBeNull();
  });

  it('ignores records with imageSizeGb <= 0', () => {
    recordDownloadSpeed('runpod:zero-size', 0, 100);
    expect(getHostDownloadSpeed('runpod:zero-size')).toBeNull();
  });
});

// ── setPullHistoryPersistHook ─────────────────────────────────────────────────

describe('setPullHistoryPersistHook', () => {
  it('fires hook on every recordPullTime call', () => {
    const hook = vi.fn();
    setPullHistoryPersistHook(hook);
    recordPullTime('img:v1', 100, 500);
    recordPullTime('img:v1', 110, 500);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('clears hook when set to null', () => {
    const hook = vi.fn();
    setPullHistoryPersistHook(hook);
    setPullHistoryPersistHook(null);
    recordPullTime('img:v1', 100, 500);
    expect(hook).not.toHaveBeenCalled();
  });

  it('replaces previous hook when set again', () => {
    const hook1 = vi.fn();
    const hook2 = vi.fn();
    setPullHistoryPersistHook(hook1);
    setPullHistoryPersistHook(hook2);
    recordPullTime('img:v1', 100, 500);
    expect(hook1).not.toHaveBeenCalled();
    expect(hook2).toHaveBeenCalledTimes(1);
  });
});
