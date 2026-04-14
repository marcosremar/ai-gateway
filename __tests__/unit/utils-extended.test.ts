/**
 * Tests for utils module.
 */

import { describe, it, expect } from 'vitest';
import { uuid, truncate, sleep } from '../../src/utils';

describe('Utils', () => {
  it('should generate UUIDs', () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('should truncate strings', () => {
    expect(truncate('hello world', 5)).toBe('he...');
  });

  it('should sleep', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});
