/**
 * Unit tests for src/async-fs/index.ts
 *
 * Uses real tmp-dir I/O so we can verify atomicWrite, integrity checks,
 * and the write-buffer without mocking the fs module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm, readFile as fsReadFile } from 'fs/promises';
import { writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

import {
  readFile,
  readJson,
  writeFile,
  writeJson,
  atomicWrite,
  atomicWriteJson,
  ensureDir,
  fileExists,
  getFileStats,
  readFileWithIntegrity,
  writeFileWithChecksum,
  createWriteBuffer,
} from '../../src/async-fs';

// ── Helpers ────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `async-fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(async () => {
  try { await rm(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function p(...parts: string[]): string {
  return join(testDir, ...parts);
}

// ── readFile ───────────────────────────────────────────────────────────────

describe('readFile', () => {
  it('returns null for a missing file', async () => {
    await ensureDir(testDir);
    expect(await readFile(p('nonexistent.txt'))).toBeNull();
  });

  it('returns file content for an existing file', async () => {
    await ensureDir(testDir);
    writeFileSync(p('hello.txt'), 'hello world', 'utf-8');
    expect(await readFile(p('hello.txt'))).toBe('hello world');
  });

  it('propagates non-ENOENT errors', async () => {
    // Pass a directory path — readFile should throw since it's a dir, not a file.
    await ensureDir(testDir);
    await expect(readFile(testDir)).rejects.toThrow();
  });
});

// ── readJson ───────────────────────────────────────────────────────────────

describe('readJson', () => {
  it('returns null for missing file', async () => {
    await ensureDir(testDir);
    expect(await readJson(p('missing.json'))).toBeNull();
  });

  it('parses valid JSON', async () => {
    await ensureDir(testDir);
    writeFileSync(p('data.json'), '{"x":42}', 'utf-8');
    expect(await readJson(p('data.json'))).toEqual({ x: 42 });
  });

  it('returns null on invalid JSON (does not throw)', async () => {
    await ensureDir(testDir);
    writeFileSync(p('bad.json'), 'not json!!!', 'utf-8');
    expect(await readJson(p('bad.json'))).toBeNull();
  });
});

// ── writeFile ─────────────────────────────────────────────────────────────

describe('writeFile', () => {
  it('creates file with content', async () => {
    await ensureDir(testDir);
    await writeFile(p('out.txt'), 'written');
    expect(await fsReadFile(p('out.txt'), 'utf-8')).toBe('written');
  });

  it('overwrites existing file', async () => {
    await ensureDir(testDir);
    writeFileSync(p('out.txt'), 'old', 'utf-8');
    await writeFile(p('out.txt'), 'new');
    expect(await fsReadFile(p('out.txt'), 'utf-8')).toBe('new');
  });
});

// ── writeJson ─────────────────────────────────────────────────────────────

describe('writeJson', () => {
  it('writes pretty-printed JSON', async () => {
    await ensureDir(testDir);
    await writeJson(p('out.json'), { a: 1 });
    const raw = await fsReadFile(p('out.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ a: 1 });
    expect(raw).toContain('\n'); // pretty-printed
  });
});

// ── atomicWrite ───────────────────────────────────────────────────────────

describe('atomicWrite', () => {
  it('creates the target file with correct content', async () => {
    await ensureDir(testDir);
    await atomicWrite(p('state.json'), 'atomic-content');
    expect(await fsReadFile(p('state.json'), 'utf-8')).toBe('atomic-content');
  });

  it('creates parent directory if it does not exist', async () => {
    const nested = p('deep', 'nested', 'state.json');
    await atomicWrite(nested, 'deep-value');
    expect(await fsReadFile(nested, 'utf-8')).toBe('deep-value');
  });

  it('leaves no .tmp files behind after success', async () => {
    await ensureDir(testDir);
    await atomicWrite(p('clean.json'), 'data');
    const remaining = existsSync(testDir)
      ? (await import('fs')).readdirSync(testDir).filter((f: string) => f.includes('.tmp'))
      : [];
    expect(remaining).toHaveLength(0);
  });

  it('path without a slash produces an empty dir component', () => {
    // Verify that the dir extraction produces '' for a bare filename,
    // confirming that the old code would have called mkdir('').
    const path = 'state.json';
    const dir = path.substring(0, path.lastIndexOf('/'));
    expect(dir).toBe('');
  });

  it('works with an absolute path that has only one directory level', async () => {
    await ensureDir(testDir);
    await atomicWrite(p('single.json'), 'single-level');
    expect(await fsReadFile(p('single.json'), 'utf-8')).toBe('single-level');
  });
});

// ── atomicWriteJson ───────────────────────────────────────────────────────

describe('atomicWriteJson', () => {
  it('writes and reads back JSON', async () => {
    await ensureDir(testDir);
    await atomicWriteJson(p('obj.json'), { hello: 'world' });
    const raw = await fsReadFile(p('obj.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ hello: 'world' });
  });
});

// ── ensureDir ─────────────────────────────────────────────────────────────

describe('ensureDir', () => {
  it('creates a new directory', async () => {
    const dir = p('newdir');
    await ensureDir(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('does not throw when directory already exists', async () => {
    await ensureDir(testDir);
    await expect(ensureDir(testDir)).resolves.not.toThrow();
  });

  it('creates nested directories', async () => {
    const nested = p('a', 'b', 'c');
    await ensureDir(nested);
    expect(existsSync(nested)).toBe(true);
  });
});

// ── fileExists ────────────────────────────────────────────────────────────

describe('fileExists', () => {
  it('returns false for a missing file', async () => {
    await ensureDir(testDir);
    expect(await fileExists(p('nope.txt'))).toBe(false);
  });

  it('returns true for an existing file', async () => {
    await ensureDir(testDir);
    writeFileSync(p('yes.txt'), '', 'utf-8');
    expect(await fileExists(p('yes.txt'))).toBe(true);
  });

  it('returns true for an existing directory', async () => {
    await ensureDir(testDir);
    expect(await fileExists(testDir)).toBe(true);
  });
});

// ── getFileStats ──────────────────────────────────────────────────────────

describe('getFileStats', () => {
  it('returns null for a missing file', async () => {
    await ensureDir(testDir);
    expect(await getFileStats(p('nope.txt'))).toBeNull();
  });

  it('returns size and mtime for an existing file', async () => {
    await ensureDir(testDir);
    writeFileSync(p('file.txt'), 'hello', 'utf-8');
    const stats = await getFileStats(p('file.txt'));
    expect(stats).not.toBeNull();
    expect(stats!.size).toBe(5);
    expect(stats!.mtime).toBeInstanceOf(Date);
  });
});

// ── readFileWithIntegrity ─────────────────────────────────────────────────

describe('readFileWithIntegrity', () => {
  it('returns ok:false for missing file', async () => {
    await ensureDir(testDir);
    const result = await readFileWithIntegrity(p('missing.txt'));
    expect(result.ok).toBe(false);
    expect(result.content).toBe('');
  });

  it('returns ok:true without checksum validation', async () => {
    await ensureDir(testDir);
    writeFileSync(p('data.txt'), 'hello', 'utf-8');
    const result = await readFileWithIntegrity(p('data.txt'));
    expect(result.ok).toBe(true);
    expect(result.content).toBe('hello');
  });

  it('returns ok:true when checksum matches', async () => {
    await ensureDir(testDir);
    const content = 'important data';
    writeFileSync(p('data.txt'), content, 'utf-8');
    const checksum = createHash('sha256').update(content).digest('hex');
    const result = await readFileWithIntegrity(p('data.txt'), checksum);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(content);
  });

  it('returns ok:false when checksum does not match', async () => {
    await ensureDir(testDir);
    writeFileSync(p('data.txt'), 'tampered!', 'utf-8');
    const wrongChecksum = 'aabbcc00112233445566778899aabbccddeeff001122334455667788';
    const result = await readFileWithIntegrity(p('data.txt'), wrongChecksum);
    expect(result.ok).toBe(false);
    expect(result.content).toBe('');
  });
});

// ── writeFileWithChecksum ─────────────────────────────────────────────────

describe('writeFileWithChecksum', () => {
  it('writes the file and returns a sha256 checksum', async () => {
    await ensureDir(testDir);
    const content = 'checksum-me';
    const checksum = await writeFileWithChecksum(p('cs.txt'), content);
    const expected = createHash('sha256').update(content).digest('hex');
    expect(checksum).toBe(expected);
    expect(await fsReadFile(p('cs.txt'), 'utf-8')).toBe(content);
  });

  it('checksum round-trips with readFileWithIntegrity', async () => {
    await ensureDir(testDir);
    const content = 'round-trip data';
    const checksum = await writeFileWithChecksum(p('rt.txt'), content);
    const result = await readFileWithIntegrity(p('rt.txt'), checksum);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(content);
  });
});

// ── createWriteBuffer ─────────────────────────────────────────────────────

describe('createWriteBuffer', () => {
  it('does not write immediately — data is pending', async () => {
    await ensureDir(testDir);
    const buf = createWriteBuffer(p('buf.txt'), { flushIntervalMs: 100_000 });
    buf.write('pending-data');
    expect(buf.pending).toBe('pending-data');
    expect(existsSync(p('buf.txt'))).toBe(false);
    await buf.close(); // flush + cleanup
  });

  it('coalesces multiple writes — only last value is persisted', async () => {
    await ensureDir(testDir);
    const buf = createWriteBuffer(p('coal.txt'), { flushIntervalMs: 100_000 });
    buf.write('first');
    buf.write('second');
    buf.write('final');
    expect(buf.pending).toBe('final');
    await buf.close();
    expect(await fsReadFile(p('coal.txt'), 'utf-8')).toBe('final');
  });

  it('flush() writes pending data immediately', async () => {
    await ensureDir(testDir);
    const buf = createWriteBuffer(p('flush.txt'), { flushIntervalMs: 100_000 });
    buf.write('flush-me');
    await buf.flush();
    expect(await fsReadFile(p('flush.txt'), 'utf-8')).toBe('flush-me');
  });

  it('pending is null after flush', async () => {
    await ensureDir(testDir);
    const buf = createWriteBuffer(p('pend.txt'), { flushIntervalMs: 100_000 });
    buf.write('x');
    await buf.flush();
    expect(buf.pending).toBeNull();
  });

  it('close() with no pending data does not throw', async () => {
    await ensureDir(testDir);
    const buf = createWriteBuffer(p('empty.txt'), { flushIntervalMs: 100_000 });
    await expect(buf.close()).resolves.not.toThrow();
  });

  it('atomic:true uses atomicWrite', async () => {
    await ensureDir(testDir);
    const buf = createWriteBuffer(p('atomic.txt'), { flushIntervalMs: 100_000, atomic: true });
    buf.write('atomic-value');
    await buf.close();
    expect(await fsReadFile(p('atomic.txt'), 'utf-8')).toBe('atomic-value');
  });
});
