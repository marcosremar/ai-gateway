import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashApiKey, CreditBlockTracker } from '@ai-gateway/providers/credit-block';

describe('hashApiKey', () => {
  it('returns consistent hash for same input', () => {
    expect(hashApiKey('sk-abc123')).toBe(hashApiKey('sk-abc123'));
  });

  it('returns 32-character hex string', () => {
    const hash = hashApiKey('test-key');
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces different hashes for different keys', () => {
    expect(hashApiKey('key-1')).not.toBe(hashApiKey('key-2'));
  });
});

describe('CreditBlockTracker', () => {
  let tracker: CreditBlockTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new CreditBlockTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not blocked initially', () => {
    expect(tracker.isBlocked('openai', 'abc')).toBe(false);
  });

  it('blocks after recordBlock', () => {
    tracker.recordBlock('openai', 'abc');
    expect(tracker.isBlocked('openai', 'abc')).toBe(true);
  });

  it('expires after TTL (5 minutes)', () => {
    tracker.recordBlock('openai', 'abc');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(tracker.isBlocked('openai', 'abc')).toBe(false);
  });

  it('does not expire before TTL', () => {
    tracker.recordBlock('openai', 'abc');
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(tracker.isBlocked('openai', 'abc')).toBe(true);
  });

  it('isolates different providers', () => {
    tracker.recordBlock('openai', 'abc');
    expect(tracker.isBlocked('groq', 'abc')).toBe(false);
  });

  it('isolates different API key hashes', () => {
    tracker.recordBlock('openai', 'abc');
    expect(tracker.isBlocked('openai', 'xyz')).toBe(false);
  });

  it('clear removes specific provider:key block', () => {
    tracker.recordBlock('openai', 'abc');
    tracker.recordBlock('openai', 'xyz');
    tracker.clear('openai', 'abc');
    expect(tracker.isBlocked('openai', 'abc')).toBe(false);
    expect(tracker.isBlocked('openai', 'xyz')).toBe(true);
  });

  it('clear without apiKeyHash removes all blocks for provider', () => {
    tracker.recordBlock('openai', 'abc');
    tracker.recordBlock('openai', 'xyz');
    tracker.recordBlock('groq', 'abc');
    tracker.clear('openai');
    expect(tracker.isBlocked('openai', 'abc')).toBe(false);
    expect(tracker.isBlocked('openai', 'xyz')).toBe(false);
    expect(tracker.isBlocked('groq', 'abc')).toBe(true);
  });

  it('reports correct size', () => {
    expect(tracker.size).toBe(0);
    tracker.recordBlock('openai', 'abc');
    tracker.recordBlock('groq', 'xyz');
    expect(tracker.size).toBe(2);
  });
});
