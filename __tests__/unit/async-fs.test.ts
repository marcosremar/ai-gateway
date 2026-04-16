/**
 * Tests for async-fs module.
 */

import { describe, it, expect } from 'vitest';
import { safeJsonParse, safeJsonStringify } from '../../src/null-safety';

describe('AsyncFS', () => {
  it('should parse JSON safely', () => {
    expect(safeJsonParse('{"a": 1}')).toEqual({ a: 1 });
    expect(safeJsonParse('invalid')).toBeUndefined();
  });

  it('should stringify JSON safely', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
    const circular: any = {};
    circular.self = circular;
    expect(safeJsonStringify(circular)).toBe('"[Circular or Unserializable]"');
  });
});
