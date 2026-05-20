/**
 * Builtin tools registry — covers each builtin's success + safety paths
 * (SSRF guard, path whitelist, byte caps, JSON path traversal).
 */
import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { makeBuiltin, listBuiltinTools } from '../../server/tools-builtin';

function fakeCtx() {
  return { signal: new AbortController().signal, toolUseId: 'tu_test', toolName: 'test' };
}

describe('listBuiltinTools', () => {
  it('lists known builtin names', () => {
    const names = listBuiltinTools();
    expect(names).toContain('current_time');
    expect(names).toContain('http_get');
    expect(names).toContain('read_file');
    expect(names).toContain('json_extract');
  });
});

describe('makeBuiltin', () => {
  it('returns null for unknown name', () => {
    expect(makeBuiltin('nonexistent_tool')).toBeNull();
  });

  it('current_time returns ISO + epoch + tz', async () => {
    const tool = makeBuiltin('current_time')!;
    const out = await tool.invoke({ timezone: 'UTC' }, fakeCtx());
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('iso');
    expect(parsed).toHaveProperty('epoch_ms');
    expect(parsed.timezone).toBe('UTC');
  });

  it('current_time gracefully handles invalid timezone', async () => {
    const tool = makeBuiltin('current_time')!;
    const out = await tool.invoke({ timezone: 'Invalid/Zone' }, fakeCtx());
    expect(JSON.parse(out)).toHaveProperty('iso');
  });
});

describe('http_get builtin', () => {
  it('rejects missing url', async () => {
    const tool = makeBuiltin('http_get')!;
    await expect(tool.invoke({}, fakeCtx())).rejects.toThrow(/requires \{url:string\}/);
  });

  it('rejects invalid URL', async () => {
    const tool = makeBuiltin('http_get')!;
    await expect(tool.invoke({ url: 'not a url' }, fakeCtx())).rejects.toThrow(/invalid url/);
  });

  it('rejects non-http protocols', async () => {
    const tool = makeBuiltin('http_get')!;
    await expect(tool.invoke({ url: 'file:///etc/passwd' }, fakeCtx())).rejects.toThrow(/unsupported protocol/);
  });

  it('blocks private/loopback addresses (SSRF)', async () => {
    const tool = makeBuiltin('http_get')!;
    await expect(tool.invoke({ url: 'http://127.0.0.1/secret' }, fakeCtx()))
      .rejects.toThrow(/SSRF/);
    await expect(tool.invoke({ url: 'http://169.254.169.254/latest' }, fakeCtx()))
      .rejects.toThrow(/SSRF/);
  });
});

describe('read_file builtin', () => {
  it('refuses when no allowed dirs configured', async () => {
    const tool = makeBuiltin('read_file')!;
    await expect(tool.invoke({ path: '/etc/passwd' }, fakeCtx()))
      .rejects.toThrow(/no allowed directories/);
  });

  it('reads files inside allowed dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aigw-readfile-'));
    const filePath = path.join(dir, 'sample.txt');
    await writeFile(filePath, 'hello world', 'utf8');
    const tool = makeBuiltin('read_file', { allowedReadDirs: [dir] })!;
    const out = await tool.invoke({ path: filePath }, fakeCtx());
    expect(out).toBe('hello world');
  });

  it('rejects path outside whitelist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aigw-readfile-'));
    const tool = makeBuiltin('read_file', { allowedReadDirs: [dir] })!;
    await expect(tool.invoke({ path: '/etc/passwd' }, fakeCtx()))
      .rejects.toThrow(/outside allowed dirs/);
  });

  it('rejects path traversal escaping the whitelist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aigw-readfile-'));
    const tool = makeBuiltin('read_file', { allowedReadDirs: [dir] })!;
    await expect(tool.invoke({ path: path.join(dir, '../../etc/passwd') }, fakeCtx()))
      .rejects.toThrow(/outside allowed dirs/);
  });

  it('rejects files exceeding maxBytes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aigw-readfile-'));
    const filePath = path.join(dir, 'big.txt');
    await writeFile(filePath, 'x'.repeat(1024), 'utf8');
    const tool = makeBuiltin('read_file', { allowedReadDirs: [dir], maxBytes: 100 })!;
    await expect(tool.invoke({ path: filePath }, fakeCtx()))
      .rejects.toThrow(/exceeds max/);
  });
});

describe('json_extract builtin', () => {
  it('returns root when path is "$"', async () => {
    const tool = makeBuiltin('json_extract')!;
    const out = await tool.invoke({ json: { a: 1 }, path: '$' }, fakeCtx());
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it('extracts nested object property', async () => {
    const tool = makeBuiltin('json_extract')!;
    const out = await tool.invoke(
      { json: { user: { name: 'alice' } }, path: '$.user.name' },
      fakeCtx(),
    );
    expect(JSON.parse(out)).toBe('alice');
  });

  it('extracts array element by index', async () => {
    const tool = makeBuiltin('json_extract')!;
    const out = await tool.invoke({ json: { items: ['a', 'b', 'c'] }, path: '$.items[1]' }, fakeCtx());
    expect(JSON.parse(out)).toBe('b');
  });

  it('parses JSON string input', async () => {
    const tool = makeBuiltin('json_extract')!;
    const out = await tool.invoke({ json: '{"x":42}', path: '$.x' }, fakeCtx());
    expect(JSON.parse(out)).toBe(42);
  });

  it('returns null when path not found', async () => {
    const tool = makeBuiltin('json_extract')!;
    const out = await tool.invoke({ json: { a: 1 }, path: '$.missing' }, fakeCtx());
    expect(JSON.parse(out)).toBeNull();
  });

  it('rejects when path missing', async () => {
    const tool = makeBuiltin('json_extract')!;
    await expect(tool.invoke({ json: {} }, fakeCtx())).rejects.toThrow(/requires/);
  });
});
