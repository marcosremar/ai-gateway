/**
 * Optimization implementation tests — Autoscaling, Reliability & Resilience
 * WAVE 5 (docs/optimizations/03-autoscaling-reliability.md, IDs 201-300).
 *
 * Unit-only: no network, no GPU, no real filesystem writes, no live timers.
 * Pure exported helpers are exercised behaviourally; the wirings are verified
 * either with in-memory doubles or (for stateful flows) a source-text assertion.
 * Waves 1-4 files are untouched — this file covers the NEXT batch of fixes
 * (IDs: 216, 222, 224, 225, 228, 230).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ── #216 / #224 — watchdog stuck-booting routes through handleBootTimeout ─────
// (consistent cooldown semantics + cleanup of the *discovered* instance id).
describe('watchdog boot-timeout cooldown + discovered-instance cleanup (#216/#224)', () => {
  let bt: typeof import('../../src/gateway/autoscaler/boot-timeout');
  beforeEach(async () => { bt = await import('../../src/gateway/autoscaler/boot-timeout'); });

  it('handleBootTimeout sets cooldownUntil (the gap the watchdog had)', () => {
    const now = 1_000_000;
    const res = bt.handleBootTimeout(
      0,
      { state: 'booting', tierIndex: 0, bootTriggeredAt: 0, prevBootFailCount: 0, trigger: 'demand' } as any,
      { provider: 'runpod' } as any,
      240_000,
      now,
      'watchdog',
    );
    expect(res.newState.state).toBe('idle');
    // #216: cooldown must be set (was previously absent on the watchdog path).
    expect(typeof res.newState.cooldownUntil).toBe('number');
    expect(res.newState.cooldownUntil!).toBeGreaterThan(now);
  });

  it('#224 cleanupConfig carries the discovered instance id (not just static config)', () => {
    const res = bt.handleBootTimeout(
      1,
      { state: 'booting', tierIndex: 1, bootTriggeredAt: 0, prevBootFailCount: 0, trigger: 'demand', discoveredInstanceId: 'disc-xyz' } as any,
      { provider: 'vast', instanceId: undefined } as any,
      240_000,
      2_000_000,
      'watchdog',
    );
    expect(res.cleanupConfig?.instanceId).toBe('disc-xyz');
  });

  it('escalates unhealthy once failCount crosses MAX_BOOT_FAILURES', () => {
    const res = bt.handleBootTimeout(
      0,
      { state: 'booting', tierIndex: 0, bootTriggeredAt: 0, prevBootFailCount: 5, trigger: 'demand' } as any,
      { provider: 'runpod' } as any,
      240_000,
      1_000_000,
      'watchdog',
    );
    expect(res.newState.unhealthy).toBe(true);
  });

  it('watchdog source actually routes the stuck-booting block through handleBootTimeout', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/gateway/autoscaler/watchdog.ts'), 'utf-8');
    // Imports the shared handler...
    expect(src).toMatch(/import\s*\{[^}]*handleBootTimeout[^}]*\}\s*from\s*'\.\/boot-timeout'/);
    // ...and uses its result (newState/cleanupConfig) in the stuck-booting cleanup.
    expect(src).toMatch(/handleBootTimeout\(\s*i,\s*booting,/);
    expect(src).toMatch(/const\s*\{\s*newState,\s*logEntry,\s*cleanupConfig\s*\}\s*=\s*handleBootTimeout/);
    // The old manual idle-state build (no cooldown) must be gone.
    expect(src).not.toMatch(/const failCount = booting\.prevBootFailCount \+ 1;[\s\S]*?const newIdle/);
  });
});

// ── #222 — bootPathByTier key includes the boot timestamp ─────────────────────
describe('bootPathKey timestamped attribution (#222)', () => {
  let bo: typeof import('../../src/gateway/autoscaler/boot-orchestrator');
  beforeEach(async () => { bo = await import('../../src/gateway/autoscaler/boot-orchestrator'); });

  it('includes the timestamp when present (unique per boot attempt)', () => {
    expect(bo.bootPathKey('u1', 0, 1234)).toBe('u1:0:1234');
    expect(bo.bootPathKey('u1', 2, 9999)).toBe('u1:2:9999');
  });

  it('two boots on the same tier produce distinct keys', () => {
    const a = bo.bootPathKey('u1', 0, 1000);
    const b = bo.bootPathKey('u1', 0, 2000);
    expect(a).not.toBe(b);
  });

  it('falls back to the legacy 2-part key without a (valid) timestamp', () => {
    expect(bo.bootPathKey('u1', 0)).toBe('u1:0');
    expect(bo.bootPathKey('u1', 0, 0)).toBe('u1:0');
    expect(bo.bootPathKey('u1', 0, -5)).toBe('u1:0');
  });

  it('boot-orchestrator source wires the helper at set + consume sites', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/gateway/autoscaler/boot-orchestrator.ts'), 'utf-8');
    expect(src).toMatch(/this\.bootPathByTier\.set\(\s*bootPathKey\(/);
    expect(src).toMatch(/bootPathKey\(userId, tierIndex, bootTimestamp\)/);
    // The bare 2-part set/get string keys must be gone from the SnapGPU path.
    expect(src).not.toMatch(/this\.bootPathByTier\.set\(`\$\{userId\}:\$\{tierIndex\}`/);
  });
});

// ── #225 — forceTierReady fires a verification probe; demote dead endpoint ─────
describe('force-ready verification (#225)', () => {
  let eng: typeof import('../../src/gateway/autoscaler/engine');
  beforeEach(async () => { eng = await import('../../src/gateway/autoscaler/engine'); });

  it('forceReadyVerificationAction maps probe result → next action', () => {
    expect(eng.forceReadyVerificationAction(true)).toBe('keep-ready');
    expect(eng.forceReadyVerificationAction(false)).toBe('demote-idle');
  });

  function makeEngine(probeOk: boolean) {
    const persistCalls: any[] = [];
    const e = new eng.AutoscalerEngine({
      registry: { get: () => undefined } as any,
      sessionTracker: {} as any,
      latencyTracker: {} as any,
      persistence: {
        persistTierStates: async (u: string, s: any) => { persistCalls.push([u, s]); },
        loadTierStates: async () => undefined,
      } as any,
      probeHealth: async () => probeOk,
      cleanupInstance: async () => {},
      lifecycleLogger: { log: async () => {} } as any,
      logger: { log() {}, warn() {}, error() {}, debug() {} } as any,
    });
    return { e, persistCalls };
  }

  it('keeps a healthy force-ready endpoint ready after verification', async () => {
    const { e } = makeEngine(true);
    e.forceTierReady('user-ok', 0, 'http://gpu-ok:8000');
    // Let the background probe microtask resolve.
    await new Promise((r) => setTimeout(r, 0));
    const status = e.getPoolStatus('user-ok');
    expect(status[0]?.state).toBe('ready');
    expect(e.getReadyEndpoints('user-ok')).toEqual(['http://gpu-ok:8000']);
  });

  it('demotes a dead force-ready endpoint to idle (unhealthy)', async () => {
    const { e } = makeEngine(false);
    e.forceTierReady('user-dead', 0, 'http://gpu-dead:8000');
    await new Promise((r) => setTimeout(r, 0));
    const status = e.getPoolStatus('user-dead');
    expect(status[0]?.state).toBe('idle');
    expect((status[0] as any).unhealthy).toBe(true);
    expect(e.getReadyEndpoints('user-dead')).toEqual([]);
  });

  it('verify=false preserves the legacy synchronous-only behaviour (no probe)', async () => {
    const probe = vi.fn(async () => false);
    const e = new eng.AutoscalerEngine({
      registry: { get: () => undefined } as any,
      sessionTracker: {} as any, latencyTracker: {} as any,
      persistence: { persistTierStates: async () => {}, loadTierStates: async () => undefined } as any,
      probeHealth: probe,
      cleanupInstance: async () => {},
      lifecycleLogger: { log: async () => {} } as any,
      logger: { log() {}, warn() {}, error() {}, debug() {} } as any,
    });
    e.forceTierReady('u', 0, 'http://x:8000', /*verify*/ false);
    await new Promise((r) => setTimeout(r, 0));
    expect(probe).not.toHaveBeenCalled();
    expect(e.getPoolStatus('u')[0]?.state).toBe('ready');
  });
});

// ── #228 — verified (fresh) ready endpoints only ──────────────────────────────
describe('verified ready endpoints (#228)', () => {
  let eng: typeof import('../../src/gateway/autoscaler/engine');
  beforeEach(async () => { eng = await import('../../src/gateway/autoscaler/engine'); });

  it('isReadyEndpointFresh respects window + invalid timestamps', () => {
    const now = 1_000_000;
    expect(eng.isReadyEndpointFresh(now - 1_000, now, 90_000)).toBe(true);
    expect(eng.isReadyEndpointFresh(now - 120_000, now, 90_000)).toBe(false);
    // Never-verified (0/negative/NaN) is always stale.
    expect(eng.isReadyEndpointFresh(0, now, 90_000)).toBe(false);
    expect(eng.isReadyEndpointFresh(-1, now, 90_000)).toBe(false);
    expect(eng.isReadyEndpointFresh(Number.NaN, now, 90_000)).toBe(false);
  });

  it('exactly at the window boundary is treated as stale (strict <)', () => {
    const now = 1_000_000;
    expect(eng.isReadyEndpointFresh(now - 90_000, now, 90_000)).toBe(false);
    expect(eng.isReadyEndpointFresh(now - 89_999, now, 90_000)).toBe(true);
  });

  it('getVerifiedReadyEndpoints excludes a stale (unprobed/restored) ready tier', async () => {
    const e = new eng.AutoscalerEngine({
      registry: { get: () => undefined } as any,
      sessionTracker: {} as any, latencyTracker: {} as any,
      persistence: { persistTierStates: async () => {}, loadTierStates: async () => undefined } as any,
      probeHealth: async () => true,
      cleanupInstance: async () => {},
      lifecycleLogger: { log: async () => {} } as any,
      logger: { log() {}, warn() {}, error() {}, debug() {} } as any,
    });
    // force-ready (fresh lastHealthyAt=now), verify off so it stays ready.
    e.forceTierReady('u', 0, 'http://fresh:8000', false);
    const now = Date.now();
    // Both unfiltered and verified see it while fresh.
    expect(e.getReadyEndpoints('u')).toEqual(['http://fresh:8000']);
    expect(e.getVerifiedReadyEndpoints('u', now)).toEqual(['http://fresh:8000']);
    // Far in the future it is stale → verified set drops it, raw set keeps it.
    const future = now + 10 * 60_000;
    expect(e.getReadyEndpoints('u')).toEqual(['http://fresh:8000']);
    expect(e.getVerifiedReadyEndpoints('u', future)).toEqual([]);
  });
});

// ── #230 — cleanup honours a runtime-discovered instance id ───────────────────
describe('cleanup discovered-instance id (#230)', () => {
  let cl: typeof import('../../src/gateway/autoscaler/cleanup');
  beforeEach(async () => { cl = await import('../../src/gateway/autoscaler/cleanup'); });

  it('resolveCleanupInstanceId prefers the resolved id, falls back to config', () => {
    expect(cl.resolveCleanupInstanceId({ instanceId: 'cfg' }, 'disc')).toBe('disc');
    expect(cl.resolveCleanupInstanceId({ instanceId: 'cfg' })).toBe('cfg');
    expect(cl.resolveCleanupInstanceId({ instanceId: undefined }, 'disc')).toBe('disc');
    expect(cl.resolveCleanupInstanceId({ instanceId: undefined })).toBeUndefined();
    // Blank strings are treated as absent.
    expect(cl.resolveCleanupInstanceId({ instanceId: '  ' }, '  ')).toBeUndefined();
  });

  it('cleanupProviderInstance now cleans a tier with only a discovered id', async () => {
    const stopInstance = vi.fn(async () => {});
    const registry = { get: () => ({ stopInstance }) } as any;
    // No static instanceId on the config — previously this early-returned and leaked.
    await cl.cleanupProviderInstance(
      { provider: 'vast', apiKey: 'k' } as any,
      registry,
      'stuck booting',
      { log() {}, warn() {}, error() {}, debug() {} } as any,
      undefined,
      'disc-123',
    );
    expect(stopInstance).toHaveBeenCalledTimes(1);
    expect(stopInstance).toHaveBeenCalledWith('disc-123', expect.objectContaining({ apiKey: 'k' }));
  });

  it('still no-ops when neither id nor apiKey is available (back-compat)', async () => {
    const stopInstance = vi.fn(async () => {});
    const registry = { get: () => ({ stopInstance }) } as any;
    await cl.cleanupProviderInstance({ provider: 'vast' } as any, registry, 'x');
    await cl.cleanupProviderInstance({ provider: 'vast', apiKey: 'k' } as any, registry, 'x');
    expect(stopInstance).not.toHaveBeenCalled();
  });

  it('static instanceId path is unchanged when no resolved id is passed', async () => {
    const stopInstance = vi.fn(async () => {});
    const registry = { get: () => ({ stopInstance }) } as any;
    await cl.cleanupProviderInstance(
      { provider: 'runpod', apiKey: 'k', instanceId: 'cfg-1' } as any,
      registry, 'x',
      { log() {}, warn() {}, error() {}, debug() {} } as any,
    );
    expect(stopInstance).toHaveBeenCalledWith('cfg-1', expect.objectContaining({ apiKey: 'k' }));
  });
});
