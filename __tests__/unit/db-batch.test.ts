/**
 * Tests for db-batch module.
 */

import { describe, it, expect, vi } from 'vitest';
import { diffState } from '../../src/db-batch';

describe('diffState', () => {
  it('should return empty object for identical states', () => {
    const oldState = { a: 1, b: 'hello' };
    const newState = { a: 1, b: 'hello' };

    const changes = diffState(oldState, newState);
    expect(Object.keys(changes)).toHaveLength(0);
  });

  it('should return only changed fields', () => {
    const oldState = { a: 1, b: 'hello', c: true };
    const newState = { a: 1, b: 'world', c: true };

    const changes = diffState(oldState, newState);
    expect(Object.keys(changes)).toEqual(['b']);
    expect(changes.b).toBe('world');
  });

  it('should return all fields if all changed', () => {
    const oldState = { a: 1, b: 2 };
    const newState = { a: 10, b: 20 };

    const changes = diffState(oldState, newState);
    expect(Object.keys(changes)).toHaveLength(2);
  });

  it('should handle new fields', () => {
    const oldState = { a: 1 };
    const newState = { a: 1, b: 2 };

    const changes = diffState(oldState, newState);
    expect(changes.b).toBe(2);
  });
});
