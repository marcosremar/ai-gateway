import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashApiKey, CreditBlockTracker } from '../../src/providers/credit-block';

describe('hashApiKey()', () => {
  it('should return a 32-char hex string', () => {
    const result = hashApiKey('test-key');
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should be deterministic', () => {
    const a = hashApiKey('my-api-key');
    const b = hashApiKey('my-api-key');
    expect(a).toBe(b);
  });

  it('should produce different hashes for different keys', () => {
    const a = hashApiKey('key-a');
    const b = hashApiKey('key-b');
    expect(a).not.toBe(b);
  });
});

describe('CreditBlockTracker', () => {
  let tracker: CreditBlockTracker;

  beforeEach(() => {
    tracker = new CreditBlockTracker();
  });

  it('should return true for blocked provider:key', () => {
    const hash = hashApiKey('sk-test');
    tracker.recordBlock('openai', hash);
    expect(tracker.isBlocked('openai', hash)).toBe(true);
  });

  it('should return false when not blocked', () => {
    expect(tracker.isBlocked('openai', hashApiKey('sk-test'))).toBe(false);
  });

  it('should return false after TTL expires', () => {
    vi.useFakeTimers();
    const hash = hashApiKey('sk-test');
    tracker.recordBlock('openai', hash);
    expect(tracker.isBlocked('openai', hash)).toBe(true);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(tracker.isBlocked('openai', hash)).toBe(false);
    vi.useRealTimers();
  });

  it('should clear all blocks for a provider', () => {
    const hash1 = hashApiKey('key-1');
    const hash2 = hashApiKey('key-2');
    tracker.recordBlock('openai', hash1);
    tracker.recordBlock('openai', hash2);
    tracker.recordBlock('groq', hash1);
    tracker.clear('openai');
    expect(tracker.isBlocked('openai', hash1)).toBe(false);
    expect(tracker.isBlocked('openai', hash2)).toBe(false);
    expect(tracker.isBlocked('groq', hash1)).toBe(true);
  });

  it('should clear specific block for provider + apiKeyHash', () => {
    const hash1 = hashApiKey('key-1');
    const hash2 = hashApiKey('key-2');
    tracker.recordBlock('openai', hash1);
    tracker.recordBlock('openai', hash2);
    tracker.clear('openai', hash1);
    expect(tracker.isBlocked('openai', hash1)).toBe(false);
    expect(tracker.isBlocked('openai', hash2)).toBe(true);
  });

  it('should round-trip through toJSON/fromJSON', () => {
    const hash = hashApiKey('sk-test');
    tracker.recordBlock('openai', hash);
    const json = tracker.toJSON();
    const tracker2 = new CreditBlockTracker();
    tracker2.fromJSON(json);
    expect(tracker2.isBlocked('openai', hash)).toBe(true);
  });

  it('should exclude expired entries from toJSON', () => {
    vi.useFakeTimers();
    const hash = hashApiKey('sk-test');
    tracker.recordBlock('openai', hash);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    const json = tracker.toJSON();
    expect(Object.keys(json)).toHaveLength(0);
    vi.useRealTimers();
  });

  it('should report correct size', () => {
    expect(tracker.size).toBe(0);
    tracker.recordBlock('openai', hashApiKey('k1'));
    tracker.recordBlock('groq', hashApiKey('k2'));
    expect(tracker.size).toBe(2);
  });
});
