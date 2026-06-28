// ── Deploy Diagnostics Persistence — unit suite ───────────────────────────
// Tests persistDeployDiagnostics, listDeployDiagnostics, and getDeployDiagnostics.
// All filesystem I/O is redirected to a throwaway temp directory via process.env.HOME.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('deploy-diagnostics', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  function deploysDir(): string {
    return join(tmpHome, '.babelcast', 'deploys');
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-gateway-deploy-diag-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
  });

  async function load() {
    return import('../server/deploy-diagnostics');
  }

  // ── Minimal valid input fixture ──────────────────────────────────────────

  function minimalInput() {
    return {
      instanceId: 'pod-abc123456789',
      provider: 'runpod',
      endpoint: 'https://pod-abc.runpod.io:8000',
      result: 'timeout' as const,
      startedAt: Date.now() - 30_000,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // persistDeployDiagnostics
  // ════════════════════════════════════════════════════════════════════════

  describe('persistDeployDiagnostics', () => {
    it('returns a non-empty string ID', async () => {
      const { persistDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics(minimalInput());
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('creates the deploys directory if it does not exist', async () => {
      const { persistDeployDiagnostics } = await load();
      expect(existsSync(deploysDir())).toBe(false);
      await persistDeployDiagnostics(minimalInput());
      expect(existsSync(deploysDir())).toBe(true);
    });

    it('writes a JSON file whose name equals the returned ID', async () => {
      const { persistDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics(minimalInput());
      const file = join(deploysDir(), `${id}.json`);
      expect(existsSync(file)).toBe(true);
    });

    it('persisted record carries schemaVersion: 1', async () => {
      const { persistDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics(minimalInput());
      const raw = readFileSync(join(deploysDir(), `${id}.json`), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.schemaVersion).toBe(1);
    });

    it('record id matches returned id', async () => {
      const { persistDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics(minimalInput());
      const raw = readFileSync(join(deploysDir(), `${id}.json`), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.id).toBe(id);
    });

    it('durationMs is non-negative and roughly equals elapsed time', async () => {
      const { persistDeployDiagnostics } = await load();
      const startedAt = Date.now() - 5_000;
      const id = await persistDeployDiagnostics({ ...minimalInput(), startedAt });
      const raw = readFileSync(join(deploysDir(), `${id}.json`), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.durationMs).toBeGreaterThanOrEqual(4_000);
      expect(record.durationMs).toBeLessThan(10_000);
    });

    it('savedAt is a recent epoch ms timestamp', async () => {
      const before = Date.now();
      const { persistDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics(minimalInput());
      const after = Date.now();
      const raw = readFileSync(join(deploysDir(), `${id}.json`), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.savedAt).toBeGreaterThanOrEqual(before);
      expect(record.savedAt).toBeLessThanOrEqual(after);
    });

    it('preserves all minimal input fields verbatim', async () => {
      const { persistDeployDiagnostics } = await load();
      const input = minimalInput();
      const id = await persistDeployDiagnostics(input);
      const raw = readFileSync(join(deploysDir(), `${id}.json`), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.instanceId).toBe(input.instanceId);
      expect(record.provider).toBe(input.provider);
      expect(record.endpoint).toBe(input.endpoint);
      expect(record.result).toBe(input.result);
    });

    it('includes provider in the returned ID', async () => {
      const { persistDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics({ ...minimalInput(), provider: 'vast' });
      expect(id).toContain('vast');
    });

    it('includes first 12 chars of instanceId in the returned ID', async () => {
      const { persistDeployDiagnostics } = await load();
      const instanceId = 'pod-LONGID9876abcxyz';
      const id = await persistDeployDiagnostics({ ...minimalInput(), instanceId });
      expect(id).toContain(instanceId.slice(0, 12));
    });

    it('uses "unknown" in ID when instanceId is empty string', async () => {
      const { persistDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics({ ...minimalInput(), instanceId: '' });
      expect(id).toContain('unknown');
    });

    it('persists optional dockerImage field', async () => {
      const { persistDeployDiagnostics } = await load();
      const dockerImage = 'ghcr.io/org/image:latest';
      const id = await persistDeployDiagnostics({ ...minimalInput(), dockerImage });
      const raw = readFileSync(join(deploysDir(), `${id}.json`), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.dockerImage).toBe(dockerImage);
    });

    it('persists optional sshHost and sshPort fields', async () => {
      const { persistDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics({
        ...minimalInput(),
        sshHost: '1.2.3.4',
        sshPort: 22022,
      });
      const raw = readFileSync(join(deploysDir(), `${id}.json`), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.sshHost).toBe('1.2.3.4');
      expect(record.sshPort).toBe(22022);
    });

    it('persists appError.message and appError.traceback', async () => {
      const { persistDeployDiagnostics } = await load();
      const appError = { message: 'OOM', traceback: 'Traceback (most recent call last):\n  ...' };
      const id = await persistDeployDiagnostics({ ...minimalInput(), appError });
      const raw = readFileSync(join(deploysDir(), `${id}.json`), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.appError.message).toBe('OOM');
      expect(record.appError.traceback).toContain('Traceback');
    });

    it('persists remoteLogs field', async () => {
      const { persistDeployDiagnostics } = await load();
      const remoteLogs = 'kernel: Out of memory: Kill process 1234';
      const id = await persistDeployDiagnostics({ ...minimalInput(), remoteLogs });
      const raw = readFileSync(join(deploysDir(), `${id}.json`), 'utf-8');
      const record = JSON.parse(raw);
      expect(record.remoteLogs).toBe(remoteLogs);
    });

    it('persists all result codes without error', async () => {
      const { persistDeployDiagnostics } = await load();
      const results: Array<'ready' | 'exited' | 'timeout' | 'cancelled' | 'crashed' | 'app_error'> = [
        'ready', 'exited', 'timeout', 'cancelled', 'crashed', 'app_error',
      ];
      for (const result of results) {
        const id = await persistDeployDiagnostics({ ...minimalInput(), result });
        expect(id.length).toBeGreaterThan(0);
      }
    });

    it('creates separate files for multiple calls', async () => {
      const { persistDeployDiagnostics } = await load();
      const id1 = await persistDeployDiagnostics({ ...minimalInput(), provider: 'runpod' });
      await new Promise(r => setTimeout(r, 10)); // ensure distinct timestamps
      const id2 = await persistDeployDiagnostics({ ...minimalInput(), provider: 'vast' });
      expect(id1).not.toBe(id2);
      expect(existsSync(join(deploysDir(), `${id1}.json`))).toBe(true);
      expect(existsSync(join(deploysDir(), `${id2}.json`))).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // listDeployDiagnostics
  // ════════════════════════════════════════════════════════════════════════

  describe('listDeployDiagnostics', () => {
    it('returns empty array when no files exist', async () => {
      const { listDeployDiagnostics } = await load();
      const result = listDeployDiagnostics();
      expect(result).toEqual([]);
    });

    it('returns one summary for one persisted record', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics } = await load();
      await persistDeployDiagnostics(minimalInput());
      const list = listDeployDiagnostics();
      expect(list).toHaveLength(1);
    });

    it('summary includes required fields', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics } = await load();
      const input = {
        ...minimalInput(),
        dockerImage: 'org/image:1.0',
        appError: { message: 'CUDA OOM' },
      };
      const id = await persistDeployDiagnostics(input);
      const list = listDeployDiagnostics();
      const summary = list[0];
      expect(summary.id).toBe(id);
      expect(summary.instanceId).toBe(input.instanceId);
      expect(summary.provider).toBe(input.provider);
      expect(summary.result).toBe(input.result);
      expect(summary.dockerImage).toBe(input.dockerImage);
      expect(summary.appErrorMessage).toBe('CUDA OOM');
      expect(typeof summary.savedAt).toBe('number');
      expect(typeof summary.durationMs).toBe('number');
    });

    it('appErrorMessage is undefined when no appError set', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics } = await load();
      await persistDeployDiagnostics(minimalInput());
      const list = listDeployDiagnostics();
      expect(list[0].appErrorMessage).toBeUndefined();
    });

    it('dockerImage is undefined in summary when not set', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics } = await load();
      await persistDeployDiagnostics(minimalInput()); // no dockerImage
      const list = listDeployDiagnostics();
      expect(list[0].dockerImage).toBeUndefined();
    });

    it('returns newest-first when multiple records exist', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics } = await load();
      const id1 = await persistDeployDiagnostics({ ...minimalInput(), provider: 'runpod' });
      await new Promise(r => setTimeout(r, 20));
      const id2 = await persistDeployDiagnostics({ ...minimalInput(), provider: 'vast' });
      const list = listDeployDiagnostics();
      // Newest (id2) should come first, sorted by mtime desc
      expect(list[0].id).toBe(id2);
      expect(list[1].id).toBe(id1);
    });

    it('respects limit — returns at most N records', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics } = await load();
      for (let i = 0; i < 5; i++) {
        await persistDeployDiagnostics({ ...minimalInput(), instanceId: `pod-${i}000000000` });
      }
      const list = listDeployDiagnostics(3);
      expect(list).toHaveLength(3);
    });

    it('default limit of 100 — returns all when fewer records', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics } = await load();
      for (let i = 0; i < 7; i++) {
        await persistDeployDiagnostics({ ...minimalInput(), instanceId: `pod-${i}000000000` });
      }
      const list = listDeployDiagnostics();
      expect(list).toHaveLength(7);
    });

    it('skips corrupt (non-JSON) files silently', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics(minimalInput());
      // Overwrite file with garbage
      writeFileSync(join(deploysDir(), `${id}.json`), 'NOT JSON }{', 'utf-8');
      // Should return empty — no crash
      const list = listDeployDiagnostics();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBe(0);
    });

    it('skips non-.json files in the directory', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics } = await load();
      await persistDeployDiagnostics(minimalInput());
      // Put a non-JSON file in the deploys dir
      writeFileSync(join(deploysDir(), 'README.txt'), 'ignore me', 'utf-8');
      const list = listDeployDiagnostics();
      // Should still only return one record
      expect(list).toHaveLength(1);
    });

    it('returns empty array when directory does not exist (no prior deploys)', async () => {
      // Don't persist anything — directory won't exist yet
      const { listDeployDiagnostics } = await load();
      const list = listDeployDiagnostics();
      // Should create dir (via ensureDir) and return []
      expect(list).toEqual([]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // getDeployDiagnostics
  // ════════════════════════════════════════════════════════════════════════

  describe('getDeployDiagnostics', () => {
    it('returns null for an ID that does not exist', async () => {
      const { getDeployDiagnostics } = await load();
      const result = getDeployDiagnostics('nonexistent-id-12345');
      expect(result).toBeNull();
    });

    it('returns full record for a valid persisted ID', async () => {
      const { persistDeployDiagnostics, getDeployDiagnostics } = await load();
      const input = {
        ...minimalInput(),
        dockerImage: 'org/img:v2',
        appError: { message: 'SIGKILL', traceback: 'stack' },
        remoteLogs: 'dmesg output',
      };
      const id = await persistDeployDiagnostics(input);
      const record = getDeployDiagnostics(id);
      expect(record).not.toBeNull();
      expect(record!.id).toBe(id);
      expect(record!.instanceId).toBe(input.instanceId);
      expect(record!.provider).toBe(input.provider);
      expect(record!.dockerImage).toBe('org/img:v2');
      expect(record!.appError?.message).toBe('SIGKILL');
      expect(record!.remoteLogs).toBe('dmesg output');
      expect(record!.schemaVersion).toBe(1);
    });

    it('returns null for path traversal attempt with ../', async () => {
      const { getDeployDiagnostics } = await load();
      expect(getDeployDiagnostics('../../../etc/passwd')).toBeNull();
    });

    it('returns null for ID containing slash', async () => {
      const { getDeployDiagnostics } = await load();
      expect(getDeployDiagnostics('some/path/id')).toBeNull();
    });

    it('returns null for ID containing null byte', async () => {
      const { getDeployDiagnostics } = await load();
      expect(getDeployDiagnostics('id\x00evil')).toBeNull();
    });

    it('returns null for empty string ID', async () => {
      // Empty string: regex ^[A-Za-z0-9_.-]+$ requires at least one char
      const { getDeployDiagnostics } = await load();
      expect(getDeployDiagnostics('')).toBeNull();
    });

    it('returns null for ID with space character', async () => {
      const { getDeployDiagnostics } = await load();
      expect(getDeployDiagnostics('id with spaces')).toBeNull();
    });

    it('returns null for corrupt (unparseable) file', async () => {
      const { persistDeployDiagnostics, getDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics(minimalInput());
      writeFileSync(join(deploysDir(), `${id}.json`), '{broken json', 'utf-8');
      expect(getDeployDiagnostics(id)).toBeNull();
    });

    it('allows IDs with dots and underscores (the generated format)', async () => {
      const { persistDeployDiagnostics, getDeployDiagnostics } = await load();
      // Generated IDs look like: 2026-06-28T12-34-56-789Z_runpod_pod-abc123
      const id = await persistDeployDiagnostics(minimalInput());
      // Verify the id passes the path-traversal guard (dots/underscores OK)
      const record = getDeployDiagnostics(id);
      expect(record).not.toBeNull();
    });

    it('returns null for ID with shell metacharacters', async () => {
      const { getDeployDiagnostics } = await load();
      expect(getDeployDiagnostics('id;rm -rf /')).toBeNull();
      expect(getDeployDiagnostics('$(evil)')).toBeNull();
      expect(getDeployDiagnostics('`whoami`')).toBeNull();
    });

    it('returned record durationMs matches what was saved', async () => {
      const { persistDeployDiagnostics, getDeployDiagnostics } = await load();
      const startedAt = Date.now() - 12_000;
      const id = await persistDeployDiagnostics({ ...minimalInput(), startedAt });
      const record = getDeployDiagnostics(id);
      expect(record!.durationMs).toBeGreaterThanOrEqual(12_000);
    });

    it('returned record result field matches input result', async () => {
      const { persistDeployDiagnostics, getDeployDiagnostics } = await load();
      const id = await persistDeployDiagnostics({ ...minimalInput(), result: 'crashed' });
      const record = getDeployDiagnostics(id);
      expect(record!.result).toBe('crashed');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // round-trip: persist → list → get
  // ════════════════════════════════════════════════════════════════════════

  describe('round-trip: persist → list → get', () => {
    it('id from persist matches id in list matches id from get', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics, getDeployDiagnostics } = await load();
      const persistedId = await persistDeployDiagnostics(minimalInput());
      const list = listDeployDiagnostics();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(persistedId);
      const record = getDeployDiagnostics(persistedId);
      expect(record).not.toBeNull();
      expect(record!.id).toBe(persistedId);
    });

    it('all providers round-trip correctly', async () => {
      const { persistDeployDiagnostics, listDeployDiagnostics, getDeployDiagnostics } = await load();
      const providers = ['runpod', 'vast', 'tensordock', 'modal'];
      const ids: string[] = [];
      for (const provider of providers) {
        const id = await persistDeployDiagnostics({ ...minimalInput(), provider });
        ids.push(id);
      }
      const list = listDeployDiagnostics();
      expect(list).toHaveLength(4);
      const listedIds = new Set(list.map(s => s.id));
      for (const id of ids) {
        expect(listedIds.has(id)).toBe(true);
        const record = getDeployDiagnostics(id);
        expect(record).not.toBeNull();
      }
    });
  });
});
