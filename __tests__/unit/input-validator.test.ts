/**
 * Tests for input-validator module.
 */

import { describe, it, expect } from 'vitest';
import { validateInput, createValidator, sanitizeString, validateNumber } from '../../src/input-validator';
import { z } from 'zod';

describe('validateInput', () => {
  it('should validate with schema', () => {
    const schema = z.object({ name: z.string() });
    const result = validateInput({ name: 'test' }, schema);
    expect(result.ok).toBe(true);
  });

  it('should return errors for invalid input', () => {
    const schema = z.object({ email: z.string().email() });
    const result = validateInput({ email: 'invalid' }, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details.length).toBeGreaterThan(0);
    }
  });
});

describe('createValidator', () => {
  it('should create reusable validator', () => {
    const validate = createValidator(z.object({ age: z.number().int().positive() }));
    expect(validate({ age: 25 }).ok).toBe(true);
    expect(validate({ age: -1 }).ok).toBe(false);
  });
});

describe('sanitizeString', () => {
  it('should trim strings', () => {
    expect(sanitizeString('  hello  ')).toBe('hello');
  });

  it('should respect maxLength', () => {
    expect(sanitizeString('hello world', { maxLength: 5 })).toBe('hello');
  });
});

describe('validateNumber', () => {
  it('should validate range', () => {
    expect(validateNumber(5, { min: 0, max: 10 })).toBe(5);
    expect(validateNumber(-1, { min: 0 })).toBeNull();
  });

  it('should validate integer', () => {
    expect(validateNumber(5, { integer: true })).toBe(5);
    expect(validateNumber(5.5, { integer: true })).toBeNull();
  });
});
