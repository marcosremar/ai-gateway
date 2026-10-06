/**
 * Unit tests for server/labs-settings.ts
 *
 * Covers: getLabsFlags (defaults, frozen), loadLabsSettings (missing file,
 * valid flags, boolean coercion, numeric range clamping), saveLabsSettings
 * (directory creation, JSON write), and setLabsFlags (boolean merge, numeric
 * clamping per field, updatedAt stamp, ignored non-matching types).
 *
 * fs/promises is mocked so no real disk I/O occurs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── fs/promises mock ──────────────────────────────────────────────────────────

let _fsStore: string | null = null;
let _dirExists = true;

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (_path: string) => {
    if (_fsStore === null) {
      const err: NodeJS.ErrnoException = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return _fsStore;
  }),
  writeFile: vi.fn(async (_path: string, data: string) => {
    _fsStore = data;
  }),
  mkdir: vi.fn(async () => { _dirExists = true; }),
  access: vi.fn(async () => {
    if (!_dirExists) {
      const err: NodeJS.ErrnoException = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
  }),
}));

// Re-import with fresh module state per test to reset the _s singleton.
// vi.mock above is hoisted and remains in effect after vi.resetModules().
async function freshModule() {
  vi.resetModules();
  return import('../../server/labs-settings');
}

beforeEach(() => {
  _fsStore = null;
  _dirExists = true;
});

// ── getLabsFlags — defaults ───────────────────────────────────────────────────

describe('getLabsFlags()', () => {
  it('returns default flags on first call', async () => {
    const { getLabsFlags } = await freshModule();
    const flags = getLabsFlags();
    expect(flags.peakEwma).toBe(false);
    expect(flags.speculativeTranslation).toBe(false);
    expect(flags.streamingOverlap).toBe(false);
    expect(flags.ewmaDecayFactor).toBe(0.3);
    expect(flags.speculationMinConfidence).toBe(0.7);
    expect(flags.overlapMinTokens).toBe(3);
    expect(flags.proactiveIdleStop).toBe(false);
    expect(flags.proactiveIdleThresholdPct).toBe(75);
    expect(flags.proactiveIdleMinutes).toBe(5);
  });

  it('returns a frozen (immutable) object', async () => {
    const { getLabsFlags } = await freshModule();
    const flags = getLabsFlags();
    expect(Object.isFrozen(flags)).toBe(true);
  });

  it('returns the same reference on repeated calls without mutation', async () => {
    const { getLabsFlags } = await freshModule();
    const a = getLabsFlags();
    const b = getLabsFlags();
    expect(a).toBe(b);
  });
});

// ── loadLabsSettings ──────────────────────────────────────────────────────────

describe('loadLabsSettings()', () => {
  it('keeps defaults when settings file does not exist', async () => {
    _fsStore = null;
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().peakEwma).toBe(false);
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.3);
  });

  it('loads valid boolean flags from file', async () => {
    _fsStore = JSON.stringify({ peakEwma: true, speculativeTranslation: true, streamingOverlap: true, proactiveIdleStop: true });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().peakEwma).toBe(true);
    expect(getLabsFlags().speculativeTranslation).toBe(true);
    expect(getLabsFlags().streamingOverlap).toBe(true);
    expect(getLabsFlags().proactiveIdleStop).toBe(true);
  });

  it('loads valid numeric tuning parameters from file', async () => {
    _fsStore = JSON.stringify({
      ewmaDecayFactor: 0.5,
      speculationMinConfidence: 0.8,
      overlapMinTokens: 5,
      proactiveIdleThresholdPct: 50,
      proactiveIdleMinutes: 10,
    });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.5);
    expect(getLabsFlags().speculationMinConfidence).toBe(0.8);
    expect(getLabsFlags().overlapMinTokens).toBe(5);
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(50);
    expect(getLabsFlags().proactiveIdleMinutes).toBe(10);
  });

  it('resets invalid boolean to false (non-boolean truthy value)', async () => {
    _fsStore = JSON.stringify({ peakEwma: 'yes', speculativeTranslation: 1 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().peakEwma).toBe(false);
    expect(getLabsFlags().speculativeTranslation).toBe(false);
  });

  it('resets ewmaDecayFactor below 0 to default 0.3', async () => {
    _fsStore = JSON.stringify({ ewmaDecayFactor: -0.1 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.3);
  });

  it('resets ewmaDecayFactor above 1 to default 0.3', async () => {
    _fsStore = JSON.stringify({ ewmaDecayFactor: 1.5 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.3);
  });

  it('resets speculationMinConfidence below 0 to default 0.7', async () => {
    _fsStore = JSON.stringify({ speculationMinConfidence: -1 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().speculationMinConfidence).toBe(0.7);
  });

  it('resets speculationMinConfidence above 1 to default 0.7', async () => {
    _fsStore = JSON.stringify({ speculationMinConfidence: 2 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().speculationMinConfidence).toBe(0.7);
  });

  it('resets overlapMinTokens below 1 to default 3', async () => {
    _fsStore = JSON.stringify({ overlapMinTokens: 0 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().overlapMinTokens).toBe(3);
  });

  it('resets overlapMinTokens that is NaN to default 3', async () => {
    _fsStore = JSON.stringify({ overlapMinTokens: 'hello' });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().overlapMinTokens).toBe(3);
  });

  it('resets proactiveIdleThresholdPct below 1 to default 75', async () => {
    _fsStore = JSON.stringify({ proactiveIdleThresholdPct: 0 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(75);
  });

  it('resets proactiveIdleThresholdPct above 100 to default 75', async () => {
    _fsStore = JSON.stringify({ proactiveIdleThresholdPct: 101 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(75);
  });

  it('resets proactiveIdleMinutes below 1 to default 5', async () => {
    _fsStore = JSON.stringify({ proactiveIdleMinutes: 0 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().proactiveIdleMinutes).toBe(5);
  });

  it('resets proactiveIdleMinutes above 60 to default 5', async () => {
    _fsStore = JSON.stringify({ proactiveIdleMinutes: 61 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().proactiveIdleMinutes).toBe(5);
  });

  it('merges partial file — unspecified keys keep defaults', async () => {
    _fsStore = JSON.stringify({ peakEwma: true });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().peakEwma).toBe(true);
    expect(getLabsFlags().speculativeTranslation).toBe(false);
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.3);
  });

  it('silently ignores malformed JSON', async () => {
    _fsStore = 'not-json{{{';
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().peakEwma).toBe(false);
  });

  it('accepts boundary value ewmaDecayFactor = 0', async () => {
    _fsStore = JSON.stringify({ ewmaDecayFactor: 0 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(0);
  });

  it('accepts boundary value ewmaDecayFactor = 1', async () => {
    _fsStore = JSON.stringify({ ewmaDecayFactor: 1 });
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().ewmaDecayFactor).toBe(1);
  });
});

// ── saveLabsSettings ──────────────────────────────────────────────────────────

describe('saveLabsSettings()', () => {
  it('writes current state as JSON to the file store', async () => {
    const { saveLabsSettings } = await freshModule();
    await saveLabsSettings();
    expect(_fsStore).not.toBeNull();
    const parsed = JSON.parse(_fsStore!);
    expect(parsed.peakEwma).toBe(false);
    expect(parsed.ewmaDecayFactor).toBe(0.3);
  });

  it('round-trips flags through save+load', async () => {
    const { setLabsFlags, saveLabsSettings } = await freshModule();
    await setLabsFlags({ peakEwma: true, ewmaDecayFactor: 0.8 });
    await saveLabsSettings();

    // Load into a new fresh module using the same _fsStore
    const { loadLabsSettings, getLabsFlags } = await freshModule();
    await loadLabsSettings();
    expect(getLabsFlags().peakEwma).toBe(true);
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.8);
  });

  it('creates the directory when it does not exist', async () => {
    _dirExists = false;
    const fsMock = await import('fs/promises');
    const mkdirSpy = vi.spyOn(fsMock, 'mkdir');
    const { saveLabsSettings } = await freshModule();
    await saveLabsSettings();
    expect(mkdirSpy).toHaveBeenCalled();
  });

  it('does not throw when directory creation fails silently', async () => {
    _dirExists = false;
    const fsMock = await import('fs/promises');
    vi.spyOn(fsMock, 'mkdir').mockRejectedValueOnce(new Error('EPERM'));
    const { saveLabsSettings } = await freshModule();
    await expect(saveLabsSettings()).resolves.not.toThrow();
  });
});

// ── setLabsFlags ──────────────────────────────────────────────────────────────

describe('setLabsFlags()', () => {
  it('sets peakEwma to true', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ peakEwma: true });
    expect(getLabsFlags().peakEwma).toBe(true);
  });

  it('sets speculativeTranslation to true', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ speculativeTranslation: true });
    expect(getLabsFlags().speculativeTranslation).toBe(true);
  });

  it('sets streamingOverlap to true', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ streamingOverlap: true });
    expect(getLabsFlags().streamingOverlap).toBe(true);
  });

  it('sets proactiveIdleStop to true', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ proactiveIdleStop: true });
    expect(getLabsFlags().proactiveIdleStop).toBe(true);
  });

  it('toggles a boolean flag back to false', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ peakEwma: true });
    await setLabsFlags({ peakEwma: false });
    expect(getLabsFlags().peakEwma).toBe(false);
  });

  it('clamps ewmaDecayFactor below 0 to 0', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ ewmaDecayFactor: -5 });
    expect(getLabsFlags().ewmaDecayFactor).toBe(0);
  });

  it('clamps ewmaDecayFactor above 1 to 1', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ ewmaDecayFactor: 99 });
    expect(getLabsFlags().ewmaDecayFactor).toBe(1);
  });

  it('accepts ewmaDecayFactor at boundary 0', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ ewmaDecayFactor: 0 });
    expect(getLabsFlags().ewmaDecayFactor).toBe(0);
  });

  it('accepts ewmaDecayFactor at boundary 1', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ ewmaDecayFactor: 1 });
    expect(getLabsFlags().ewmaDecayFactor).toBe(1);
  });

  it('clamps speculationMinConfidence below 0 to 0', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ speculationMinConfidence: -0.5 });
    expect(getLabsFlags().speculationMinConfidence).toBe(0);
  });

  it('clamps speculationMinConfidence above 1 to 1', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ speculationMinConfidence: 1.5 });
    expect(getLabsFlags().speculationMinConfidence).toBe(1);
  });

  it('clamps overlapMinTokens below 1 to 1', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ overlapMinTokens: 0 });
    expect(getLabsFlags().overlapMinTokens).toBe(1);
  });

  it('clamps overlapMinTokens above 10 to 10', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ overlapMinTokens: 100 });
    expect(getLabsFlags().overlapMinTokens).toBe(10);
  });

  it('floors overlapMinTokens to integer', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ overlapMinTokens: 3.9 });
    expect(getLabsFlags().overlapMinTokens).toBe(3);
  });

  it('clamps proactiveIdleThresholdPct below 1 to 1', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ proactiveIdleThresholdPct: 0 });
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(1);
  });

  it('clamps proactiveIdleThresholdPct above 100 to 100', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ proactiveIdleThresholdPct: 200 });
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(100);
  });

  it('floors proactiveIdleThresholdPct to integer', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ proactiveIdleThresholdPct: 50.7 });
    expect(getLabsFlags().proactiveIdleThresholdPct).toBe(50);
  });

  it('clamps proactiveIdleMinutes below 1 to 1', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ proactiveIdleMinutes: -3 });
    expect(getLabsFlags().proactiveIdleMinutes).toBe(1);
  });

  it('clamps proactiveIdleMinutes above 60 to 60', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ proactiveIdleMinutes: 120 });
    expect(getLabsFlags().proactiveIdleMinutes).toBe(60);
  });

  it('floors proactiveIdleMinutes to integer', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ proactiveIdleMinutes: 7.8 });
    expect(getLabsFlags().proactiveIdleMinutes).toBe(7);
  });

  it('ignores non-boolean value for boolean field', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    // @ts-expect-error — intentionally passing wrong type
    await setLabsFlags({ peakEwma: 'true' });
    expect(getLabsFlags().peakEwma).toBe(false);
  });

  it('ignores non-number value for numeric field', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    // @ts-expect-error — intentionally passing wrong type
    await setLabsFlags({ ewmaDecayFactor: 'high' });
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.3);
  });

  it('updates updatedAt timestamp', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    const before = Date.now();
    await setLabsFlags({ peakEwma: true });
    const after = Date.now();
    const ts = getLabsFlags().updatedAt;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('returns the updated flags object', async () => {
    const { setLabsFlags } = await freshModule();
    const result = await setLabsFlags({ peakEwma: true });
    expect(result.peakEwma).toBe(true);
  });

  it('returned object is frozen', async () => {
    const { setLabsFlags } = await freshModule();
    const result = await setLabsFlags({ peakEwma: true });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('partial update leaves other flags unchanged', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    await setLabsFlags({ peakEwma: true, ewmaDecayFactor: 0.9 });
    await setLabsFlags({ streamingOverlap: true });
    expect(getLabsFlags().peakEwma).toBe(true);
    expect(getLabsFlags().ewmaDecayFactor).toBe(0.9);
    expect(getLabsFlags().streamingOverlap).toBe(true);
  });

  it('empty partial update only bumps updatedAt', async () => {
    const { setLabsFlags, getLabsFlags } = await freshModule();
    const before = getLabsFlags();
    await setLabsFlags({});
    const after = getLabsFlags();
    expect(after.peakEwma).toBe(before.peakEwma);
    expect(after.ewmaDecayFactor).toBe(before.ewmaDecayFactor);
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
  });
});
