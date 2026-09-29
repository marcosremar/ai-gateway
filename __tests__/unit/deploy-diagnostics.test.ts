// ── Deploy Diagnostics — unit suite ──────────────────────────────────────────
// Validates persistDeployDiagnostics, listDeployDiagnostics, getDeployDiagnostics.
// Real filesystem I/O against a throwaway tmp dir — no production state touched.
// os.homedir() is mocked so DEPLOYS_DIR resolves inside the temp tree.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Redirect ~/.babelcast to a safe tmp directory ──────────────────────────────

let tmpHome: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ── Import under test (after mocks, uses dynamic import so tmpHome is set) ────

import type {
  DeployDiagnosticsInput,
  DeployDiagnosticsRecord,
  DeployDiagnosticsSummary,
} from '../../server/deploy-diagnostics';

// ── Helpers ───────────────────────────────────────────────────────────────────

function minimalInput(overrides: Partial<DeployDiagnosticsInput> = {}): DeployDiagnosticsInput {
  return {
    instanceId: 'inst-aabbccdd1234',
    provider: 'runpod',
    endpoint: 'http://10.0.0.1:8000',
    result: 'timeout',
    startedAt: Date.now() - 60_000,
    ...overrides,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('deploy-diagnostics', () => {
  let deploysDir: string;
  let mod: typeof import('../../server/deploy-diagnostics');

  beforeEach(async () => {
    // Each test gets a fresh temp home so module-level DEPLOYS_DIR points there.
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-gw-ddx-'));
    deploysDir = join(tmpHome, '.babelcast', 'deploys');
    // Re-import to pick up the new tmpHome (vi.resetModules clears the cache).
    vi.resetModules();
    mod = await import('../../server/deploy-diagnostics');
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ── persistDeployDiagnostics ───────────────────────────────────────────────

  describe('persistDeployDiagnostics', () => {
    it('returns a non-empty string id', async () => {
      const id = await mod.persistDeployDiagnostics(minimalInput());
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('creates the deploys directory when it does not exist', async () => {
      expect(existsSync(deploysDir)).toBe(false);
      await mod.persistDeployDiagnostics(minimalInput());
      expect(existsSync(deploysDir)).toBe(true);
    });

    it('writes a valid JSON file inside deploysDir', async () => {
      const id = await mod.persistDeployDiagnostics(minimalInput());
      const files = readdirSync(deploysDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(`${id}.json`);
    });

    it('persisted record contains schemaVersion:1', async () => {
      const id = await mod.persistDeployDiagnostics(minimalInput());
      const raw = JSON.parse(
        require('fs').readFileSync(join(deploysDir, `${id}.json`), 'utf-8'),
      ) as DeployDiagnosticsRecord;
      expect(raw.schemaVersion).toBe(1);
    });

    it('persisted record contains all input fields', async () => {
      const input = minimalInput({ result: 'exited', provider: 'vast', dockerImage: 'img:latest' });
      const id = await mod.persistDeployDiagnostics(input);
      const raw = JSON.parse(
        require('fs').readFileSync(join(deploysDir, `${id}.json`), 'utf-8'),
      ) as DeployDiagnosticsRecord;
      expect(raw.provider).toBe('vast');
      expect(raw.result).toBe('exited');
      expect(raw.dockerImage).toBe('img:latest');
      expect(raw.endpoint).toBe(input.endpoint);
      expect(raw.instanceId).toBe(input.instanceId);
    });

    it('id encodes the provider name', async () => {
      const id = await mod.persistDeployDiagnostics(minimalInput({ provider: 'tensordock' }));
      expect(id).toContain('tensordock');
    });

    it('id encodes a prefix of the instanceId', async () => {
      const id = await mod.persistDeployDiagnostics(minimalInput({ instanceId: 'abc123xyz789' }));
      expect(id).toContain('abc123xyz789'.slice(0, 12));
    });

    it('savedAt is close to now', async () => {
      const before = Date.now();
      const id = await mod.persistDeployDiagnostics(minimalInput());
      const after = Date.now();
      const raw = JSON.parse(
        require('fs').readFileSync(join(deploysDir, `${id}.json`), 'utf-8'),
      ) as DeployDiagnosticsRecord;
      expect(raw.savedAt).toBeGreaterThanOrEqual(before);
      expect(raw.savedAt).toBeLessThanOrEqual(after);
    });

    it('durationMs reflects elapsed time since startedAt', async () => {
      const startedAt = Date.now() - 5_000;
      const id = await mod.persistDeployDiagnostics(minimalInput({ startedAt }));
      const raw = JSON.parse(
        require('fs').readFileSync(join(deploysDir, `${id}.json`), 'utf-8'),
      ) as DeployDiagnosticsRecord;
      expect(raw.durationMs).toBeGreaterThanOrEqual(5_000);
      expect(raw.durationMs).toBeLessThan(30_000);
    });

    it('includes appError when provided', async () => {
      const appError = { message: 'OOM', traceback: 'RuntimeError: OOM\n  at ...' };
      const id = await mod.persistDeployDiagnostics(minimalInput({ appError }));
      const raw = JSON.parse(
        require('fs').readFileSync(join(deploysDir, `${id}.json`), 'utf-8'),
      ) as DeployDiagnosticsRecord;
      expect(raw.appError?.message).toBe('OOM');
      expect(raw.appError?.traceback).toContain('RuntimeError');
    });

    it('two successive calls produce two distinct files', async () => {
      await mod.persistDeployDiagnostics(minimalInput({ provider: 'runpod' }));
      await mod.persistDeployDiagnostics(minimalInput({ provider: 'vast' }));
      const files = readdirSync(deploysDir);
      expect(files).toHaveLength(2);
      expect(new Set(files).size).toBe(2);
    });

    it('empty instanceId yields "unknown" in the id', async () => {
      const id = await mod.persistDeployDiagnostics(minimalInput({ instanceId: '' }));
      expect(id).toContain('unknown');
    });
  });

  // ── listDeployDiagnostics ─────────────────────────────────────────────────

  describe('listDeployDiagnostics', () => {
    it('returns empty array when deploys dir does not exist', () => {
      const result = mod.listDeployDiagnostics();
      expect(result).toEqual([]);
    });

    it('returns empty array when deploys dir is empty', () => {
      mkdirSync(deploysDir, { recursive: true });
      const result = mod.listDeployDiagnostics();
      expect(result).toEqual([]);
    });

    it('returns one summary after one persist', async () => {
      await mod.persistDeployDiagnostics(minimalInput());
      const summaries = mod.listDeployDiagnostics();
      expect(summaries).toHaveLength(1);
    });

    it('summary includes expected fields', async () => {
      const input = minimalInput({ provider: 'modal', result: 'ready' });
      await mod.persistDeployDiagnostics(input);
      const [s] = mod.listDeployDiagnostics();
      expect(s.provider).toBe('modal');
      expect(s.result).toBe('ready');
      expect(s.instanceId).toBe(input.instanceId);
      expect(typeof s.id).toBe('string');
      expect(typeof s.savedAt).toBe('number');
      expect(typeof s.durationMs).toBe('number');
    });

    it('includes appErrorMessage when record has appError', async () => {
      await mod.persistDeployDiagnostics(
        minimalInput({ appError: { message: 'CUDA OOM' } }),
      );
      const [s] = mod.listDeployDiagnostics();
      expect(s.appErrorMessage).toBe('CUDA OOM');
    });

    it('returns newest file first (sorted by mtime desc)', async () => {
      mkdirSync(deploysDir, { recursive: true });
      // Write two files with distinct mtimes (touch them explicitly).
      const oldId = 'old_runpod_aaaaaaaaaaaa';
      const newId = 'new_vast_bbbbbbbbbbbb';
      const oldPath = join(deploysDir, `${oldId}.json`);
      const newPath = join(deploysDir, `${newId}.json`);
      const makeRecord = (id: string): DeployDiagnosticsRecord => ({
        id,
        instanceId: id,
        provider: 'runpod',
        endpoint: 'http://x',
        result: 'timeout',
        startedAt: Date.now() - 1000,
        savedAt: Date.now(),
        durationMs: 1000,
        schemaVersion: 1,
      });
      writeFileSync(oldPath, JSON.stringify(makeRecord(oldId)), 'utf-8');
      const base = new Date('2024-01-01T00:00:00Z');
      utimesSync(oldPath, base, base);
      writeFileSync(newPath, JSON.stringify(makeRecord(newId)), 'utf-8');
      const newer = new Date('2024-01-02T00:00:00Z');
      utimesSync(newPath, newer, newer);

      const summaries = mod.listDeployDiagnostics();
      expect(summaries[0].id).toBe(newId);
      expect(summaries[1].id).toBe(oldId);
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await mod.persistDeployDiagnostics(minimalInput({ instanceId: `inst-${i}xxxxxxxx` }));
        // Tiny delay to ensure distinct IDs
        await new Promise((r) => setTimeout(r, 2));
      }
      const all = mod.listDeployDiagnostics();
      const limited = mod.listDeployDiagnostics(2);
      expect(all).toHaveLength(5);
      expect(limited).toHaveLength(2);
    });

    it('default limit returns up to 100 records', async () => {
      mkdirSync(deploysDir, { recursive: true });
      for (let i = 0; i < 5; i++) {
        const id = `rec-runpod-${String(i).padStart(12, '0')}`;
        const record: DeployDiagnosticsRecord = {
          id, instanceId: id, provider: 'runpod', endpoint: 'http://x',
          result: 'exited', startedAt: 0, savedAt: Date.now(),
          durationMs: 1, schemaVersion: 1,
        };
        writeFileSync(join(deploysDir, `${id}.json`), JSON.stringify(record), 'utf-8');
      }
      const result = mod.listDeployDiagnostics(); // default 100
      expect(result.length).toBe(5);
    });

    it('skips corrupt JSON files without throwing', async () => {
      mkdirSync(deploysDir, { recursive: true });
      writeFileSync(join(deploysDir, 'bad.json'), 'NOT_JSON', 'utf-8');
      // Also persist a valid record.
      await mod.persistDeployDiagnostics(minimalInput());
      const summaries = mod.listDeployDiagnostics();
      // Only the valid file should appear.
      expect(summaries.length).toBe(1);
    });
  });

  // ── getDeployDiagnostics ──────────────────────────────────────────────────

  describe('getDeployDiagnostics', () => {
    it('returns null when the file does not exist', () => {
      expect(mod.getDeployDiagnostics('no-such-id')).toBeNull();
    });

    it('returns the full record for a known id', async () => {
      const input = minimalInput({ result: 'crashed', provider: 'vast' });
      const id = await mod.persistDeployDiagnostics(input);
      const record = mod.getDeployDiagnostics(id);
      expect(record).not.toBeNull();
      expect(record!.id).toBe(id);
      expect(record!.result).toBe('crashed');
      expect(record!.provider).toBe('vast');
      expect(record!.schemaVersion).toBe(1);
    });

    it('rejects ids with path-traversal characters (returns null)', () => {
      // IDs with slashes, dots-only, or null bytes should be blocked.
      expect(mod.getDeployDiagnostics('../etc/passwd')).toBeNull();
      expect(mod.getDeployDiagnostics('../../secrets')).toBeNull();
      expect(mod.getDeployDiagnostics('/absolute/path')).toBeNull();
    });

    it('accepts ids containing dots and dashes (safe chars)', async () => {
      const id = await mod.persistDeployDiagnostics(minimalInput());
      // IDs contain colons which are replaced with dashes, plus underscores
      // and alphanumerics — all safe.
      expect(/^[A-Za-z0-9_.-]+$/.test(id)).toBe(true);
      expect(mod.getDeployDiagnostics(id)).not.toBeNull();
    });

    it('returns null for a corrupt JSON file', () => {
      mkdirSync(deploysDir, { recursive: true });
      const id = 'valid-id-0000000000';
      writeFileSync(join(deploysDir, `${id}.json`), '{corrupt', 'utf-8');
      expect(mod.getDeployDiagnostics(id)).toBeNull();
    });

    it('round-trip: persisted record matches retrieved record', async () => {
      const input = minimalInput({
        provider: 'tensordock',
        result: 'app_error',
        sshHost: '1.2.3.4',
        sshPort: 22,
        remoteLogs: 'log line 1\nlog line 2',
        appError: { message: 'exit code 1', traceback: 'at main.py:10' },
      });
      const id = await mod.persistDeployDiagnostics(input);
      const record = mod.getDeployDiagnostics(id)!;
      expect(record.provider).toBe('tensordock');
      expect(record.sshHost).toBe('1.2.3.4');
      expect(record.sshPort).toBe(22);
      expect(record.remoteLogs).toBe('log line 1\nlog line 2');
      expect(record.appError?.message).toBe('exit code 1');
      expect(record.appError?.traceback).toBe('at main.py:10');
    });
  });
});
