import { describe, it, expect } from 'vitest';
import { determineDegradation } from '@ai-gateway/autoscaler/degradation-manager';
import type { DegradationSignals, DegradationPolicy } from '@ai-gateway/autoscaler/degradation-manager';
import type { CircuitState } from '@ai-gateway/autoscaler/circuit-breaker';

function makeSignals(overrides: Partial<DegradationSignals> = {}): DegradationSignals {
  return {
    queueDepth: 0,
    p95LatencyMs: null,
    circuitStates: new Map(),
    readyTiers: 2,
    activeSessions: 1,
    ...overrides,
  };
}

describe('determineDegradation', () => {
  it('returns "full" under normal conditions', () => {
    expect(determineDegradation(makeSignals())).toBe('full');
  });

  it('returns "full" when all metrics are below thresholds', () => {
    expect(determineDegradation(makeSignals({
      queueDepth: 3,
      p95LatencyMs: 500,
    }))).toBe('full');
  });

  // ── Reduced level ──

  it('returns "reduced" when queueDepth >= reducedWhenQueueDepth (8)', () => {
    expect(determineDegradation(makeSignals({ queueDepth: 8 }))).toBe('reduced');
  });

  it('returns "reduced" when p95 >= reducedWhenP95Ms (2000)', () => {
    expect(determineDegradation(makeSignals({ p95LatencyMs: 2000 }))).toBe('reduced');
  });

  it('returns "reduced" just below cloud thresholds', () => {
    expect(determineDegradation(makeSignals({ queueDepth: 14 }))).toBe('reduced');
    expect(determineDegradation(makeSignals({ p95LatencyMs: 3999 }))).toBe('reduced');
  });

  // ── Cloud level ──

  it('returns "cloud" when queueDepth >= cloudWhenQueueDepth (15)', () => {
    expect(determineDegradation(makeSignals({ queueDepth: 15 }))).toBe('cloud');
  });

  it('returns "cloud" when p95 >= cloudWhenP95Ms (4000)', () => {
    expect(determineDegradation(makeSignals({ p95LatencyMs: 4000 }))).toBe('cloud');
  });

  it('returns "cloud" when all circuits are open', () => {
    const circuits = new Map<number, CircuitState>([[0, 'open'], [1, 'open']]);
    expect(determineDegradation(makeSignals({ circuitStates: circuits }))).toBe('cloud');
  });

  it('does not return "cloud" for circuits when only some are open', () => {
    const circuits = new Map<number, CircuitState>([[0, 'open'], [1, 'closed']]);
    expect(determineDegradation(makeSignals({ circuitStates: circuits }))).toBe('full');
  });

  // ── Minimal level ──

  it('returns "minimal" when all circuits open AND no ready tiers', () => {
    const circuits = new Map<number, CircuitState>([[0, 'open'], [1, 'open']]);
    expect(determineDegradation(makeSignals({
      circuitStates: circuits,
      readyTiers: 0,
    }))).toBe('minimal');
  });

  it('returns "cloud" (not minimal) when all circuits open but tiers are ready', () => {
    const circuits = new Map<number, CircuitState>([[0, 'open']]);
    expect(determineDegradation(makeSignals({
      circuitStates: circuits,
      readyTiers: 1,
    }))).toBe('cloud');
  });

  // ── Custom policy ──

  it('respects custom policy thresholds', () => {
    const policy: DegradationPolicy = {
      reducedWhenQueueDepth: 2,
      cloudWhenQueueDepth: 5,
    };
    expect(determineDegradation(makeSignals({ queueDepth: 2 }), policy)).toBe('reduced');
    expect(determineDegradation(makeSignals({ queueDepth: 5 }), policy)).toBe('cloud');
    expect(determineDegradation(makeSignals({ queueDepth: 1 }), policy)).toBe('full');
  });

  it('respects cloudWhenAllCircuitsOpen=false', () => {
    const circuits = new Map<number, CircuitState>([[0, 'open']]);
    expect(determineDegradation(
      makeSignals({ circuitStates: circuits }),
      { cloudWhenAllCircuitsOpen: false },
    )).toBe('full');
  });

  it('respects minimalWhenNoProviders=false', () => {
    const circuits = new Map<number, CircuitState>([[0, 'open']]);
    expect(determineDegradation(
      makeSignals({ circuitStates: circuits, readyTiers: 0 }),
      { minimalWhenNoProviders: false, cloudWhenAllCircuitsOpen: true },
    )).toBe('cloud'); // falls through to cloud check instead
  });

  // ── Edge cases ──

  it('handles empty circuit states map', () => {
    expect(determineDegradation(makeSignals({ circuitStates: new Map() }))).toBe('full');
  });

  it('handles null p95 latency', () => {
    expect(determineDegradation(makeSignals({ p95LatencyMs: null }))).toBe('full');
  });

  it('worst signal wins (queue high + latency ok)', () => {
    expect(determineDegradation(makeSignals({
      queueDepth: 15,
      p95LatencyMs: 100,
    }))).toBe('cloud');
  });
});
