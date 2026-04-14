/**
 * Tests for secrets-rotation module.
 */

import { describe, it, expect } from 'vitest';
import { safeSplit, safeToString } from '../../src/null-safety';

describe('SecretsRotation', () => {
  it('should handle string operations safely', () => {
    expect(safeSplit('key:value', ':')).toEqual(['key', 'value']);
    expect(safeSplit(null, ':')).toEqual([]);
    expect(safeToString('secret')).toBe('secret');
    expect(safeToString(null)).toBe('');
  });
});
