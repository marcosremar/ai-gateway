/**
 * Unit tests for server/labs-settings.ts.
 *
 * Covers: getLabsFlags (defaults), loadLabsSettings (missing file, valid JSON,
 * invalid JSON, boolean type coercion, numeric range clamping, partial fields),
 * setLabsFlags (partial updates, boolean guards, numeric clamping, updatedAt),
 * and saveLabsSettings (writes JSON, creates dir on first run, swallows errors).
 *
 * All fs/promises calls are mocked — no real disk I/O occurs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ────────────────────────────────────────────────────────

const { fsState } = vi.hoisted(() => {
  const fsState = {
    fileContent: null as string | null, // null = file does not exist
    dirExists: true,
    shouldThrowRead: false,
    shouldThrowWrite: false,
    writtenPath: '',
    writtenContent: '',
    mkdirCalled: false,
  };
  return { fsState };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (_path: string, _enc: string) => {
    if (fsState.shouldThrowRead) throw Object.assign(new Error('read error'), { code: 'EIO' });
    if (fsState.fileContent === null) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    return fsState.fileContent;
  }),
  writeFile: vi.fn(async (p: string, content: string) => {
    if (fsState.shouldThrowWrite) throw new Error('ENOSPC: no space left on device');
    fsState.writtenPath = p;
    fsState.writtenContent = content;
  }),
  mkdir: vi.fn(async () => {
    fsState.mkdirCalled = true;
  }),
  access: vi.fn(async (_p: string) => {
    if (!fsState.dirExists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // else resolve — directory exists
  }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  loadLabsSettings,
  saveLabsSettings,
  getLabsFlags,
  setLabsFlags,
  type LabsFlags,
} from '../server/labs-settings';

// ── Known defaults ────────────────────────────────────────────────────────────

const DEFAULTS: Omit<LabsFlags, 'updatedAt'> = {
  peakEwma: false,
  speculativeTranslation: false,
  streamingOverlap: false,
  ewmaDecayFactor: 0.3,
  speculationMinConfidence: 0.7,
  overlapMinTokens: 3,
  proactiveIdleStop: false,
  proactiveIdleThresholdPct: 75,
  proactiveIdleMinutes: 5,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetFsState() {
  Object.assign(fsState, {
    fileContent: null,
    dirExists: true,
    shouldThrowRead: false,
    shouldThrowWrite: false,
    writtenPath: '',
    writtenContent: '',
    mkdirCalled: false,
  });
  vi.clearAllMocks();
}

/** Reset module state to defaults by loading all DEFAULTS fields from a file. */
async function resetToDefaults() {
  // loadLabsSettings merges parsed content into _s, so loading all DEFAULTS
  // fields explicitly resets every value — empty {} would leave prior numeric
  // values unchanged since they'd fall through to the current _s.
  const prev = fsState.fileContent;
  const prevThrow = fsState.shouldThrowRead;
  fsState.shouldThrowRead = false;
  fsState.fileContent = JSON.stringify({ ...DEFAULTS, updatedAt: 0 });
  await loadLabsSettings();
  fsState.fileContent = prev;
  fsState.shouldThrowRead = prevThrow;
}

function withoutTimestamp(flags: Readonly<LabsFlags>): Omit<LabsFlags, 'updatedAt'> {
  const { updatedAt: _ts, ...rest } = flags;
  return rest;
}

// ── getLabsFlags ──────────────────────────────────────────────────────────────

describe('getLabsFlags', () => {
  beforeEach(resetFsState);

  it('returns all expected boolean and numeric fields', () => {
    const flags = getLabsFlags();
    expect(typeof flags.peakEwma).toBe('boolean');
    expect(typeof flags.speculativeTranslation).toBe('boolean');
    expect(typeof flags.streamingOverlap).toBe('boolean');
    expect(typeof flags.proactiveIdleStop).toBe('boolean');
    expect(typeof flags.ewmaDecayFactor).toBe('number');
    expect(typeof flags.speculationMinConfidence).toBe('number');
    expect(typeof flags.overlapMinTokens).toBe('number');
    expect(typeof flags.proactiveIdleThresholdPct).toBe('number');
    expect(typeof flags.proactiveIdleMinutes).toBe('number');
  });

  it('returned object is frozen (read-only)', () => {
    const flags = getLabsFlags();
    expect(Object.isFrozen(flags)).toBe(true);
  });
});

// ── loadLabsSettings ──────────────────────────────────────────────────────────

describe('loadLabsSettings', () => {
  beforeEach(async () => {
    resetFsState();
    await resetToDefaults();
  });

  it('keeps defaults when file does not exist', async () => {
    fsState.fileContent = null;
    await loadLabsSettings();
    expect(withoutTimestamp(getLabsFlags())).toEqual(DEFAULTS);
  });

  it('keeps defaults when readFile throws a generic error', async () => {
    fsState.shouldThrowRead = true;
    await loadLabsSettings();
    expect(withoutTimestamp(getLabsFlags())).toEqual(DEFAULTS);
  });

  it('keeps defaults when file contains invalid JSON', async () => {
    fsState.fileContent = '{broken: json}}}';
    await loadLabsSettings();
    expect(withoutTimestamp(getLabsFlags())).toEqual(DEFAULTS);
  });

  it('merges valid JSON fields over defaults', async () => {
    fsState.fileContent = JSON.stringify({ peakEwma: true, streamingOverlap: true });
    await loadLabsSettings();
    const flags = getLabsFlags();
    expect(flags.peakEwma).toBe(true);
    expect(flags.streamingOverlap).toBe(true);
    // unspecified fields remain at defaults
    expect(flags.speculativeTranslation).toBe(false);
    expect(flags.ewmaDecayFactor).toBe(0.3);
  });

  it('coerces non-boolean peakEwma to false', async () => {
    fsState.fileContent = JSON.stringify({ peakEwma: 'yes' });
    await loadLabsSettings();
    expect(getLabsFlags().peakEwma).toBe(false);
  });

  it('coerces non-boolean speculativeTranslation to false', async () => {
    fsState.fileContent = JSON.stringify({ speculativeTranslation: 1 });
    await loadLabsSettings();
    expect(getLabsFlags().speculativeTranslation).toBe(false);
  });

  it('coerces non-boolean streamingOverlap to false', async () => {
    fsState.fileContent = JSON.stringify({ streamingOverlap: null });
    await loadLabsSettings();
    expect(getLabsFlags().streamingOverlap).toBe(false);
  });

  it('coerces non-boolean proactiveIdleStop to false', async () => {
    fsState.fileContent = JSON.stringify({ proactiveIdleStop: 'true' });
    await loadLabsSettings();
    expect(getLabsFlags().proactiveIdleStop).toBe(false);
  });

  it('resets ewmaDecayFactor to default when out of range (> 1)', async () => {
    fsState.fileContent = JSON.stringify({ ewmaDecayFactor: 2.5 });
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.3);
  });

  it('resets ewmaDecayFactor to default when out of range (< 0)', async () => {
    fsState.fileContent = JSON.stringify({ ewmaDecayFactor: -0.1 });
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.3);
  });

  it('resets ewmaDecayFactor to default when not a number', async () => {
    fsState.fileContent = JSON.stringify({ ewmaDecayFactor: 'fast' });
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.3);
  });

  it('accepts ewmaDecayFactor at boundary values (0 and 1)', async () => {
    fsState.fileContent = JSON.stringify({ ewmaDecayFactor: 0 });
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(0);

    fsState.fileContent = JSON.stringify({ ewmaDecayFactor: 1 });
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(1);
  });

  it('resets speculationMinConfidence to default when out of range', async () => {
    fsState.fileContent = JSON.stringify({ speculationMinConfidence: 1.5 });
    await loadLabsSettings();
    expect(getLabsFlags().speculationMinConfidence).toBe(0.7);
  });

  it('resets overlapMinTokens to default when < 1', async () => {
    fsState.fileContent = JSON.stringify({ overlapMinTokens: 0 });
    await loadLabsSettings();
    expect(getLabsFlags().overlapMinTokens).toBe(3);
  });

  it('resets proactiveIdleThresholdPct to default when > 100', async () => {
    fsState.fileContent = JSON.stringify({ proactiveIdleThresholdPct: 150 });
    await loadLabsSettings();
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(75);
  });

  it('resets proactiveIdleMinutes to default when > 60', async () => {
    fsState.fileContent = JSON.stringify({ proactiveIdleMinutes: 999 });
    await loadLabsSettings();
    expect(getLabsFlags().proactiveIdleMinutes).toBe(5);
  });

  it('resets proactiveIdleMinutes to default when < 1', async () => {
    fsState.fileContent = JSON.stringify({ proactiveIdleMinutes: 0 });
    await loadLabsSettings();
    expect(getLabsFlags().proactiveIdleMinutes).toBe(5);
  });

  it('accepts valid numeric values within ranges', async () => {
    fsState.fileContent = JSON.stringify({
      ewmaDecayFactor: 0.5,
      speculationMinConfidence: 0.9,
      overlapMinTokens: 5,
      proactiveIdleThresholdPct: 80,
      proactiveIdleMinutes: 10,
    });
    await loadLabsSettings();
    const flags = getLabsFlags();
    expect(flags.ewmaDecayFactor).toBe(0.5);
    expect(flags.speculationMinConfidence).toBe(0.9);
    expect(flags.overlapMinTokens).toBe(5);
    expect(flags.proactiveIdleThresholdPct).toBe(80);
    expect(flags.proactiveIdleMinutes).toBe(10);
  });

  it('handles empty JSON object (all defaults)', async () => {
    fsState.fileContent = JSON.stringify({});
    await loadLabsSettings();
    expect(withoutTimestamp(getLabsFlags())).toEqual(DEFAULTS);
  });

  it('ignores unknown extra fields without error', async () => {
    fsState.fileContent = JSON.stringify({ unknownFlag: true, peakEwma: true });
    await expect(loadLabsSettings()).resolves.not.toThrow();
    expect(getLabsFlags().peakEwma).toBe(true);
  });

  it('does not throw on any input', async () => {
    for (const content of ['null', '"string"', '42', '[]']) {
      fsState.fileContent = content;
      await expect(loadLabsSettings()).resolves.not.toThrow();
    }
  });
});

// ── setLabsFlags ──────────────────────────────────────────────────────────────

describe('setLabsFlags', () => {
  beforeEach(async () => {
    resetFsState();
    await resetToDefaults();
  });

  it('returns the updated flags', async () => {
    const result = await setLabsFlags({ peakEwma: true });
    expect(result.peakEwma).toBe(true);
  });

  it('only updates fields explicitly provided', async () => {
    await setLabsFlags({ peakEwma: true });
    const flags = getLabsFlags();
    expect(flags.peakEwma).toBe(true);
    expect(flags.speculativeTranslation).toBe(false);
    expect(flags.streamingOverlap).toBe(false);
  });

  it('can toggle each boolean flag independently', async () => {
    await setLabsFlags({ peakEwma: true });
    await setLabsFlags({ speculativeTranslation: true });
    await setLabsFlags({ streamingOverlap: true });
    await setLabsFlags({ proactiveIdleStop: true });
    const flags = getLabsFlags();
    expect(flags.peakEwma).toBe(true);
    expect(flags.speculativeTranslation).toBe(true);
    expect(flags.streamingOverlap).toBe(true);
    expect(flags.proactiveIdleStop).toBe(true);
  });

  it('can set flags back to false', async () => {
    await setLabsFlags({ peakEwma: true });
    await setLabsFlags({ peakEwma: false });
    expect(getLabsFlags().peakEwma).toBe(false);
  });

  it('ignores non-boolean value for peakEwma', async () => {
    await setLabsFlags({ peakEwma: true });
    await setLabsFlags({ peakEwma: 'yes' as unknown as boolean });
    // string is not a boolean — should be ignored
    expect(getLabsFlags().peakEwma).toBe(true);
  });

  it('clamps ewmaDecayFactor to [0, 1]', async () => {
    await setLabsFlags({ ewmaDecayFactor: 1.5 });
    expect(getLabsFlags().ewmaDecayFactor).toBe(1);

    await setLabsFlags({ ewmaDecayFactor: -0.5 });
    expect(getLabsFlags().ewmaDecayFactor).toBe(0);
  });

  it('clamps speculationMinConfidence to [0, 1]', async () => {
    await setLabsFlags({ speculationMinConfidence: 2 });
    expect(getLabsFlags().speculationMinConfidence).toBe(1);

    await setLabsFlags({ speculationMinConfidence: -1 });
    expect(getLabsFlags().speculationMinConfidence).toBe(0);
  });

  it('clamps overlapMinTokens to [1, 10] and floors floats', async () => {
    await setLabsFlags({ overlapMinTokens: 0 });
    expect(getLabsFlags().overlapMinTokens).toBe(1);

    await setLabsFlags({ overlapMinTokens: 100 });
    expect(getLabsFlags().overlapMinTokens).toBe(10);

    await setLabsFlags({ overlapMinTokens: 3.9 });
    expect(getLabsFlags().overlapMinTokens).toBe(3);
  });

  it('clamps proactiveIdleThresholdPct to [1, 100] and floors floats', async () => {
    await setLabsFlags({ proactiveIdleThresholdPct: 0 });
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(1);

    await setLabsFlags({ proactiveIdleThresholdPct: 200 });
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(100);

    await setLabsFlags({ proactiveIdleThresholdPct: 50.7 });
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(50);
  });

  it('clamps proactiveIdleMinutes to [1, 60] and floors floats', async () => {
    await setLabsFlags({ proactiveIdleMinutes: 0 });
    expect(getLabsFlags().proactiveIdleMinutes).toBe(1);

    await setLabsFlags({ proactiveIdleMinutes: 61 });
    expect(getLabsFlags().proactiveIdleMinutes).toBe(60);

    await setLabsFlags({ proactiveIdleMinutes: 7.8 });
    expect(getLabsFlags().proactiveIdleMinutes).toBe(7);
  });

  it('sets updatedAt to a recent timestamp', async () => {
    const before = Date.now();
    await setLabsFlags({ peakEwma: true });
    const after = Date.now();
    const { updatedAt } = getLabsFlags();
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(after);
  });

  it('updates updatedAt on every call', async () => {
    await setLabsFlags({ peakEwma: false });
    const ts1 = getLabsFlags().updatedAt;
    await new Promise(r => setTimeout(r, 2));
    await setLabsFlags({ peakEwma: true });
    const ts2 = getLabsFlags().updatedAt;
    expect(ts2).toBeGreaterThanOrEqual(ts1);
  });

  it('accepts empty partial without error', async () => {
    await expect(setLabsFlags({})).resolves.not.toThrow();
  });

  it('returned object is frozen', async () => {
    const result = await setLabsFlags({ peakEwma: true });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ── saveLabsSettings ──────────────────────────────────────────────────────────

describe('saveLabsSettings', () => {
  beforeEach(async () => {
    resetFsState();
    await resetToDefaults();
  });

  it('writes current flags as JSON to the .babelcast path', async () => {
    await setLabsFlags({ peakEwma: true, ewmaDecayFactor: 0.5 });
    fsState.writtenPath = '';
    fsState.writtenContent = '';
    await saveLabsSettings();
    expect(fsState.writtenPath).toContain('.babelcast');
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved.peakEwma).toBe(true);
    expect(saved.ewmaDecayFactor).toBe(0.5);
  });

  it('creates parent directory when it does not exist', async () => {
    fsState.dirExists = false;
    await saveLabsSettings();
    expect(fsState.mkdirCalled).toBe(true);
  });

  it('skips mkdir when directory already exists', async () => {
    fsState.dirExists = true;
    await saveLabsSettings();
    expect(fsState.mkdirCalled).toBe(false);
  });

  it('does not throw when writeFile fails', async () => {
    fsState.shouldThrowWrite = true;
    await expect(saveLabsSettings()).resolves.not.toThrow();
  });

  it('written JSON is formatted (pretty-printed)', async () => {
    await saveLabsSettings();
    // JSON.stringify with indent 2 produces multi-line output
    expect(fsState.writtenContent).toContain('\n');
  });

  it('written JSON round-trips to the same flags', async () => {
    await setLabsFlags({ streamingOverlap: true, overlapMinTokens: 5 });
    await saveLabsSettings();
    const saved = JSON.parse(fsState.writtenContent) as LabsFlags;
    expect(saved.streamingOverlap).toBe(true);
    expect(saved.overlapMinTokens).toBe(5);
  });
});
