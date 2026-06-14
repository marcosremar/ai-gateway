/**
 * Optimization tests — Storage, Database, State & Config (IDs 701-800).
 *
 * Unit-only. No real DB or network: Prisma is mocked, filesystem tests use
 * os.tmpdir() exclusively. Covers:
 *   - atomicWrite + fsync durability (#705) and createWriteBuffer fixes (#718/#719)
 *   - daily_spend atomic write + date-rollover reset (#701/#717)
 *   - cooldowns atomic write (#702)
 *   - pid-lock shutdown-flush registry serialization & isolation (#711/#712/#713)
 *   - latency-db saveProbeResult transaction wrapper (#721)
 *   - config clone-on-read (#771) and write-mutex serialization (#770)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── #705 / #718 / #719 — async-fs atomicWrite + createWriteBuffer ────────────

describe('async-fs atomicWrite (#705)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'opt08-afs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes the exact content with fsync enabled (default) and leaves no temp file', async () => {
    const { atomicWrite } = await import('../../src/async-fs');
    const target = join(dir, 'state.json');
    await atomicWrite(target, '{"a":1}');
    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}');
    // temp files are named `${path}.tmp.<ts>` — none should survive the rename
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('overwrites atomically on a second write', async () => {
    const { atomicWrite } = await import('../../src/async-fs');
    const target = join(dir, 'state.json');
    await atomicWrite(target, 'first');
    await atomicWrite(target, 'second');
    expect(readFileSync(target, 'utf-8')).toBe('second');
  });

  it('honors fsync:false (no fsync path) and still writes correctly', async () => {
    const { atomicWrite } = await import('../../src/async-fs');
    const target = join(dir, 'cache.json');
    await atomicWrite(target, 'cached', { fsync: false });
    expect(readFileSync(target, 'utf-8')).toBe('cached');
  });

  it('atomicWriteJson serializes and round-trips', async () => {
    const { atomicWriteJson } = await import('../../src/async-fs');
    const target = join(dir, 'obj.json');
    await atomicWriteJson(target, { x: [1, 2], y: 'z' });
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ x: [1, 2], y: 'z' });
  });
});

describe('async-fs createWriteBuffer (#718/#719)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'opt08-buf-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('flush() persists the latest pending data', async () => {
    const { createWriteBuffer } = await import('../../src/async-fs');
    const target = join(dir, 'buf.json');
    const buf = createWriteBuffer(target, { flushIntervalMs: 50 });
    buf.write('one');
    buf.write('two');
    expect(buf.pending).toBe('two');
    await buf.flush();
    expect(readFileSync(target, 'utf-8')).toBe('two');
    expect(buf.pending).toBeNull();
  });

  it('flush() restores pending data when the write fails so it is not silently dropped (#718)', async () => {
    const { createWriteBuffer } = await import('../../src/async-fs');
    // Point at a path whose parent is a *file*, forcing the write to throw.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const target = join(blocker, 'nested.json'); // ENOTDIR on write
    const buf = createWriteBuffer(target, { flushIntervalMs: 50, atomic: false });
    buf.write('payload');
    await expect(buf.flush()).rejects.toBeTruthy();
    // Data must survive for a later retry rather than vanish.
    expect(buf.pending).toBe('payload');
  });

  it('close() flushes and clears the timer', async () => {
    const { createWriteBuffer } = await import('../../src/async-fs');
    const target = join(dir, 'close.json');
    const buf = createWriteBuffer(target, { flushIntervalMs: 10_000 });
    buf.write('done');
    await buf.close();
    expect(readFileSync(target, 'utf-8')).toBe('done');
  });
});

// ── #701 / #717 — daily_spend persistence ────────────────────────────────────

describe('cost-state daily_spend persistence (#701/#717)', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opt08-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules(); // re-evaluate module so BABELCAST_DIR picks up the new HOME
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('persistDailySpend writes valid JSON atomically (no leftover .tmp)', async () => {
    const mod = await import('../../src/gateway/state/cost-state');
    mod.setDailyGpuSpendUsd(12.5);
    mod.flushDailySpend(); // force synchronous write
    const file = join(home, '.babelcast', 'daily_spend.json');
    expect(existsSync(file)).toBe(true);
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    expect(data.spendUsd).toBe(12.5);
    expect(typeof data.date).toBe('string');
    expect(existsSync(file + '.tmp')).toBe(false);
  });

  it('loadPersistedDailySpend restores spend recorded for today', async () => {
    const dir = join(home, '.babelcast');
    mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(dir, 'daily_spend.json'), JSON.stringify({ date: today, spendUsd: 7.25, savedAt: Date.now() }));
    const mod = await import('../../src/gateway/state/cost-state');
    mod.loadPersistedDailySpend();
    expect(mod.dailyGpuSpendUsd).toBe(7.25);
  });

  it('rewrites the on-disk file to $0/today on a date rollover (#717)', async () => {
    const dir = join(home, '.babelcast');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'daily_spend.json');
    // Stale record from "yesterday" with a non-zero spend.
    writeFileSync(file, JSON.stringify({ date: '2020-01-01', spendUsd: 99, savedAt: Date.now() }));
    const mod = await import('../../src/gateway/state/cost-state');
    mod.loadPersistedDailySpend();
    // In-memory counter must not inherit yesterday's spend.
    expect(mod.dailyGpuSpendUsd).toBe(0);
    // Disk must be rewritten to today/$0 so a crash before the next write
    // cannot re-read the stale value.
    const after = JSON.parse(readFileSync(file, 'utf-8'));
    expect(after.spendUsd).toBe(0);
    expect(after.date).toBe(new Date().toISOString().slice(0, 10));
  });
});

// ── #702 — cooldowns persistence atomic write ────────────────────────────────

describe('cooldown-persistence saveCooldownState (#702)', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opt08-cool-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('writes valid JSON via tmp+rename with no leftover temp file', async () => {
    // Mock the trackers so we exercise the file write path deterministically.
    vi.doMock('../../src/providers/fallback', () => ({
      defaultCooldownTracker: {
        toJSON: () => ({ groq: { failures: 2, windowStart: 1, coolUntil: 999 } }),
        fromJSON: vi.fn(),
      },
    }));
    vi.doMock('../../src/providers/credit-block', () => ({
      defaultCreditBlockTracker: { toJSON: () => ({ openai: 5 }), fromJSON: vi.fn() },
    }));
    const mod = await import('../../server/cooldown-persistence');
    mod.saveCooldownState();
    const file = join(home, '.babelcast', 'cooldowns.json');
    expect(existsSync(file)).toBe(true);
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    expect(data.cooldowns.groq.failures).toBe(2);
    expect(data.creditBlocks.openai).toBe(5);
    expect(existsSync(file + '.tmp')).toBe(false);
    vi.doUnmock('../../src/providers/fallback');
    vi.doUnmock('../../src/providers/credit-block');
  });

  it('writes nothing when there are no entries to persist', async () => {
    vi.doMock('../../src/providers/fallback', () => ({
      defaultCooldownTracker: { toJSON: () => ({}), fromJSON: vi.fn() },
    }));
    vi.doMock('../../src/providers/credit-block', () => ({
      defaultCreditBlockTracker: { toJSON: () => ({}), fromJSON: vi.fn() },
    }));
    const mod = await import('../../server/cooldown-persistence');
    mod.saveCooldownState();
    const file = join(home, '.babelcast', 'cooldowns.json');
    expect(existsSync(file)).toBe(false);
    vi.doUnmock('../../src/providers/fallback');
    vi.doUnmock('../../src/providers/credit-block');
  });
});

// ── #711 / #712 / #713 — pid-lock shutdown flush registry ────────────────────

describe('pid-lock shutdown flush registry (#711/#712/#713)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('runs registered flushes in registration order', async () => {
    const mod = await import('../../server/ws/pid-lock');
    mod.__clearShutdownFlushes();
    const order: string[] = [];
    mod.registerShutdownFlush('a', () => order.push('a'));
    mod.registerShutdownFlush('b', () => order.push('b'));
    mod.runShutdownFlushes();
    expect(order).toEqual(['a', 'b']);
  });

  it('is idempotent by name (does not double-register)', async () => {
    const mod = await import('../../server/ws/pid-lock');
    mod.__clearShutdownFlushes();
    const fn = vi.fn();
    mod.registerShutdownFlush('dup', fn);
    mod.registerShutdownFlush('dup', fn);
    mod.runShutdownFlushes();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('isolates failures — one throwing flush does not block the others', async () => {
    const mod = await import('../../server/ws/pid-lock');
    mod.__clearShutdownFlushes();
    const after = vi.fn();
    mod.registerShutdownFlush('boom', () => { throw new Error('flush failed'); });
    mod.registerShutdownFlush('after', after);
    expect(() => mod.runShutdownFlushes()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

// ── #721 — latency-db saveProbeResult transaction wrapper ─────────────────────

describe('latency-db probe transaction (#721)', () => {
  function makeClient() {
    return {
      hostLatencyHistory: {
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn()
          .mockResolvedValueOnce([{ id: 10 }])              // toKeep (< HISTORY_SIZE)
          .mockResolvedValueOnce([{ medianMs: 30 }, { medianMs: 50 }]), // rolling stats
        deleteMany: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(4),
      },
      hostLatency: { update: vi.fn().mockResolvedValue({}) },
    };
  }

  beforeEach(() => { vi.resetModules(); });

  it('runProbeOps issues the 5 dependent ops against the supplied (transactional) client', async () => {
    vi.doMock('../../server/state', () => ({ prisma: {} }));
    const { runProbeOps } = await import('../../server/latency-db');
    const client = makeClient();
    await runProbeOps(client as any, 'host-1', { medianMs: 40, p90Ms: 70, samples: 3 }, 1_700_000_000_000);

    expect(client.hostLatencyHistory.create).toHaveBeenCalledOnce();
    expect(client.hostLatencyHistory.create.mock.calls[0][0].data.hostId).toBe('host-1');
    expect(client.hostLatencyHistory.findMany).toHaveBeenCalledTimes(2);
    expect(client.hostLatencyHistory.count).toHaveBeenCalledOnce();
    const updateCall = client.hostLatency.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ hostId: 'host-1' });
    expect(updateCall.data.successRate).toBe(0.5); // 2 medians / 4 total
    expect(updateCall.data.consecutiveFailures).toBe(0); // samples > 0
    vi.doUnmock('../../server/state');
  });

  it('saveProbeResult routes through prisma.$transaction when available', async () => {
    const txClient = makeClient();
    const $transaction = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(txClient));
    vi.doMock('../../server/state', () => ({ prisma: { $transaction } }));
    const { saveProbeResult } = await import('../../server/latency-db');
    await saveProbeResult('host-1', { medianMs: 40, p90Ms: 70, samples: 3 }, 1_700_000_000_000);

    expect($transaction).toHaveBeenCalledOnce();
    // The 5 ops ran against the transactional client, not the top-level one.
    expect(txClient.hostLatencyHistory.create).toHaveBeenCalledOnce();
    expect(txClient.hostLatency.update).toHaveBeenCalledOnce();
    vi.doUnmock('../../server/state');
  });

  it('saveProbeResult falls back to the bare client when $transaction is absent (mock/no-op proxy)', async () => {
    const bare = makeClient();
    vi.doMock('../../server/state', () => ({ prisma: bare }));
    const { saveProbeResult } = await import('../../server/latency-db');
    await saveProbeResult('host-1', { medianMs: 40, p90Ms: 70, samples: 3 }, 1_700_000_000_000);
    // No $transaction → ops still run directly (preserves existing behavior).
    expect(bare.hostLatencyHistory.create).toHaveBeenCalledOnce();
    expect(bare.hostLatency.update).toHaveBeenCalledOnce();
    vi.doUnmock('../../server/state');
  });
});

// ── #770 / #771 — config clone-on-read + write mutex ─────────────────────────

describe('config-persistence clone + lock (#770/#771)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('cloneProviderConfig deep-copies so mutating the clone leaves the original intact (#771)', async () => {
    const { cloneProviderConfig } = await import('../../server/config-persistence');
    const original: any = {
      apps: [{ id: 'a', name: 'A', stt: [{ provider: 'groq' }] }],
      activeAppId: 'a',
      pipelineStt: [{ provider: 'groq' }],
      pipelineLlm: [],
      pipelineTts: [],
      idleTimeoutMin: 5,
      updatedAt: 0,
    };
    const clone = cloneProviderConfig(original);
    clone.apps[0].name = 'MUTATED';
    clone.apps.push({ id: 'b', name: 'B' } as any);
    (clone.pipelineStt[0] as any).provider = 'openai';
    // Original must be untouched.
    expect(original.apps).toHaveLength(1);
    expect(original.apps[0].name).toBe('A');
    expect((original.pipelineStt[0] as any).provider).toBe('groq');
  });

  it('withConfigLock serializes overlapping critical sections (#770)', async () => {
    const { withConfigLock } = await import('../../server/config-persistence');
    const events: string[] = [];
    const task = (id: string) => withConfigLock(async () => {
      events.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${id}`);
      return id;
    });
    // Fire two concurrently — they must not interleave.
    const [r1, r2] = await Promise.all([task('1'), task('2')]);
    expect(r1).toBe('1');
    expect(r2).toBe('2');
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('withConfigLock keeps the chain alive after a rejected critical section (#770)', async () => {
    const { withConfigLock } = await import('../../server/config-persistence');
    await expect(withConfigLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // A subsequent caller must still run.
    const ok = await withConfigLock(async () => 'recovered');
    expect(ok).toBe('recovered');
  });
});
