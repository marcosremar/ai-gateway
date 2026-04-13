/**
 * Integration tests for the adaptive pull timeout estimator.
 *
 * Tests the full learning lifecycle:
 *   0 observations → generous 30 min timeout
 *   1-9 observations → learning phase (2× max seen)
 *   10+ observations → data-driven (avg × 1.3)
 *   Host-specific → tightest (3+ runs on same host)
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

// Reset module state between tests
let estimatePullTimeout: typeof import('../../src/gpu-providers/pull-time-estimator').estimatePullTimeout;
let recordPullTime: typeof import('../../src/gpu-providers/pull-time-estimator').recordPullTime;
let getObservationCount: typeof import('../../src/gpu-providers/pull-time-estimator').getObservationCount;
let deriveHostKey: typeof import('../../src/gpu-providers/pull-time-estimator').deriveHostKey;

describe('Pull Time Estimator', () => {
  beforeEach(async () => {
    // Re-import to get fresh module (vitest module caching)
    const mod = await import('../../src/gpu-providers/pull-time-estimator');
    estimatePullTimeout = mod.estimatePullTimeout;
    recordPullTime = mod.recordPullTime;
    getObservationCount = mod.getObservationCount;
    deriveHostKey = mod.deriveHostKey;
  });

  describe('deriveHostKey', () => {
    it('uses machineId when available', () => {
      expect(deriveHostKey('vast', { machineId: 'abc123' })).toBe('vast:abc123');
    });

    it('falls back to IP', () => {
      expect(deriveHostKey('vast', { public_ipaddr: '1.2.3.4' })).toBe('vast:1.2.3.4');
    });

    it('returns unknown when no identifying info', () => {
      expect(deriveHostKey('vast', {})).toBe('vast:unknown');
      expect(deriveHostKey('vast')).toBe('vast:unknown');
    });
  });

  describe('estimatePullTimeout — no history', () => {
    it('returns generous timeout for unknown image (30 min)', async () => {
      const est = await estimatePullTimeout({
        dockerImage: 'totally-unknown-image:latest',
        inetDownMbps: 500,
      });
      expect(est.confidence).toBe('default');
      expect(est.timeoutMs).toBe(1_800_000); // 30 min
      expect(est.basis).toContain('NO DATA');
      expect(est.basis).toContain('30 min');
    });

    it('calculates from compressed size when image exists on Docker Hub', async () => {
      // This test hits Docker Hub — use a small well-known image
      const est = await estimatePullTimeout({
        dockerImage: 'alpine:latest',
        inetDownMbps: 1000,
      });
      // Alpine is tiny (~3MB compressed), so timeout should be the minimum floor
      if (est.confidence === 'calculated') {
        expect(est.timeoutMs).toBeGreaterThanOrEqual(120_000); // min floor 2 min
        expect(est.basis).toContain('FIRST RUN');
      }
      // If Docker Hub is unreachable, falls back to default
    });
  });

  describe('estimatePullTimeout — learning phase', () => {
    it('uses generous timeout with 1-9 observations', async () => {
      const image = 'test-image-learning:v1';

      // Record 5 observations
      for (let i = 0; i < 5; i++) {
        recordPullTime(image, 120 + i * 10, 500, `vast:host-${i}`, 300);
      }

      expect(getObservationCount(image)).toBe(5);

      const est = await estimatePullTimeout({
        dockerImage: image,
        inetDownMbps: 500,
      });

      expect(est.confidence).toBe('calculated');
      expect(est.basis).toContain('5/10 observations');
      expect(est.basis).toContain('learning');
      // Should use max_seen × 2.0 — max is 160s, so timeout ≥ 320s
      expect(est.timeoutMs).toBeGreaterThanOrEqual(320_000);
    });
  });

  describe('estimatePullTimeout — data-driven (≥10 observations)', () => {
    it('uses avg × 1.3 with 10+ observations', async () => {
      const image = 'test-image-mature:v1';

      // Record 12 observations averaging ~100s
      for (let i = 0; i < 12; i++) {
        recordPullTime(image, 90 + i * 2, 500, `vast:host-${i % 3}`, 200);
      }

      expect(getObservationCount(image)).toBe(12);

      const est = await estimatePullTimeout({
        dockerImage: image,
        inetDownMbps: 500,
      });

      expect(est.confidence).toBe('historical');
      expect(est.basis).toContain('12 observations');
      // Avg is about 101s, × 1.3 = ~131s, but min floor is 120s (2 min)
      expect(est.timeoutMs).toBeGreaterThanOrEqual(120_000);
      expect(est.timeoutMs).toBeLessThan(300_000); // should be well under 5 min
    });

    it('adjusts for host speed when slower than average', async () => {
      const image = 'test-image-speed-adj:v1';

      // Record 10 observations at 1000 Mbps averaging 60s
      for (let i = 0; i < 10; i++) {
        recordPullTime(image, 55 + i, 1000, `vast:fast-host`, 120);
      }

      // Now estimate for a slower host (500 Mbps)
      const est = await estimatePullTimeout({
        dockerImage: image,
        inetDownMbps: 500,
      });

      // speedRatio = 1000/500 = 2, so adjusted ≈ 60s × 2 = 120s
      // timeout = 120 × 1.3 = 156s → clamp to min 120s
      expect(est.estimatedPullS).toBeGreaterThan(100); // adjusted for slower speed
      expect(est.confidence).toBe('historical');
    });
  });

  describe('estimatePullTimeout — host-specific history', () => {
    it('uses host-specific avg × 1.3 with 3+ observations on same host', async () => {
      const image = 'test-image-host-specific:v1';
      const hostKey = 'vast:same-machine-123';

      // Record 15 observations across different hosts
      for (let i = 0; i < 15; i++) {
        recordPullTime(image, 200 + i * 5, 500, `vast:host-${i}`, 400);
      }

      // Record 4 observations on our specific host — faster machine
      for (let i = 0; i < 4; i++) {
        recordPullTime(image, 50 + i * 2, 1000, hostKey, 100);
      }

      const est = await estimatePullTimeout({
        dockerImage: image,
        inetDownMbps: 1000,
        hostKey,
      });

      // Should use host-specific avg (~54s) × 1.3 = ~70s
      expect(est.confidence).toBe('historical');
      expect(est.basis).toContain(hostKey);
      expect(est.estimatedPullS).toBeLessThan(80); // host-specific is faster
    });
  });

  describe('getObservationCount', () => {
    it('counts per image', () => {
      recordPullTime('img-a:v1', 100, 500, 'host-1');
      recordPullTime('img-a:v1', 110, 500, 'host-2');
      recordPullTime('img-b:v1', 200, 500, 'host-1');

      expect(getObservationCount('img-a:v1')).toBe(2);
      expect(getObservationCount('img-b:v1')).toBe(1);
      expect(getObservationCount('img-c:v1')).toBe(0);
    });

    it('counts per image+host', () => {
      recordPullTime('img-d:v1', 100, 500, 'host-x');
      recordPullTime('img-d:v1', 110, 500, 'host-x');
      recordPullTime('img-d:v1', 200, 500, 'host-y');

      expect(getObservationCount('img-d:v1', 'host-x')).toBe(2);
      expect(getObservationCount('img-d:v1', 'host-y')).toBe(1);
    });
  });

  describe('recordPullTime — edge cases', () => {
    it('handles missing optional fields', () => {
      // Should not throw
      recordPullTime('img-e:v1', 100);
      expect(getObservationCount('img-e:v1')).toBeGreaterThan(0);
    });

    it('trims history beyond MAX_HISTORY', () => {
      for (let i = 0; i < 600; i++) {
        recordPullTime(`flood-image:v${i}`, 10, 500, `host-${i}`);
      }
      // pullHistory should be capped at 500
      // We can't directly access the private array, but we can verify
      // that old entries are gone by checking observation count
      expect(getObservationCount('flood-image:v0')).toBe(0); // trimmed
      expect(getObservationCount('flood-image:v599')).toBe(1); // still there
    });
  });
});

describe('Pull Time Learning — Gateway Integration', () => {
  let gatewayAvailable = false;

  beforeAll(async () => {
    try {
      const res = await fetch('http://localhost:4000/v1/gpu/latency/settings', {
        signal: AbortSignal.timeout(2000),
      });
      gatewayAvailable = res.ok;
    } catch {
      gatewayAvailable = false;
    }
  });

  it('GET /v1/gpu/latency/settings returns pullTimeLearning', async () => {
    if (!gatewayAvailable) return;
    const res = await fetch('http://localhost:4000/v1/gpu/latency/settings');
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, unknown>;

    expect(data).toHaveProperty('pullTimeLearning');
    const ptl = data.pullTimeLearning as Record<string, unknown>;
    expect(ptl).toHaveProperty('description');
    expect(ptl).toHaveProperty('images');

    const images = ptl.images as Record<string, unknown>;
    // Should have at least one known image
    const imageKeys = Object.keys(images);
    expect(imageKeys.length).toBeGreaterThan(0);

    // Each image should have the required fields
    for (const [img, info] of Object.entries(images)) {
      const data = info as Record<string, unknown>;
      expect(data).toHaveProperty('observations');
      expect(data).toHaveProperty('phase');
      expect(data).toHaveProperty('confidence');
      expect(data).toHaveProperty('timeoutSec');
      expect(data).toHaveProperty('basis');
      expect(['no-data', 'learning', 'data-driven']).toContain(data.phase);
      expect(data.timeoutSec).toBeGreaterThanOrEqual(120); // min floor
    }
  });

  it('prewarm cached known image sizes on startup', async () => {
    if (!gatewayAvailable) return;
    const res = await fetch('http://localhost:4000/v1/gpu/latency/settings');
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, unknown>;
    const ptl = data.pullTimeLearning as Record<string, unknown>;
    const images = ptl.images as Record<string, Record<string, unknown>>;

    // Images with known Docker Hub presence should have 'calculated' confidence
    const groq = images['marcosremar/babelcast-groq:latest'];
    if (groq) {
      // Should be 'calculated' (from Docker Hub size) or 'no-data' if Hub unreachable
      expect(['calculated', 'default']).toContain(groq.confidence);
      expect(groq.observations).toBe(0); // no deploys yet this session
    }
  });
});
