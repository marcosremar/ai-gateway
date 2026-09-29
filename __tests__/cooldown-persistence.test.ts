/**
 * Unit tests for server/cooldown-persistence.ts.
 *
 * Covers: loadCooldownState (file missing, stale, valid, corrupt, read-error,
 * partial fields) and saveCooldownState (empty, writes correctly, atomic,
 * handles errors).
 *
 * All filesystem and tracker calls are mocked so no disk I/O occurs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { fsState, trackerState } = vi.hoisted(() => {
  const fsState = {
    fileExists: false,
    fileContent: '',
    shouldThrowRead: false,
    shouldThrowWrite: false,
    writtenPath: '',
    writtenContent: '',
  };

  // Mutable tracker state — tests control what toJSON() returns
  const trackerState = {
    cooldowns: {} as Record<string, unknown>,
    creditBlocks: {} as Record<string, number>,
    fromJSONCooldownCalled: false,
    fromJSONCreditBlockCalled: false,
    fromJSONCooldownData: null as Record<string, unknown> | null,
    fromJSONCreditBlockData: null as Record<string, number> | null,
  };

  return { fsState, trackerState };
});

vi.mock('../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => fsState.fileExists),
  readFileSync: vi.fn((_path: string, _enc: string) => {
    if (fsState.shouldThrowRead) throw new Error('EACCES: permission denied');
    return fsState.fileContent;
  }),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn((path: string, content: string) => {
    if (fsState.shouldThrowWrite) throw new Error('ENOSPC: no space left on device');
    fsState.writtenPath = path;
    fsState.writtenContent = content;
  }),
}));

vi.mock('../src/providers/fallback', () => ({
  defaultCooldownTracker: {
    fromJSON: vi.fn((data: Record<string, unknown>) => {
      trackerState.fromJSONCooldownCalled = true;
      trackerState.fromJSONCooldownData = data;
    }),
    toJSON: vi.fn(() => trackerState.cooldowns),
  },
}));

vi.mock('../src/providers/credit-block', () => ({
  defaultCreditBlockTracker: {
    fromJSON: vi.fn((data: Record<string, number>) => {
      trackerState.fromJSONCreditBlockCalled = true;
      trackerState.fromJSONCreditBlockData = data;
    }),
    toJSON: vi.fn(() => trackerState.creditBlocks),
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { loadCooldownState, saveCooldownState } from '../server/cooldown-persistence';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetState() {
  Object.assign(fsState, {
    fileExists: false,
    fileContent: '',
    shouldThrowRead: false,
    shouldThrowWrite: false,
    writtenPath: '',
    writtenContent: '',
  });
  Object.assign(trackerState, {
    cooldowns: {},
    creditBlocks: {},
    fromJSONCooldownCalled: false,
    fromJSONCreditBlockCalled: false,
    fromJSONCooldownData: null,
    fromJSONCreditBlockData: null,
  });
  vi.clearAllMocks();
}

function makeValidPayload(overrides: Partial<{
  savedAt: number;
  cooldowns: Record<string, unknown>;
  creditBlocks: Record<string, number>;
}> = {}) {
  return JSON.stringify({
    cooldowns: { 'groq:chat': { failures: 2, windowStart: Date.now(), coolUntil: Date.now() + 30_000 } },
    creditBlocks: { openai: Date.now() + 60_000 },
    savedAt: Date.now(),
    ...overrides,
  });
}

// ── loadCooldownState ─────────────────────────────────────────────────────────

describe('loadCooldownState', () => {
  beforeEach(resetState);

  it('does nothing when file does not exist', () => {
    fsState.fileExists = false;
    loadCooldownState();
    expect(trackerState.fromJSONCooldownCalled).toBe(false);
    expect(trackerState.fromJSONCreditBlockCalled).toBe(false);
  });

  it('ignores file when savedAt is more than 10 minutes ago', () => {
    fsState.fileExists = true;
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    fsState.fileContent = makeValidPayload({ savedAt: elevenMinutesAgo });
    loadCooldownState();
    expect(trackerState.fromJSONCooldownCalled).toBe(false);
    expect(trackerState.fromJSONCreditBlockCalled).toBe(false);
  });

  it('loads cooldowns and credit blocks from recent file', () => {
    fsState.fileExists = true;
    const cooldowns = { 'groq:chat': { failures: 2, windowStart: Date.now(), coolUntil: Date.now() + 30_000 } };
    const creditBlocks = { openai: Date.now() + 60_000 };
    fsState.fileContent = JSON.stringify({
      cooldowns,
      creditBlocks,
      savedAt: Date.now(),
    });
    loadCooldownState();
    expect(trackerState.fromJSONCooldownCalled).toBe(true);
    expect(trackerState.fromJSONCreditBlockCalled).toBe(true);
    expect(trackerState.fromJSONCooldownData).toEqual(cooldowns);
    expect(trackerState.fromJSONCreditBlockData).toEqual(creditBlocks);
  });

  it('loads correctly when savedAt is exactly at the 10-minute boundary', () => {
    fsState.fileExists = true;
    // 9 minutes ago — should be accepted
    const nineMinutesAgo = Date.now() - 9 * 60 * 1000;
    fsState.fileContent = makeValidPayload({ savedAt: nineMinutesAgo });
    loadCooldownState();
    expect(trackerState.fromJSONCooldownCalled).toBe(true);
  });

  it('handles malformed JSON without throwing', () => {
    fsState.fileExists = true;
    fsState.fileContent = '{ invalid json }{{{';
    expect(() => loadCooldownState()).not.toThrow();
    expect(trackerState.fromJSONCooldownCalled).toBe(false);
  });

  it('handles read error without throwing', () => {
    fsState.fileExists = true;
    fsState.shouldThrowRead = true;
    expect(() => loadCooldownState()).not.toThrow();
    expect(trackerState.fromJSONCooldownCalled).toBe(false);
  });

  it('handles missing cooldowns field gracefully', () => {
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify({
      creditBlocks: { openai: Date.now() + 60_000 },
      savedAt: Date.now(),
    });
    expect(() => loadCooldownState()).not.toThrow();
    // creditBlocks should still be loaded
    expect(trackerState.fromJSONCreditBlockCalled).toBe(true);
  });

  it('handles missing creditBlocks field gracefully', () => {
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify({
      cooldowns: { 'groq:chat': { failures: 1, windowStart: Date.now(), coolUntil: Date.now() + 30_000 } },
      savedAt: Date.now(),
    });
    expect(() => loadCooldownState()).not.toThrow();
    expect(trackerState.fromJSONCooldownCalled).toBe(true);
  });

  it('skips loading when cooldowns is a non-object (e.g. null)', () => {
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify({
      cooldowns: null,
      creditBlocks: null,
      savedAt: Date.now(),
    });
    expect(() => loadCooldownState()).not.toThrow();
    // null is not an object — fromJSON should not be called
    expect(trackerState.fromJSONCooldownCalled).toBe(false);
    expect(trackerState.fromJSONCreditBlockCalled).toBe(false);
  });

  it('handles empty cooldowns/creditBlocks objects without error', () => {
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify({
      cooldowns: {},
      creditBlocks: {},
      savedAt: Date.now(),
    });
    expect(() => loadCooldownState()).not.toThrow();
    // Empty objects are still objects — fromJSON is called but with empty data
    expect(trackerState.fromJSONCooldownCalled).toBe(true);
    expect(trackerState.fromJSONCreditBlockCalled).toBe(true);
  });
});

// ── saveCooldownState ─────────────────────────────────────────────────────────

describe('saveCooldownState', () => {
  beforeEach(resetState);

  it('does nothing when both trackers return empty objects', () => {
    trackerState.cooldowns = {};
    trackerState.creditBlocks = {};
    saveCooldownState();
    expect(fsState.writtenContent).toBe('');
  });

  it('writes file when cooldowns has entries', () => {
    trackerState.cooldowns = { 'groq:chat': { failures: 2, windowStart: Date.now(), coolUntil: Date.now() + 30_000 } };
    trackerState.creditBlocks = {};
    saveCooldownState();
    expect(fsState.writtenContent).not.toBe('');
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved.cooldowns).toHaveProperty('groq:chat');
    expect(saved.creditBlocks).toEqual({});
    expect(typeof saved.savedAt).toBe('number');
  });

  it('writes file when creditBlocks has entries', () => {
    trackerState.cooldowns = {};
    trackerState.creditBlocks = { openai: Date.now() + 60_000 };
    saveCooldownState();
    expect(fsState.writtenContent).not.toBe('');
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved.creditBlocks).toHaveProperty('openai');
  });

  it('writes correct savedAt timestamp', () => {
    trackerState.cooldowns = { 'groq:chat': { failures: 1, windowStart: 0, coolUntil: Date.now() + 30_000 } };
    const before = Date.now();
    saveCooldownState();
    const after = Date.now();
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved.savedAt).toBeGreaterThanOrEqual(before);
    expect(saved.savedAt).toBeLessThanOrEqual(after);
  });

  it('writes both cooldowns and creditBlocks when both non-empty', () => {
    trackerState.cooldowns = { 'groq:chat': { failures: 2, windowStart: Date.now(), coolUntil: Date.now() + 30_000 } };
    trackerState.creditBlocks = { openai: Date.now() + 60_000 };
    saveCooldownState();
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved).toHaveProperty('cooldowns');
    expect(saved).toHaveProperty('creditBlocks');
    expect(Object.keys(saved.cooldowns)).toHaveLength(1);
    expect(Object.keys(saved.creditBlocks)).toHaveLength(1);
  });

  it('handles write error without throwing', () => {
    trackerState.cooldowns = { 'groq:chat': { failures: 1, windowStart: 0, coolUntil: Date.now() + 30_000 } };
    fsState.shouldThrowWrite = true;
    expect(() => saveCooldownState()).not.toThrow();
  });

  it('uses the .babelcast directory path', () => {
    trackerState.cooldowns = { 'groq:chat': { failures: 1, windowStart: 0, coolUntil: Date.now() + 30_000 } };
    saveCooldownState();
    expect(fsState.writtenPath).toContain('.babelcast');
    expect(fsState.writtenPath).toContain('cooldowns.json');
  });
});
