import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveTimeoutCalculator } from '@ai-gateway/providers/adaptive-timeout';

describe('AdaptiveTimeoutCalculator', () => {
  let calc: AdaptiveTimeoutCalculator;

  beforeEach(() => {
    vi.useFakeTimers();
    calc = new AdaptiveTimeoutCalculator();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── No samples → default ──────────────────────────────────────────────────

  it('returns default timeout with no samples', () => {
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(10_000);
  });

  it('returns default timeout with fewer than minSamples', () => {
    // Record 9 samples (default minSamples = 10)
    for (let i = 0; i < 9; i++) {
      calc.record('groq', 'llama-3.1-8b', 100);
    }
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(10_000);
  });

  // ── Adaptive kicks in ─────────────────────────────────────────────────────

  it('returns p95 * margin after enough samples', () => {
    // Record 20 samples: values 100..2000 in steps of 100
    for (let i = 1; i <= 20; i++) {
      calc.record('groq', 'llama-3.1-8b', i * 100);
    }
    // p95 of [100,200,...,2000]:
    //   rank = 0.95 * 19 = 18.05
    //   sorted[18] = 1900, sorted[19] = 2000
    //   p95 = 1900 + 0.05 * (2000 - 1900) = 1905
    //   adaptive = round(1905 * 1.5) = 2858
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(2858);
  });

  it('returns p95 * custom margin', () => {
    calc = new AdaptiveTimeoutCalculator({ marginMultiplier: 2.0 });

    for (let i = 1; i <= 20; i++) {
      calc.record('groq', 'llama-3.1-8b', i * 100);
    }
    // p95 = 1905, adaptive = round(1905 * 2.0) = 3810
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(3810);
  });

  // ── min/max bounds ────────────────────────────────────────────────────────

  it('respects minTimeoutMs', () => {
    calc = new AdaptiveTimeoutCalculator({ minTimeoutMs: 5_000 });

    // All very fast samples → p95 * margin < minTimeoutMs
    for (let i = 0; i < 20; i++) {
      calc.record('groq', 'llama-3.1-8b', 50);
    }
    // p95 = 50, adaptive = round(50 * 1.5) = 75 → clamped to 5000
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(5_000);
  });

  it('respects maxTimeoutMs', () => {
    calc = new AdaptiveTimeoutCalculator({ maxTimeoutMs: 15_000 });

    // All very slow samples → p95 * margin > maxTimeoutMs
    for (let i = 0; i < 20; i++) {
      calc.record('groq', 'llama-3.1-8b', 20_000);
    }
    // p95 = 20000, adaptive = round(20000 * 1.5) = 30000 → clamped to 15000
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(15_000);
  });

  it('uses default minTimeoutMs of 2000', () => {
    // All very fast samples
    for (let i = 0; i < 20; i++) {
      calc.record('groq', 'llama-3.1-8b', 10);
    }
    // p95 = 10, adaptive = round(10 * 1.5) = 15 → clamped to 2000
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(2_000);
  });

  it('uses default maxTimeoutMs of 30000', () => {
    for (let i = 0; i < 20; i++) {
      calc.record('groq', 'llama-3.1-8b', 50_000);
    }
    // p95 = 50000, adaptive = round(50000 * 1.5) = 75000 → clamped to 30000
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(30_000);
  });

  // ── Time-based eviction ───────────────────────────────────────────────────

  it('evicts samples older than windowMs', () => {
    // Record 15 samples (enough for adaptive)
    for (let i = 0; i < 15; i++) {
      calc.record('groq', 'llama-3.1-8b', 500);
    }
    // Adaptive should be active
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).not.toBe(10_000);

    // Advance time past window (default 10 min)
    vi.advanceTimersByTime(600_001);

    // All samples expired → falls back to default
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(10_000);
  });

  it('evicts old samples while keeping recent ones', () => {
    // Record 10 old samples with high latency
    for (let i = 0; i < 10; i++) {
      calc.record('groq', 'llama-3.1-8b', 5_000);
    }

    // Advance 9 minutes (still within window)
    vi.advanceTimersByTime(9 * 60 * 1000);

    // Record 10 new samples with low latency
    for (let i = 0; i < 10; i++) {
      calc.record('groq', 'llama-3.1-8b', 200);
    }

    // Advance another 2 minutes → old samples expire (11 min total), new ones (2 min old) remain
    vi.advanceTimersByTime(2 * 60 * 1000);

    // Only 10 recent samples remain (200ms each)
    // p95 = 200, adaptive = round(200 * 1.5) = 300 → clamped to minTimeout 2000
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(2_000);
  });

  it('uses custom windowMs', () => {
    calc = new AdaptiveTimeoutCalculator({ windowMs: 60_000 }); // 1 minute

    for (let i = 0; i < 15; i++) {
      calc.record('groq', 'llama-3.1-8b', 500);
    }

    // Advance past custom window
    vi.advanceTimersByTime(60_001);

    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(10_000);
  });

  // ── Provider/model isolation ──────────────────────────────────────────────

  it('isolates different providers', () => {
    for (let i = 0; i < 15; i++) {
      calc.record('groq', 'llama-3.1-8b', 500);
    }

    // Different provider has no samples → returns default
    expect(calc.getTimeout('openai', 'llama-3.1-8b', 10_000)).toBe(10_000);
  });

  it('isolates different models on same provider', () => {
    for (let i = 0; i < 15; i++) {
      calc.record('groq', 'llama-3.1-8b', 500);
    }

    // Different model has no samples → returns default
    expect(calc.getTimeout('groq', 'gpt-4o', 10_000)).toBe(10_000);
  });

  // ── Circular buffer ───────────────────────────────────────────────────────

  it('caps buffer at MAX_BUFFER_SIZE (200)', () => {
    for (let i = 0; i < 300; i++) {
      calc.record('groq', 'llama-3.1-8b', 100 + i);
    }

    // sampleCount should be capped at 200
    expect(calc.sampleCount('groq', 'llama-3.1-8b')).toBe(200);
  });

  // ── sampleCount helper ────────────────────────────────────────────────────

  it('reports correct sample count', () => {
    expect(calc.sampleCount('groq', 'llama-3.1-8b')).toBe(0);

    calc.record('groq', 'llama-3.1-8b', 100);
    calc.record('groq', 'llama-3.1-8b', 200);

    expect(calc.sampleCount('groq', 'llama-3.1-8b')).toBe(2);
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  it('clear removes all samples', () => {
    for (let i = 0; i < 15; i++) {
      calc.record('groq', 'llama-3.1-8b', 500);
    }

    calc.clear();

    expect(calc.sampleCount('groq', 'llama-3.1-8b')).toBe(0);
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(10_000);
  });

  // ── Custom minSamples ─────────────────────────────────────────────────────

  it('uses custom minSamples threshold', () => {
    calc = new AdaptiveTimeoutCalculator({ minSamples: 5 });

    // Record 4 samples (not enough)
    for (let i = 0; i < 4; i++) {
      calc.record('groq', 'llama-3.1-8b', 500);
    }
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(10_000);

    // Record 1 more → hits threshold of 5
    calc.record('groq', 'llama-3.1-8b', 500);
    // p95 of five 500s = 500, adaptive = round(500 * 1.5) = 750 → clamped to 2000
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(2_000);
  });

  // ── Edge case: single distinct value ──────────────────────────────────────

  it('handles uniform latency samples', () => {
    for (let i = 0; i < 20; i++) {
      calc.record('groq', 'llama-3.1-8b', 1_000);
    }
    // p95 of twenty 1000s = 1000, adaptive = round(1000 * 1.5) = 1500 → clamped to 2000
    expect(calc.getTimeout('groq', 'llama-3.1-8b', 10_000)).toBe(2_000);
  });
});
