/**
 * Common Types Tests
 */

import { describe, it, expect } from 'vitest';
import {
  isJsonObject,
  isJsonArray,
  isString,
  isNumber,
  isBoolean,
  isFunction,
} from '../../src/types/common';

describe('Type Guards', () => {
  describe('isJsonObject', () => {
    it('should return true for plain objects', () => {
      expect(isJsonObject({})).toBe(true);
      expect(isJsonObject({ key: 'value' })).toBe(true);
    });

    it('should return false for non-objects', () => {
      expect(isJsonObject(null)).toBe(false);
      expect(isJsonObject([])).toBe(false);
      expect(isJsonObject('string')).toBe(false);
      expect(isJsonObject(123)).toBe(false);
    });
  });

  describe('isJsonArray', () => {
    it('should return true for arrays', () => {
      expect(isJsonArray([])).toBe(true);
      expect(isJsonArray([1, 2, 3])).toBe(true);
    });

    it('should return false for non-arrays', () => {
      expect(isJsonArray({})).toBe(false);
      expect(isJsonArray(null)).toBe(false);
      expect(isJsonArray('string')).toBe(false);
    });
  });

  describe('isString', () => {
    it('should return true for strings', () => {
      expect(isString('hello')).toBe(true);
      expect(isString('')).toBe(true);
    });

    it('should return false for non-strings', () => {
      expect(isString(123)).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString({})).toBe(false);
    });
  });

  describe('isNumber', () => {
    it('should return true for numbers', () => {
      expect(isNumber(42)).toBe(true);
      expect(isNumber(0)).toBe(true);
      expect(isNumber(-1)).toBe(true);
    });

    it('should return false for non-numbers', () => {
      expect(isNumber('42')).toBe(false);
      expect(isNumber(null)).toBe(false);
      expect(isNumber(NaN)).toBe(false);
    });
  });

  describe('isBoolean', () => {
    it('should return true for booleans', () => {
      expect(isBoolean(true)).toBe(true);
      expect(isBoolean(false)).toBe(true);
    });

    it('should return false for non-booleans', () => {
      expect(isBoolean(1)).toBe(false);
      expect(isBoolean('true')).toBe(false);
      expect(isBoolean(null)).toBe(false);
    });
  });

  describe('isFunction', () => {
    it('should return true for functions', () => {
      expect(isFunction(() => {})).toBe(true);
      expect(isFunction(function() {})).toBe(true);
    });

    it('should return false for non-functions', () => {
      expect(isFunction({})).toBe(false);
      expect(isFunction(null)).toBe(false);
      expect(isFunction('function')).toBe(false);
    });
  });
});
