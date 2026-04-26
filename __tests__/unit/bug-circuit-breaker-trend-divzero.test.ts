/**
 * Bug: TierCircuitBreaker.analyzeLatencyTrend() / calculateLatencyStability()
 * divide by firstHalfAvg / mean without guarding against zero — when the
 * recent latency history is all zeros (e.g. fast cache-hit responses or
 * a stub that records 0ms latency), the divisor is 0 and changePercent
 * becomes NaN. Math.abs(NaN) < 0.1 is false, so the function reports
 * `trend: 'increasing'` for what is really stable, zero-latency traffic.
 * That spuriously inflates predictiveScore via latencyTrend in
 * calculatePredictiveScore and can prematurely open the circuit.
 */
import { describe, it, expect } from 'vitest';
import { TierCircuitBreaker } from '../../src/gateway/autoscaler/circuit-breaker';

class MemoryStore {
  private map = new Map<string, string>();
  async get(k: string) { return this.map.get(k) ?? null; }
  async set(k: string, v: string) { this.map.set(k, v); }
  async del(k: string) { this.map.delete(k); }
  async scan(_p: string, cb: (keys: string[]) => void) {
    const keys = [...this.map.keys()];
    if (keys.length) cb(keys);
    return keys.length;
  }
  async rpush() {} async ltrim() {} async lrange() { return []; }
  async hset() {} async hdel() {} async hgetall() { return {}; }
  async hincrby() {}
}

describe('TierCircuitBreaker — div-by-zero in latency trend analysis', () => {
  it('does not produce NaN/spurious trend when all recorded latencies are 0', async () => {
    const cb = new TierCircuitBreaker(new MemoryStore() as any);
    // Record 30 successful requests, all with 0ms latency.
    // (Realistic: cache-hit path stubbed in tests, or sub-ms responses
    // rounded down to 0.)
    for (let i = 0; i < 30; i++) {
      await cb.recordRequest(0, 0, true);
    }
    const analytics = await cb.getTierAnalytics(0);
    expect(analytics).not.toBeNull();
    // With all-zero latency we have no real signal — must NOT report
    // 'increasing'. Stable is the only honest answer.
    expect(analytics!.latencyTrends.trend).toBe('stable');
    // And the stability score must not be NaN/Infinity.
    expect(Number.isFinite(analytics!.latencyTrends.stability)).toBe(true);
  });
});
