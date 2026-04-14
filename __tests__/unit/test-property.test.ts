/**
 * Tests for test-property module.
 */

import { describe, it, expect } from 'vitest';
import { genLanguageCode, genAudioBuffer, genMessages, genNumber, genBoolean, property, checkIdempotent } from '../../src/test-property';

describe('Property Testing', () => {
  it('should generate language codes', () => {
    const code = genLanguageCode();
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThanOrEqual(2);
  });

  it('should generate audio buffers', () => {
    const buffer = genAudioBuffer();
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThanOrEqual(100);
  });

  it('should generate messages', () => {
    const messages = genMessages();
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('should generate numbers', () => {
    const num = genNumber();
    expect(typeof num).toBe('number');
  });

  it('should generate booleans', () => {
    const bool = genBoolean();
    expect(typeof bool).toBe('boolean');
  });

  it('should check idempotence', () => {
    const fn = (x: string) => x.toLowerCase();
    expect(checkIdempotent(fn, 'Hello')).toBe(true);
  });

  it('should run property tests', async () => {
    let count = 0;
    await property('test', 10, () => {
      count++;
    });
    expect(count).toBe(10);
  });
});
