import { describe, it, expect } from 'vitest';
import { ApiKeyRegistry } from '../../src/proxy/middleware/api-keys';

describe('ApiKeyRegistry — construction and load', () => {
  it('starts empty with no raw string', () => {
    const reg = new ApiKeyRegistry();
    expect(reg.size).toBe(0);
  });

  it('parses plain keys (backward compat userId=default)', () => {
    const reg = new ApiKeyRegistry('myplainkey');
    expect(reg.size).toBe(1);
    expect(reg.resolve('myplainkey')?.userId).toBe('default');
  });

  it('parses key:userId pairs', () => {
    const reg = new ApiKeyRegistry('key1:alice,key2:bob');
    expect(reg.size).toBe(2);
    expect(reg.resolve('key1')?.userId).toBe('alice');
    expect(reg.resolve('key2')?.userId).toBe('bob');
  });

  it('parses key:userId:label triples', () => {
    const reg = new ApiKeyRegistry('sk-abc:alice:prod-bot');
    const entry = reg.resolve('sk-abc');
    expect(entry?.userId).toBe('alice');
    expect(entry?.label).toBe('prod-bot');
  });

  it('handles labels that contain colons (joins remaining parts)', () => {
    const reg = new ApiKeyRegistry('sk-x:alice:label:with:colons');
    const entry = reg.resolve('sk-x');
    expect(entry?.label).toBe('label:with:colons');
  });

  it('ignores empty segments from leading/trailing commas', () => {
    const reg = new ApiKeyRegistry(',key1:user1,,key2:user2,');
    expect(reg.size).toBe(2);
  });

  it('trims whitespace around entries', () => {
    const reg = new ApiKeyRegistry('  key1:alice  ,  key2:bob  ');
    expect(reg.resolve('key1')?.userId).toBe('alice');
    expect(reg.resolve('key2')?.userId).toBe('bob');
  });

  it('load() replaces existing entries', () => {
    const reg = new ApiKeyRegistry('old:user');
    reg.load('new:admin');
    expect(reg.size).toBe(1);
    expect(reg.resolve('old')).toBeNull();
    expect(reg.resolve('new')?.userId).toBe('admin');
  });
});

describe('ApiKeyRegistry — validate', () => {
  it('denies everything when registry is empty', () => {
    const reg = new ApiKeyRegistry();
    expect(reg.validate('anytoken')).toBe(false);
    expect(reg.validate('')).toBe(false);
  });

  it('accepts a valid token', () => {
    const reg = new ApiKeyRegistry('secret:alice');
    expect(reg.validate('secret')).toBe(true);
  });

  it('rejects an invalid token', () => {
    const reg = new ApiKeyRegistry('secret:alice');
    expect(reg.validate('wrong')).toBe(false);
  });

  it('accepts any matching key from a multi-key registry', () => {
    const reg = new ApiKeyRegistry('key1:alice,key2:bob,key3:carol');
    expect(reg.validate('key2')).toBe(true);
    expect(reg.validate('key3')).toBe(true);
  });

  it('rejects a token that is a prefix of a valid key (length mismatch)', () => {
    const reg = new ApiKeyRegistry('longersecret:alice');
    expect(reg.validate('longer')).toBe(false);
  });

  it('rejects a token that is a superset of a valid key', () => {
    const reg = new ApiKeyRegistry('short:alice');
    expect(reg.validate('short-extra')).toBe(false);
  });
});

describe('ApiKeyRegistry — resolve', () => {
  it('returns null for empty registry', () => {
    const reg = new ApiKeyRegistry();
    expect(reg.resolve('anything')).toBeNull();
  });

  it('returns matching entry with all fields', () => {
    const reg = new ApiKeyRegistry('tok:marco:dev-key');
    const entry = reg.resolve('tok');
    expect(entry).not.toBeNull();
    expect(entry?.key).toBe('tok');
    expect(entry?.userId).toBe('marco');
    expect(entry?.label).toBe('dev-key');
  });

  it('returns null for an unknown token', () => {
    const reg = new ApiKeyRegistry('real:alice');
    expect(reg.resolve('fake')).toBeNull();
  });
});

describe('ApiKeyRegistry — keys', () => {
  it('returns empty array for empty registry', () => {
    const reg = new ApiKeyRegistry();
    expect(reg.keys()).toEqual([]);
  });

  it('returns raw key strings', () => {
    const reg = new ApiKeyRegistry('k1:u1,k2:u2');
    expect(reg.keys()).toEqual(['k1', 'k2']);
  });
});

describe('ApiKeyRegistry — listMasked', () => {
  it('returns empty array for empty registry', () => {
    const reg = new ApiKeyRegistry();
    expect(reg.listMasked()).toEqual([]);
  });

  it('masks keys after first 8 characters', () => {
    const reg = new ApiKeyRegistry('12345678abcdef:alice');
    const [masked] = reg.listMasked();
    expect(masked.keyPrefix).toBe('12345678...');
  });

  it('includes userId and label when present', () => {
    const reg = new ApiKeyRegistry('sk-abcdef:bob:ci-bot');
    const [masked] = reg.listMasked();
    expect(masked.userId).toBe('bob');
    expect(masked.label).toBe('ci-bot');
  });

  it('omits label field when no label was specified', () => {
    const reg = new ApiKeyRegistry('sk-abcdef:alice');
    const [masked] = reg.listMasked();
    expect(masked.label).toBeUndefined();
  });

  it('does not expose full key values', () => {
    const reg = new ApiKeyRegistry('super-secret-key:alice');
    const json = JSON.stringify(reg.listMasked());
    expect(json).not.toContain('super-secret-key');
    expect(json).toContain('super-se...');
  });
});
