// ── Cooldown Persistence — unit suite ────────────────────────────────────────
// Tests loadCooldownState and saveCooldownState.
// Real filesystem I/O against a throwaway tmp dir — no production state touched.
// os.homedir() is mocked so COOLDOWNS_FILE resolves inside the temp tree.
// The tracker singletons are mocked to capture fromJSON/toJSON calls without
// touching the real in-memory cooldown/credit-block state.

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

// ── Tracker mock factories ───────────────────────────────────────────────────

const cooldownFromJSON = vi.fn();
const cooldownToJSON = vi.fn().mockReturnValue({});
const creditFromJSON = vi.fn();
const creditToJSON = vi.fn().mockReturnValue({});

vi.mock('../../src/providers/fallback', () => ({
  defaultCooldownTracker: {
    fromJSON: (...args: unknown[]) => cooldownFromJSON(...args),
    toJSON: () => cooldownToJSON(),
  },
}));

vi.mock('../../src/providers/credit-block', () => ({
  defaultCreditBlockTracker: {
    fromJSON: (...args: unknown[]) => creditFromJSON(...args),
    toJSON: () => creditToJSON(),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function cooldownsFile(home: string) {
  return join(home, '.babelcast', 'cooldowns.json');
}

function writeState(
  home: string,
  cooldowns: Record<string, unknown>,
  creditBlocks: Record<string, number>,
  savedAt: number,
) {
  const dir = join(home, '.babelcast');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    cooldownsFile(home),
    JSON.stringify({ cooldowns, creditBlocks, savedAt }),
    'utf-8',
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('cooldown-persistence', () => {
  let mod: typeof import('../../server/cooldown-persistence');

  beforeEach(async () => {
    // Fresh tmp home so the module-level COOLDOWNS_FILE resolves there.
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-gw-cp-'));
    vi.resetModules();
    // Reset mock state.
    cooldownFromJSON.mockReset();
    cooldownToJSON.mockReset().mockReturnValue({});
    creditFromJSON.mockReset();
    creditToJSON.mockReset().mockReturnValue({});
    mod = await import('../../server/cooldown-persistence');
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ── loadCooldownState ──────────────────────────────────────────────────────

  describe('loadCooldownState', () => {
    it('does nothing when the cooldowns file does not exist', () => {
      mod.loadCooldownState();
      expect(cooldownFromJSON).not.toHaveBeenCalled();
      expect(creditFromJSON).not.toHaveBeenCalled();
    });

    it('does nothing when savedAt is more than 10 minutes old', () => {
      const staleAt = Date.now() - 11 * 60_000; // 11 min ago
      writeState(tmpHome, { groq: { failures: 1, windowStart: 0, coolUntil: 999 } }, {}, staleAt);
      mod.loadCooldownState();
      expect(cooldownFromJSON).not.toHaveBeenCalled();
    });

    it('loads when savedAt is just under 10 minutes old', () => {
      const freshAt = Date.now() - 9 * 60_000; // 9 min ago
      const cooldowns = { groq: { failures: 1, windowStart: 0, coolUntil: 999 } };
      writeState(tmpHome, cooldowns, {}, freshAt);
      mod.loadCooldownState();
      expect(cooldownFromJSON).toHaveBeenCalledWith(cooldowns);
    });

    it('loads cooldowns and credit blocks together', () => {
      const cooldowns = { groq: { failures: 2, windowStart: 100, coolUntil: 9999 } };
      const creditBlocks: Record<string, number> = { openai: Date.now() + 3600_000 };
      writeState(tmpHome, cooldowns, creditBlocks, Date.now() - 1000);
      mod.loadCooldownState();
      expect(cooldownFromJSON).toHaveBeenCalledWith(cooldowns);
      expect(creditFromJSON).toHaveBeenCalledWith(creditBlocks);
    });

    it('skips fromJSON when cooldowns field is missing', () => {
      const dir = join(tmpHome, '.babelcast');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        cooldownsFile(tmpHome),
        JSON.stringify({ creditBlocks: {}, savedAt: Date.now() }),
        'utf-8',
      );
      mod.loadCooldownState();
      // cooldowns field is undefined, not a plain object — skipped
      expect(cooldownFromJSON).not.toHaveBeenCalled();
    });

    it('skips creditBlocks fromJSON when field is missing', () => {
      const dir = join(tmpHome, '.babelcast');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        cooldownsFile(tmpHome),
        JSON.stringify({ cooldowns: {}, savedAt: Date.now() }),
        'utf-8',
      );
      mod.loadCooldownState();
      expect(creditFromJSON).not.toHaveBeenCalled();
    });

    it('does not throw on corrupt JSON — swallows the error', () => {
      const dir = join(tmpHome, '.babelcast');
      mkdirSync(dir, { recursive: true });
      writeFileSync(cooldownsFile(tmpHome), 'NOT_VALID_JSON', 'utf-8');
      expect(() => mod.loadCooldownState()).not.toThrow();
      expect(cooldownFromJSON).not.toHaveBeenCalled();
    });

    it('does not throw when the file contains empty objects', () => {
      writeState(tmpHome, {}, {}, Date.now());
      expect(() => mod.loadCooldownState()).not.toThrow();
    });

    it('passes the exact cooldown map to fromJSON', () => {
      const cooldowns = {
        groq: { failures: 3, windowStart: 1000, coolUntil: 9000 },
        vast: { failures: 1, windowStart: 2000, coolUntil: 8000 },
      };
      writeState(tmpHome, cooldowns, {}, Date.now() - 30_000);
      mod.loadCooldownState();
      expect(cooldownFromJSON).toHaveBeenCalledTimes(1);
      expect(cooldownFromJSON.mock.calls[0][0]).toEqual(cooldowns);
    });

    it('passes the exact credit block map to fromJSON', () => {
      const creditBlocks: Record<string, number> = {
        openai: Date.now() + 3600_000,
        groq: Date.now() + 1800_000,
      };
      writeState(tmpHome, {}, creditBlocks, Date.now() - 30_000);
      mod.loadCooldownState();
      expect(creditFromJSON).toHaveBeenCalledWith(creditBlocks);
    });
  });

  // ── saveCooldownState ──────────────────────────────────────────────────────

  describe('saveCooldownState', () => {
    it('does not write when both trackers are empty', () => {
      cooldownToJSON.mockReturnValue({});
      creditToJSON.mockReturnValue({});
      mod.saveCooldownState();
      expect(existsSync(cooldownsFile(tmpHome))).toBe(false);
    });

    it('writes when cooldowns tracker has entries', () => {
      cooldownToJSON.mockReturnValue({ groq: { failures: 1, windowStart: 0, coolUntil: 9999 } });
      creditToJSON.mockReturnValue({});
      mod.saveCooldownState();
      expect(existsSync(cooldownsFile(tmpHome))).toBe(true);
    });

    it('writes when credit block tracker has entries', () => {
      cooldownToJSON.mockReturnValue({});
      creditToJSON.mockReturnValue({ openai: Date.now() + 3600_000 });
      mod.saveCooldownState();
      expect(existsSync(cooldownsFile(tmpHome))).toBe(true);
    });

    it('creates the .babelcast directory if it does not exist', () => {
      cooldownToJSON.mockReturnValue({ groq: { failures: 1, windowStart: 0, coolUntil: 9999 } });
      const dir = join(tmpHome, '.babelcast');
      expect(existsSync(dir)).toBe(false);
      mod.saveCooldownState();
      expect(existsSync(dir)).toBe(true);
    });

    it('writes valid JSON containing both cooldowns and creditBlocks', () => {
      const cooldowns = { groq: { failures: 2, windowStart: 100, coolUntil: 5000 } };
      const creditBlocks: Record<string, number> = { vast: Date.now() + 3600_000 };
      cooldownToJSON.mockReturnValue(cooldowns);
      creditToJSON.mockReturnValue(creditBlocks);
      mod.saveCooldownState();

      const raw = readFileSync(cooldownsFile(tmpHome), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.cooldowns).toEqual(cooldowns);
      expect(parsed.creditBlocks).toEqual(creditBlocks);
      expect(typeof parsed.savedAt).toBe('number');
    });

    it('savedAt is close to now', () => {
      cooldownToJSON.mockReturnValue({ groq: { failures: 1, windowStart: 0, coolUntil: 1 } });
      creditToJSON.mockReturnValue({});
      const before = Date.now();
      mod.saveCooldownState();
      const after = Date.now();
      const raw = JSON.parse(readFileSync(cooldownsFile(tmpHome), 'utf-8'));
      expect(raw.savedAt).toBeGreaterThanOrEqual(before);
      expect(raw.savedAt).toBeLessThanOrEqual(after);
    });

    it('does not throw when the directory cannot be created', () => {
      // Point homedir to a path where we can write but a nested segment is a file
      // so mkdir fails. Use a file-as-dir scenario.
      const blockerPath = join(tmpHome, '.babelcast');
      writeFileSync(blockerPath, 'I am a file, not a directory');
      cooldownToJSON.mockReturnValue({ groq: { failures: 1, windowStart: 0, coolUntil: 9 } });
      expect(() => mod.saveCooldownState()).not.toThrow();
    });

    it('saves combined entry count (cooldowns + credit blocks)', () => {
      cooldownToJSON.mockReturnValue({
        groq: { failures: 1, windowStart: 0, coolUntil: 9 },
        openai: { failures: 2, windowStart: 0, coolUntil: 9 },
      });
      creditToJSON.mockReturnValue({ vast: Date.now() + 100 });
      mod.saveCooldownState();
      const parsed = JSON.parse(readFileSync(cooldownsFile(tmpHome), 'utf-8'));
      expect(Object.keys(parsed.cooldowns).length).toBe(2);
      expect(Object.keys(parsed.creditBlocks).length).toBe(1);
    });

    it('overwrites an existing file on repeated save', () => {
      cooldownToJSON
        .mockReturnValueOnce({ groq: { failures: 1, windowStart: 0, coolUntil: 1 } })
        .mockReturnValueOnce({ openai: { failures: 3, windowStart: 0, coolUntil: 2 } });
      creditToJSON.mockReturnValue({});

      mod.saveCooldownState();
      mod.saveCooldownState();

      const parsed = JSON.parse(readFileSync(cooldownsFile(tmpHome), 'utf-8'));
      expect(Object.keys(parsed.cooldowns)).toContain('openai');
      expect(Object.keys(parsed.cooldowns)).not.toContain('groq');
    });
  });

  // ── round-trip ─────────────────────────────────────────────────────────────

  describe('round-trip: save → load', () => {
    it('data saved is exactly what gets passed back to fromJSON', async () => {
      const cooldowns = {
        groq: { failures: 3, windowStart: 1_000_000, coolUntil: 2_000_000 },
        vast: { failures: 1, windowStart: 1_100_000, coolUntil: 1_900_000 },
      };
      const creditBlocks: Record<string, number> = { openai: Date.now() + 86400_000 };

      cooldownToJSON.mockReturnValue(cooldowns);
      creditToJSON.mockReturnValue(creditBlocks);

      mod.saveCooldownState();

      // Re-import to reset module-level mutable state and re-read the file.
      vi.resetModules();
      mod = await import('../../server/cooldown-persistence');

      mod.loadCooldownState();

      expect(cooldownFromJSON).toHaveBeenCalledWith(cooldowns);
      expect(creditFromJSON).toHaveBeenCalledWith(creditBlocks);
    });
  });
});
