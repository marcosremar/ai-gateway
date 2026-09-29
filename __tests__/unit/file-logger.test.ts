// ── File Logger — unit suite ───────────────────────────────────────────────────
// Validates JSONL write, read-tail, and lifecycle-logger against a real tmp dir.
// LOG_DIR is redirected via vi.stubEnv so production state is never touched.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  mkdtempSync, rmSync, existsSync, statSync,
  writeFileSync, mkdirSync, readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Mock logger (no console noise, no fs side-effects from logger itself) ─────

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── Dynamic-import trick: stub LOG_DIR *before* module init ───────────────────

let tmpDir: string;
let mod: typeof import('../../server/file-logger');

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-logger-test-'));
  vi.stubEnv('LOG_DIR', tmpDir);
  vi.resetModules();
  mod = await import('../../server/file-logger');
});

afterAll(() => {
  vi.unstubAllEnvs();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  // Wipe log files between tests so each test starts with clean state
  for (const f of ['events.jsonl', 'gpu.jsonl', 'server.log']) {
    try { rmSync(join(tmpDir, f)); } catch { /* ok if missing */ }
  }
  // Clean up any rotation copies
  for (const f of ['events.jsonl', 'gpu.jsonl', 'server.log']) {
    for (let i = 1; i <= 4; i++) {
      try { rmSync(join(tmpDir, `${f}.${i}`)); } catch { /* ok */ }
    }
  }
});

// ── Exported constants ────────────────────────────────────────────────────────

describe('exported path constants', () => {
  it('LOG_DIR matches the stubbed env value', () => {
    expect(mod.LOG_DIR).toBe(tmpDir);
  });

  it('EVENTS_FILE is events.jsonl inside LOG_DIR', () => {
    expect(mod.EVENTS_FILE).toBe(join(tmpDir, 'events.jsonl'));
  });

  it('GPU_FILE is gpu.jsonl inside LOG_DIR', () => {
    expect(mod.GPU_FILE).toBe(join(tmpDir, 'gpu.jsonl'));
  });

  it('SERVER_FILE is server.log inside LOG_DIR', () => {
    expect(mod.SERVER_FILE).toBe(join(tmpDir, 'server.log'));
  });
});

// ── logGpuEventToFile ─────────────────────────────────────────────────────────

describe('logGpuEventToFile', () => {
  it('creates gpu.jsonl and writes a valid JSON record', () => {
    mod.logGpuEventToFile('deploy_start', 'runpod', true);
    expect(existsSync(mod.GPU_FILE)).toBe(true);
    const line = readFileSync(mod.GPU_FILE, 'utf-8').trim();
    const record = JSON.parse(line);
    expect(record.event).toBe('deploy_start');
    expect(record.provider).toBe('runpod');
    expect(record.success).toBe(true);
  });

  it('ts field is an ISO-8601 timestamp string', () => {
    mod.logGpuEventToFile('health_check', 'vast', true);
    const line = readFileSync(mod.GPU_FILE, 'utf-8').trim();
    const record = JSON.parse(line);
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(() => new Date(record.ts)).not.toThrow();
    expect(new Date(record.ts).getTime()).toBeGreaterThan(0);
  });

  it('records success=false correctly', () => {
    mod.logGpuEventToFile('deploy_failed', 'tensordock', false);
    const record = JSON.parse(readFileSync(mod.GPU_FILE, 'utf-8').trim());
    expect(record.success).toBe(false);
  });

  it('includes durationMs when provided', () => {
    mod.logGpuEventToFile('deploy_done', 'runpod', true, { durationMs: 4200 });
    const record = JSON.parse(readFileSync(mod.GPU_FILE, 'utf-8').trim());
    expect(record.durationMs).toBe(4200);
  });

  it('includes cooldownMs when provided', () => {
    mod.logGpuEventToFile('rate_limit', 'vast', false, { cooldownMs: 30_000 });
    const record = JSON.parse(readFileSync(mod.GPU_FILE, 'utf-8').trim());
    expect(record.cooldownMs).toBe(30_000);
  });

  it('includes failCount when provided', () => {
    mod.logGpuEventToFile('boot_error', 'tensordock', false, { failCount: 3 });
    const record = JSON.parse(readFileSync(mod.GPU_FILE, 'utf-8').trim());
    expect(record.failCount).toBe(3);
  });

  it('includes error string when provided', () => {
    mod.logGpuEventToFile('crash', 'runpod', false, { error: 'OOM: out of memory' });
    const record = JSON.parse(readFileSync(mod.GPU_FILE, 'utf-8').trim());
    expect(record.error).toBe('OOM: out of memory');
  });

  it('includes metadata object when provided', () => {
    mod.logGpuEventToFile('snapshot', 'vast', true, { metadata: { podId: 'abc-123', vram: 24 } });
    const record = JSON.parse(readFileSync(mod.GPU_FILE, 'utf-8').trim());
    expect(record.metadata).toEqual({ podId: 'abc-123', vram: 24 });
  });

  it('omits optional fields when opts not provided', () => {
    mod.logGpuEventToFile('idle_stop', 'runpod', true);
    const record = JSON.parse(readFileSync(mod.GPU_FILE, 'utf-8').trim());
    expect(record.durationMs).toBeUndefined();
    expect(record.cooldownMs).toBeUndefined();
    expect(record.failCount).toBeUndefined();
    expect(record.error).toBeUndefined();
    expect(record.metadata).toBeUndefined();
  });

  it('omits optional fields when opts values are undefined', () => {
    mod.logGpuEventToFile('idle_stop', 'runpod', true, {
      durationMs: undefined,
      cooldownMs: undefined,
      failCount: undefined,
      error: undefined,
      metadata: undefined,
    });
    const record = JSON.parse(readFileSync(mod.GPU_FILE, 'utf-8').trim());
    expect(record.durationMs).toBeUndefined();
    expect(record.cooldownMs).toBeUndefined();
    expect(record.failCount).toBeUndefined();
    expect(record.error).toBeUndefined();
    expect(record.metadata).toBeUndefined();
  });

  it('appends multiple records as separate JSONL lines', () => {
    mod.logGpuEventToFile('event_a', 'runpod', true);
    mod.logGpuEventToFile('event_b', 'vast', false);
    mod.logGpuEventToFile('event_c', 'modal', true);
    const lines = readFileSync(mod.GPU_FILE, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event).toBe('event_a');
    expect(JSON.parse(lines[1]).event).toBe('event_b');
    expect(JSON.parse(lines[2]).event).toBe('event_c');
  });

  it('all three records from separate calls are valid JSON', () => {
    mod.logGpuEventToFile('a', 'p1', true, { durationMs: 1 });
    mod.logGpuEventToFile('b', 'p2', false, { error: 'oops' });
    mod.logGpuEventToFile('c', 'p3', true, { metadata: { x: 1 } });
    const lines = readFileSync(mod.GPU_FILE, 'utf-8').trim().split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ── fileLifecycleLogger ───────────────────────────────────────────────────────

describe('fileLifecycleLogger', () => {
  it('log() creates events.jsonl on first call', () => {
    expect(existsSync(mod.EVENTS_FILE)).toBe(false);
    mod.fileLifecycleLogger.log({ event: 'deploy', provider: 'runpod' } as Parameters<typeof mod.fileLifecycleLogger.log>[0]);
    expect(existsSync(mod.EVENTS_FILE)).toBe(true);
  });

  it('log() writes a valid JSONL record containing the entry fields', () => {
    mod.fileLifecycleLogger.log({ event: 'boot_complete', provider: 'vast', podId: 'xyz' } as Parameters<typeof mod.fileLifecycleLogger.log>[0]);
    const line = readFileSync(mod.EVENTS_FILE, 'utf-8').trim();
    const record = JSON.parse(line);
    expect(record.event).toBe('boot_complete');
    expect(record.provider).toBe('vast');
    expect(record.podId).toBe('xyz');
  });

  it('log() adds a ts field to the record', () => {
    mod.fileLifecycleLogger.log({ event: 'idle_stop', provider: 'modal' } as Parameters<typeof mod.fileLifecycleLogger.log>[0]);
    const record = JSON.parse(readFileSync(mod.EVENTS_FILE, 'utf-8').trim());
    expect(record.ts).toBeDefined();
    expect(typeof record.ts).toBe('string');
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('log() appends multiple entries as separate lines', () => {
    mod.fileLifecycleLogger.log({ event: 'e1', provider: 'p1' } as Parameters<typeof mod.fileLifecycleLogger.log>[0]);
    mod.fileLifecycleLogger.log({ event: 'e2', provider: 'p2' } as Parameters<typeof mod.fileLifecycleLogger.log>[0]);
    const lines = readFileSync(mod.EVENTS_FILE, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('e1');
    expect(JSON.parse(lines[1]).event).toBe('e2');
  });

  it('log() preserves all entry fields verbatim', () => {
    const entry = { event: 'health', provider: 'runpod', durationMs: 999, success: false } as Parameters<typeof mod.fileLifecycleLogger.log>[0];
    mod.fileLifecycleLogger.log(entry);
    const record = JSON.parse(readFileSync(mod.EVENTS_FILE, 'utf-8').trim());
    expect(record.event).toBe('health');
    expect(record.provider).toBe('runpod');
    expect(record.durationMs).toBe(999);
    expect(record.success).toBe(false);
  });
});

// ── readRecentEvents ──────────────────────────────────────────────────────────

describe('readRecentEvents', () => {
  it('returns [] when events.jsonl does not exist', () => {
    expect(existsSync(mod.EVENTS_FILE)).toBe(false);
    expect(mod.readRecentEvents()).toEqual([]);
  });

  it('returns [] for an empty events.jsonl', () => {
    writeFileSync(mod.EVENTS_FILE, '');
    expect(mod.readRecentEvents()).toEqual([]);
  });

  it('returns all lines from a file with few entries', () => {
    writeFileSync(mod.EVENTS_FILE, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const lines = mod.readRecentEvents();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('{"a":1}');
    expect(lines[1]).toBe('{"b":2}');
    expect(lines[2]).toBe('{"c":3}');
  });

  it('respects the lines argument — returns last N lines', () => {
    const entries = Array.from({ length: 10 }, (_, i) => JSON.stringify({ i })).join('\n');
    writeFileSync(mod.EVENTS_FILE, entries + '\n');
    const last3 = mod.readRecentEvents(3);
    expect(last3).toHaveLength(3);
    expect(JSON.parse(last3[0]).i).toBe(7);
    expect(JSON.parse(last3[1]).i).toBe(8);
    expect(JSON.parse(last3[2]).i).toBe(9);
  });

  it('defaults to 100 lines', () => {
    const entries = Array.from({ length: 150 }, (_, i) => JSON.stringify({ i })).join('\n');
    writeFileSync(mod.EVENTS_FILE, entries + '\n');
    expect(mod.readRecentEvents()).toHaveLength(100);
  });

  it('caps at MAX_READ_LINES (1000) regardless of argument', () => {
    const entries = Array.from({ length: 1200 }, (_, i) => JSON.stringify({ i })).join('\n');
    writeFileSync(mod.EVENTS_FILE, entries + '\n');
    const lines = mod.readRecentEvents(1200);
    expect(lines.length).toBeLessThanOrEqual(1000);
  });
});

// ── readRecentGpuEvents ───────────────────────────────────────────────────────

describe('readRecentGpuEvents', () => {
  it('returns [] when gpu.jsonl does not exist', () => {
    expect(mod.readRecentGpuEvents()).toEqual([]);
  });

  it('returns all lines from gpu.jsonl', () => {
    writeFileSync(mod.GPU_FILE, '{"event":"a"}\n{"event":"b"}\n');
    const lines = mod.readRecentGpuEvents();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('a');
    expect(JSON.parse(lines[1]).event).toBe('b');
  });

  it('respects lines argument', () => {
    const entries = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i })).join('\n');
    writeFileSync(mod.GPU_FILE, entries + '\n');
    expect(mod.readRecentGpuEvents(5)).toHaveLength(5);
  });

  it('defaults to 100 lines', () => {
    const entries = Array.from({ length: 150 }, (_, i) => JSON.stringify({ i })).join('\n');
    writeFileSync(mod.GPU_FILE, entries + '\n');
    expect(mod.readRecentGpuEvents()).toHaveLength(100);
  });
});

// ── readRecentServerLogs ──────────────────────────────────────────────────────

describe('readRecentServerLogs', () => {
  it('returns [] when server.log does not exist', () => {
    expect(mod.readRecentServerLogs()).toEqual([]);
  });

  it('returns all lines from server.log', () => {
    writeFileSync(mod.SERVER_FILE, '2024-01-01T00:00:00.000Z [INFO] starting\n2024-01-01T00:00:01.000Z [WARN] slow\n');
    const lines = mod.readRecentServerLogs();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[INFO] starting');
    expect(lines[1]).toContain('[WARN] slow');
  });

  it('respects lines argument', () => {
    const entries = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(mod.SERVER_FILE, entries + '\n');
    expect(mod.readRecentServerLogs(10)).toHaveLength(10);
  });

  it('defaults to 200 lines', () => {
    const entries = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(mod.SERVER_FILE, entries + '\n');
    expect(mod.readRecentServerLogs()).toHaveLength(200);
  });
});

// ── installConsoleCapture ─────────────────────────────────────────────────────

describe('installConsoleCapture', () => {
  let origLog: typeof console.log;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;

  beforeAll(() => {
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
  });

  afterAll(() => {
    // Restore console methods regardless of what installConsoleCapture did
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  it('replaces console.log with a wrapper function', () => {
    mod.installConsoleCapture();
    expect(console.log).not.toBe(origLog);
  });

  it('replaces console.warn with a wrapper function', () => {
    expect(console.warn).not.toBe(origWarn);
  });

  it('replaces console.error with a wrapper function', () => {
    expect(console.error).not.toBe(origError);
  });

  it('console.log writes a line to server.log', () => {
    console.log('test capture message');
    expect(existsSync(mod.SERVER_FILE)).toBe(true);
    const content = readFileSync(mod.SERVER_FILE, 'utf-8');
    expect(content).toContain('test capture message');
  });

  it('console.warn writes a WARN line to server.log', () => {
    console.warn('test warn message');
    const content = readFileSync(mod.SERVER_FILE, 'utf-8');
    expect(content).toContain('[WARN]');
    expect(content).toContain('test warn message');
  });

  it('console.error writes an ERROR line to server.log', () => {
    console.error('test error message');
    const content = readFileSync(mod.SERVER_FILE, 'utf-8');
    expect(content).toContain('[ERROR]');
    expect(content).toContain('test error message');
  });

  it('server.log lines include a timestamp prefix', () => {
    // Write fresh file
    try { rmSync(mod.SERVER_FILE); } catch { /* ok */ }
    console.log('timestamped message');
    const line = readFileSync(mod.SERVER_FILE, 'utf-8').trim().split('\n')[0];
    // ISO timestamp prefix expected
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('objects are JSON-stringified in captured output', () => {
    try { rmSync(mod.SERVER_FILE); } catch { /* ok */ }
    console.log({ key: 'value', num: 42 });
    const content = readFileSync(mod.SERVER_FILE, 'utf-8');
    expect(content).toContain('"key":"value"');
    expect(content).toContain('"num":42');
  });
});

// ── JSONL integrity — round-trip through write + read ────────────────────────

describe('JSONL round-trip', () => {
  it('logGpuEventToFile → readRecentGpuEvents produces parseable records', () => {
    mod.logGpuEventToFile('alpha', 'runpod', true, { durationMs: 100 });
    mod.logGpuEventToFile('beta', 'vast', false, { error: 'timeout' });
    const lines = mod.readRecentGpuEvents();
    expect(lines).toHaveLength(2);
    const r1 = JSON.parse(lines[0]);
    const r2 = JSON.parse(lines[1]);
    expect(r1.event).toBe('alpha');
    expect(r1.durationMs).toBe(100);
    expect(r2.event).toBe('beta');
    expect(r2.error).toBe('timeout');
  });

  it('fileLifecycleLogger.log → readRecentEvents round-trips correctly', () => {
    mod.fileLifecycleLogger.log({ event: 'deploy', provider: 'runpod', podId: 'p-1' } as Parameters<typeof mod.fileLifecycleLogger.log>[0]);
    mod.fileLifecycleLogger.log({ event: 'stop', provider: 'runpod', podId: 'p-1' } as Parameters<typeof mod.fileLifecycleLogger.log>[0]);
    const lines = mod.readRecentEvents();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('deploy');
    expect(JSON.parse(lines[1]).event).toBe('stop');
  });

  it('readRecentEvents(1) returns only the last entry', () => {
    for (let i = 0; i < 5; i++) {
      mod.fileLifecycleLogger.log({ event: `e${i}`, provider: 'p' } as Parameters<typeof mod.fileLifecycleLogger.log>[0]);
    }
    const last = mod.readRecentEvents(1);
    expect(last).toHaveLength(1);
    expect(JSON.parse(last[0]).event).toBe('e4');
  });
});
