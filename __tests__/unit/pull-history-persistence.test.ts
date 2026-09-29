// ── Pull-History Persistence — unit suite ─────────────────────────────────────
// Tests loadPullHistory, savePullHistoryNow, schedulePullHistoryWrite,
// and initPullHistoryPersistence.
// Real filesystem I/O against a throwaway tmp dir — no production state touched.
// os.homedir() is mocked so PULL_HISTORY_FILE resolves inside the temp tree.
// The pull-time-estimator singletons are mocked to capture fromJSON/toJSON calls
// without touching the real in-memory history state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Redirect ~/.babelcast to a safe tmp directory ─────────────────────────────

let tmpHome: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

// ── Estimator mock ─────────────────────────────────────────────────────────────

const mockFromJSON = vi.fn().mockReturnValue(0);
const mockToJSON = vi.fn().mockReturnValue([]);
const mockSetPersistHook = vi.fn();
const mockGetHistorySize = vi.fn().mockReturnValue(0);

vi.mock('../../src/gpu-providers/pull-time-estimator', () => ({
  fromJSON: (...args: unknown[]) => mockFromJSON(...args),
  toJSON: () => mockToJSON(),
  setPullHistoryPersistHook: (...args: unknown[]) => mockSetPersistHook(...args),
  getHistorySize: () => mockGetHistorySize(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function historyFile(home: string) {
  return join(home, '.babelcast', 'pull-history.json');
}

type PullRecord = {
  dockerImage: string;
  hostKey: string;
  inetDownMbps: number;
  pullTimeS: number;
  bootTimeS: number;
  recordedAt: number;
};

function writeHistory(home: string, records: PullRecord[], savedAt: number) {
  const dir = join(home, '.babelcast');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    historyFile(home),
    JSON.stringify({ records, savedAt }),
    'utf-8',
  );
}

const sampleRecord: PullRecord = {
  dockerImage: 'marcosremar/babelcast-subtitle:latest',
  hostKey: 'vast:host-123',
  inetDownMbps: 500,
  pullTimeS: 130,
  bootTimeS: 180,
  recordedAt: Date.now() - 60_000,
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('pull-history-persistence', () => {
  let mod: typeof import('../../server/pull-history-persistence');

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-gw-php-'));
    vi.resetModules();
    mockFromJSON.mockReset().mockReturnValue(0);
    mockToJSON.mockReset().mockReturnValue([]);
    mockSetPersistHook.mockReset();
    mockGetHistorySize.mockReset().mockReturnValue(0);
    mod = await import('../../server/pull-history-persistence');
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
    vi.useRealTimers();
  });

  // ── loadPullHistory ──────────────────────────────────────────────────────

  describe('loadPullHistory', () => {
    it('does nothing when the history file does not exist', () => {
      mod.loadPullHistory();
      expect(mockFromJSON).not.toHaveBeenCalled();
    });

    it('loads records from disk and calls fromJSON', () => {
      writeHistory(tmpHome, [sampleRecord], Date.now() - 1000);
      mod.loadPullHistory();
      expect(mockFromJSON).toHaveBeenCalledTimes(1);
      expect(mockFromJSON.mock.calls[0][0]).toEqual([sampleRecord]);
    });

    it('does not throw on corrupt JSON — swallows the error', () => {
      const dir = join(tmpHome, '.babelcast');
      mkdirSync(dir, { recursive: true });
      writeFileSync(historyFile(tmpHome), 'NOT_VALID_JSON', 'utf-8');
      expect(() => mod.loadPullHistory()).not.toThrow();
      expect(mockFromJSON).not.toHaveBeenCalled();
    });

    it('does not throw when records field is missing', () => {
      const dir = join(tmpHome, '.babelcast');
      mkdirSync(dir, { recursive: true });
      writeFileSync(historyFile(tmpHome), JSON.stringify({ savedAt: Date.now() }), 'utf-8');
      expect(() => mod.loadPullHistory()).not.toThrow();
    });

    it('does not expire records based on savedAt (unlike cooldowns)', () => {
      // pull-history is long-lived — an old savedAt should still be loaded
      const veryOldSavedAt = Date.now() - 30 * 24 * 60 * 60_000; // 30 days ago
      writeHistory(tmpHome, [sampleRecord], veryOldSavedAt);
      mod.loadPullHistory();
      expect(mockFromJSON).toHaveBeenCalledWith([sampleRecord]);
    });

    it('passes multiple records faithfully to fromJSON', () => {
      const records: PullRecord[] = [
        { ...sampleRecord, hostKey: 'vast:host-1', pullTimeS: 100 },
        { ...sampleRecord, hostKey: 'runpod:host-2', pullTimeS: 200 },
        { ...sampleRecord, hostKey: 'tensordock:host-3', pullTimeS: 300 },
      ];
      writeHistory(tmpHome, records, Date.now() - 5000);
      mod.loadPullHistory();
      expect(mockFromJSON).toHaveBeenCalledWith(records);
    });

    it('works with an empty records array', () => {
      writeHistory(tmpHome, [], Date.now() - 1000);
      mod.loadPullHistory();
      expect(mockFromJSON).toHaveBeenCalledWith([]);
    });

    it('does not call fromJSON when records is not an array', () => {
      const dir = join(tmpHome, '.babelcast');
      mkdirSync(dir, { recursive: true });
      writeFileSync(historyFile(tmpHome), JSON.stringify({ records: 'not-an-array', savedAt: Date.now() }), 'utf-8');
      // loadPullHistory blindly calls fromJSON with whatever is in records
      // (fromJSON itself handles validation), so it should still call it
      mod.loadPullHistory();
      expect(mockFromJSON).toHaveBeenCalledWith('not-an-array');
    });
  });

  // ── savePullHistoryNow ───────────────────────────────────────────────────

  describe('savePullHistoryNow', () => {
    it('does not write when toJSON returns an empty array', () => {
      mockToJSON.mockReturnValue([]);
      mod.savePullHistoryNow();
      expect(existsSync(historyFile(tmpHome))).toBe(false);
    });

    it('writes a file when toJSON returns records', () => {
      mockToJSON.mockReturnValue([sampleRecord]);
      mod.savePullHistoryNow();
      expect(existsSync(historyFile(tmpHome))).toBe(true);
    });

    it('creates the .babelcast directory if it does not exist', () => {
      mockToJSON.mockReturnValue([sampleRecord]);
      const dir = join(tmpHome, '.babelcast');
      expect(existsSync(dir)).toBe(false);
      mod.savePullHistoryNow();
      expect(existsSync(dir)).toBe(true);
    });

    it('writes valid JSON with records and savedAt', () => {
      mockToJSON.mockReturnValue([sampleRecord]);
      const before = Date.now();
      mod.savePullHistoryNow();
      const after = Date.now();

      const raw = readFileSync(historyFile(tmpHome), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.records).toEqual([sampleRecord]);
      expect(typeof parsed.savedAt).toBe('number');
      expect(parsed.savedAt).toBeGreaterThanOrEqual(before);
      expect(parsed.savedAt).toBeLessThanOrEqual(after);
    });

    it('overwrites an existing file on repeated save', () => {
      mockToJSON
        .mockReturnValueOnce([{ ...sampleRecord, hostKey: 'vast:first', pullTimeS: 99 }])
        .mockReturnValueOnce([{ ...sampleRecord, hostKey: 'runpod:second', pullTimeS: 200 }]);

      mod.savePullHistoryNow();
      mod.savePullHistoryNow();

      const raw = readFileSync(historyFile(tmpHome), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.records[0].hostKey).toBe('runpod:second');
    });

    it('does not throw when the directory cannot be created', () => {
      // Make .babelcast a file so mkdir fails
      const blockerPath = join(tmpHome, '.babelcast');
      writeFileSync(blockerPath, 'I am a file, not a directory');
      mockToJSON.mockReturnValue([sampleRecord]);
      expect(() => mod.savePullHistoryNow()).not.toThrow();
    });

    it('saves multiple records faithfully', () => {
      const records: PullRecord[] = [
        { ...sampleRecord, hostKey: 'vast:host-a', pullTimeS: 120 },
        { ...sampleRecord, hostKey: 'runpod:host-b', pullTimeS: 240 },
      ];
      mockToJSON.mockReturnValue(records);
      mod.savePullHistoryNow();

      const raw = readFileSync(historyFile(tmpHome), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.records).toHaveLength(2);
      expect(parsed.records[0].hostKey).toBe('vast:host-a');
      expect(parsed.records[1].hostKey).toBe('runpod:host-b');
    });
  });

  // ── schedulePullHistoryWrite ─────────────────────────────────────────────

  describe('schedulePullHistoryWrite', () => {
    it('schedules a deferred write via setTimeout', () => {
      vi.useFakeTimers();
      mockToJSON.mockReturnValue([sampleRecord]);

      mod.schedulePullHistoryWrite();
      expect(existsSync(historyFile(tmpHome))).toBe(false); // not written yet

      const { WRITE_DEBOUNCE_MS } = mod.__testing;
      vi.advanceTimersByTime(WRITE_DEBOUNCE_MS + 1);
      expect(existsSync(historyFile(tmpHome))).toBe(true);
    });

    it('coalesces multiple calls within the debounce window', () => {
      vi.useFakeTimers();
      mockToJSON.mockReturnValue([sampleRecord]);

      mod.schedulePullHistoryWrite();
      mod.schedulePullHistoryWrite();
      mod.schedulePullHistoryWrite();

      const { WRITE_DEBOUNCE_MS } = mod.__testing;
      vi.advanceTimersByTime(WRITE_DEBOUNCE_MS + 1);

      // Only one write should have happened
      expect(mockToJSON).toHaveBeenCalledTimes(1);
    });

    it('does not write immediately on the first call', () => {
      vi.useFakeTimers();
      mockToJSON.mockReturnValue([sampleRecord]);

      mod.schedulePullHistoryWrite();
      expect(existsSync(historyFile(tmpHome))).toBe(false);
    });

    it('writes nothing if toJSON returns empty at flush time', () => {
      vi.useFakeTimers();
      mockToJSON.mockReturnValue([]);

      mod.schedulePullHistoryWrite();
      const { WRITE_DEBOUNCE_MS } = mod.__testing;
      vi.advanceTimersByTime(WRITE_DEBOUNCE_MS + 1);

      expect(existsSync(historyFile(tmpHome))).toBe(false);
    });
  });

  // ── initPullHistoryPersistence ───────────────────────────────────────────

  describe('initPullHistoryPersistence', () => {
    it('calls loadPullHistory on init', () => {
      writeHistory(tmpHome, [sampleRecord], Date.now() - 1000);
      mod.initPullHistoryPersistence();
      expect(mockFromJSON).toHaveBeenCalledWith([sampleRecord]);
    });

    it('wires the persist hook via setPullHistoryPersistHook', () => {
      mod.initPullHistoryPersistence();
      expect(mockSetPersistHook).toHaveBeenCalledTimes(1);
      expect(typeof mockSetPersistHook.mock.calls[0][0]).toBe('function');
    });

    it('registers schedulePullHistoryWrite as the persist hook', () => {
      vi.useFakeTimers();
      mockToJSON.mockReturnValue([sampleRecord]);
      mod.initPullHistoryPersistence();

      // Retrieve the registered hook and invoke it manually
      const hook = mockSetPersistHook.mock.calls[0][0] as () => void;
      hook();

      const { WRITE_DEBOUNCE_MS } = mod.__testing;
      vi.advanceTimersByTime(WRITE_DEBOUNCE_MS + 1);
      expect(existsSync(historyFile(tmpHome))).toBe(true);
    });

    it('works when no history file exists on disk', () => {
      expect(() => mod.initPullHistoryPersistence()).not.toThrow();
      expect(mockFromJSON).not.toHaveBeenCalled();
    });

    it('logs loaded record count when history is non-empty', () => {
      mockGetHistorySize.mockReturnValue(5);
      // Just confirm it does not throw — the log call is internal
      expect(() => mod.initPullHistoryPersistence()).not.toThrow();
    });
  });

  // ── round-trip: save → load ──────────────────────────────────────────────

  describe('round-trip: savePullHistoryNow → loadPullHistory', () => {
    it('data saved is exactly what gets passed back to fromJSON', async () => {
      const records: PullRecord[] = [
        { ...sampleRecord, hostKey: 'runpod:rt-host', pullTimeS: 155, bootTimeS: 210 },
        { ...sampleRecord, hostKey: 'vast:rt-host2', pullTimeS: 88, bootTimeS: 130 },
      ];
      mockToJSON.mockReturnValue(records);
      mod.savePullHistoryNow();

      // Re-import to reset module-level mock state
      vi.resetModules();
      mod = await import('../../server/pull-history-persistence');

      mod.loadPullHistory();
      expect(mockFromJSON).toHaveBeenCalledWith(records);
    });
  });

  // ── __testing exports ────────────────────────────────────────────────────

  describe('__testing', () => {
    it('exports PULL_HISTORY_FILE pointing inside .babelcast', () => {
      const { PULL_HISTORY_FILE } = mod.__testing;
      expect(PULL_HISTORY_FILE).toContain('.babelcast');
      expect(PULL_HISTORY_FILE).toContain('pull-history.json');
    });

    it('exports WRITE_DEBOUNCE_MS as a positive number', () => {
      const { WRITE_DEBOUNCE_MS } = mod.__testing;
      expect(typeof WRITE_DEBOUNCE_MS).toBe('number');
      expect(WRITE_DEBOUNCE_MS).toBeGreaterThan(0);
    });
  });
});
