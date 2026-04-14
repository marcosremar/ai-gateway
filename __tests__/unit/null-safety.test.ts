/**
 * Tests for null-safety utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  safeGet,
  safeCall,
  safeCallSync,
  requireDefined,
  requireNonEmpty,
  safeSplit,
  safeToString,
  safeParseInt,
  safeJsonParse,
  safeJsonStringify,
  coalesce,
  isDefined,
  callIfDefined,
} from '../../src/null-safety';

describe('safeGet', () => {
  it('should return value for valid path', () => {
    const obj = { a: { b: { c: 'value' } } };
    expect(safeGet(obj, 'a.b.c')).toBe('value');
  });

  it('should return default for null path', () => {
    expect(safeGet(null, 'a.b', 'default')).toBe('default');
  });

  it('should return default for undefined path', () => {
    const obj = { a: {} };
    expect(safeGet(obj, 'a.b.c', 'default')).toBe('default');
  });
});

describe('safeCall', () => {
  it('should return ok for successful call', async () => {
    const result = await safeCall(async () => 'success');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('success');
  });

  it('should return error for failing call', async () => {
    const result = await safeCall(async () => {
      throw new Error('failed');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('failed');
  });
});

describe('safeCallSync', () => {
  it('should return ok for successful call', () => {
    const result = safeCallSync(() => 'success');
    expect(result.ok).toBe(true);
  });

  it('should return error for failing call', () => {
    const result = safeCallSync(() => {
      throw new Error('failed');
    });
    expect(result.ok).toBe(false);
  });
});

describe('requireDefined', () => {
  it('should return value if defined', () => {
    expect(requireDefined('value', 'name')).toBe('value');
  });

  it('should throw for undefined', () => {
    expect(() => requireDefined(undefined, 'name')).toThrow("Required value 'name' is not defined");
  });

  it('should throw for null', () => {
    expect(() => requireDefined(null, 'name')).toThrow("Required value 'name' is not defined");
  });
});

describe('requireNonEmpty', () => {
  it('should return trimmed value if non-empty', () => {
    expect(requireNonEmpty('  hello  ', 'name')).toBe('hello');
  });

  it('should throw for empty string', () => {
    expect(() => requireNonEmpty('', 'name')).toThrow("Required value 'name' is empty");
  });

  it('should throw for whitespace', () => {
    expect(() => requireNonEmpty('   ', 'name')).toThrow("Required value 'name' is empty");
  });
});

describe('safeSplit', () => {
  it('should split valid string', () => {
    expect(safeSplit('a:b:c', ':')).toEqual(['a', 'b', 'c']);
  });

  it('should return empty array for null', () => {
    expect(safeSplit(null, ':')).toEqual([]);
  });

  it('should return empty array for undefined', () => {
    expect(safeSplit(undefined, ':')).toEqual([]);
  });
});

describe('safeToString', () => {
  it('should convert valid values', () => {
    expect(safeToString('hello')).toBe('hello');
    expect(safeToString(123)).toBe('123');
  });

  it('should return empty string for null/undefined', () => {
    expect(safeToString(null)).toBe('');
    expect(safeToString(undefined)).toBe('');
  });
});

describe('safeParseInt', () => {
  it('should parse valid integers', () => {
    expect(safeParseInt('123')).toBe(123);
  });

  it('should return NaN for invalid input', () => {
    expect(safeParseInt('abc')).toBeNaN();
  });

  it('should return NaN for null/undefined', () => {
    expect(safeParseInt(null)).toBeNaN();
  });
});

describe('safeJsonStringify', () => {
  it('should stringify valid objects', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('should handle circular references', () => {
    const obj: any = {};
    obj.self = obj;
    expect(safeJsonStringify(obj)).toBe('"[Circular or Unserializable]"');
  });
});

describe('coalesce', () => {
  it('should return value if defined', () => {
    expect(coalesce('value', 'fallback')).toBe('value');
  });

  it('should return fallback for null', () => {
    expect(coalesce(null, 'fallback')).toBe('fallback');
  });

  it('should return fallback for undefined', () => {
    expect(coalesce(undefined, 'fallback')).toBe('fallback');
  });
});

describe('isDefined', () => {
  it('should return true for defined values', () => {
    expect(isDefined('value')).toBe(true);
    expect(isDefined(0)).toBe(true);
    expect(isDefined('')).toBe(true);
  });

  it('should return false for null/undefined', () => {
    expect(isDefined(null)).toBe(false);
    expect(isDefined(undefined)).toBe(false);
  });
});

describe('callIfDefined', () => {
  it('should call function if value is defined', () => {
    const fn = vi.fn((v: number) => v * 2);
    expect(callIfDefined(5, fn, 0)).toBe(10);
    expect(fn).toHaveBeenCalledWith(5);
  });

  it('should return fallback if value is null', () => {
    const fn = vi.fn();
    expect(callIfDefined(null, fn, 42)).toBe(42);
    expect(fn).not.toHaveBeenCalled();
  });
});
