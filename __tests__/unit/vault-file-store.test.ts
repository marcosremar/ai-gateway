import { describe, it, expect, afterEach } from 'vitest';
import { FileVaultStore } from '../../src/vault/file-store';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import os from 'os';

let testFile: string;

function newStore() {
  testFile = join(os.tmpdir(), `file-store-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  return new FileVaultStore(testFile);
}

afterEach(() => {
  try { unlinkSync(testFile); } catch {}
});

describe('FileVaultStore', () => {
  it('get() on non-existent file → null', async () => {
    const store = newStore();
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('set() + get() → returns same value', async () => {
    const store = newStore();
    await store.set('key1', 'value1');
    const result = await store.get('key1');
    expect(result).toBe('value1');
  });

  it('delete() → get() returns null', async () => {
    const store = newStore();
    await store.set('key1', 'value1');
    await store.delete('key1');
    const result = await store.get('key1');
    expect(result).toBeNull();
  });

  it('list() → returns all keys', async () => {
    const store = newStore();
    await store.set('alpha', '1');
    await store.set('beta', '2');
    await store.set('gamma', '3');
    const keys = await store.list();
    expect(keys).toHaveLength(3);
    expect(keys).toContain('alpha');
    expect(keys).toContain('beta');
    expect(keys).toContain('gamma');
  });

  it('multiple sets → all persisted', async () => {
    const store = newStore();
    await store.set('a', '1');
    await store.set('b', '2');
    await store.set('c', '3');
    expect(await store.get('a')).toBe('1');
    expect(await store.get('b')).toBe('2');
    expect(await store.get('c')).toBe('3');
  });

  it('file does not exist on get → returns null (no crash)', async () => {
    const store = newStore();
    try { unlinkSync(testFile); } catch {}
    const result = await store.get('anything');
    expect(result).toBeNull();
  });

  it('corrupted JSON file → returns empty (no crash)', async () => {
    const store = newStore();
    const { writeFileSync } = require('fs');
    writeFileSync(testFile, 'NOT VALID JSON {{{', 'utf-8');
    const result = await store.get('anything');
    expect(result).toBeNull();
    const keys = await store.list();
    expect(keys).toEqual([]);
  });

  it('persists across new store instances (same file)', async () => {
    const store1 = newStore();
    await store1.set('shared', 'data');

    const store2 = new FileVaultStore(testFile);
    expect(await store2.get('shared')).toBe('data');
  });
});
