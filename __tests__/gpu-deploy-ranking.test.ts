import { describe, it, expect } from 'vitest';

describe('GPU offer ranking — balanced scoring', () => {
  // Test the tcpLatencyScore formula
  const tcpLatencyScore = (ms: number | null): number => {
    if (ms == null) return 0.5;
    return Math.max(0, Math.min(1, 1 - (ms - 30) / 270));
  };

  // Test the quality score formula
  const qualityScore = (repScore: number, tcpScore: number): number => {
    return Math.max(repScore * 0.6 + tcpScore * 0.4, 0.1);
  };

  // Test the effective price formula
  const effectivePrice = (pricePerHr: number, quality: number): number => {
    return pricePerHr / quality;
  };

  describe('tcpLatencyScore', () => {
    it('returns 1.0 for latency <= 30ms', () => {
      expect(tcpLatencyScore(0)).toBeCloseTo(1.0);
      expect(tcpLatencyScore(30)).toBeCloseTo(1.0);
    });

    it('returns ~0.5 for latency ~150ms', () => {
      expect(tcpLatencyScore(150)).toBeCloseTo(0.556, 2); // 1 - (150-30)/270 = 0.556
    });

    it('returns 0.0 for latency >= 300ms', () => {
      expect(tcpLatencyScore(300)).toBeCloseTo(0.0);
      expect(tcpLatencyScore(500)).toBe(0.0);
    });

    it('returns 0.5 for null (unknown) latency', () => {
      expect(tcpLatencyScore(null)).toBe(0.5);
    });

    it('clamps between 0 and 1', () => {
      expect(tcpLatencyScore(1000)).toBe(0.0);
      expect(tcpLatencyScore(-100)).toBe(1.0); // would be > 1, clamped
    });
  });

  describe('qualityScore', () => {
    it('combines reputation (60%) and TCP latency (40%)', () => {
      // Perfect scores
      expect(qualityScore(1.0, 1.0)).toBeCloseTo(1.0);
      // Zero scores → floor at 0.1
      expect(qualityScore(0, 0)).toBe(0.1);
      // Mixed
      expect(qualityScore(0.8, 0.5)).toBeCloseTo(0.68); // 0.8*0.6 + 0.5*0.4 = 0.68
    });

    it('floors at 0.1 to prevent division by zero', () => {
      expect(qualityScore(0, 0)).toBe(0.1);
      expect(qualityScore(0.05, 0.05)).toBe(0.1); // 0.05*0.6 + 0.05*0.4 = 0.05 → clamped to 0.1
    });
  });

  describe('effectivePrice', () => {
    it('divides price by quality — lower is better', () => {
      expect(effectivePrice(1.0, 1.0)).toBe(1.0);
      expect(effectivePrice(1.0, 0.5)).toBe(2.0);
      expect(effectivePrice(0.5, 1.0)).toBe(0.5);
    });
  });

  describe('balanced sort — integration', () => {
    interface MockOffer {
      gpuName: string;
      pricePerHr: number;
      repScore: number;
      latencyMs: number | null;
    }

    function sortBalanced(offers: MockOffer[]): MockOffer[] {
      return [...offers].sort((a, b) => {
        const tcpA = tcpLatencyScore(a.latencyMs);
        const tcpB = tcpLatencyScore(b.latencyMs);
        const qA = qualityScore(a.repScore, tcpA);
        const qB = qualityScore(b.repScore, tcpB);
        return (a.pricePerHr / qA) - (b.pricePerHr / qB);
      });
    }

    it('prefers cheap + high quality over expensive + high quality', () => {
      const offers: MockOffer[] = [
        { gpuName: 'Expensive', pricePerHr: 2.0, repScore: 0.9, latencyMs: 50 },
        { gpuName: 'Cheap', pricePerHr: 0.5, repScore: 0.9, latencyMs: 50 },
      ];
      const sorted = sortBalanced(offers);
      expect(sorted[0].gpuName).toBe('Cheap');
    });

    it('prefers high quality over low quality at same price', () => {
      const offers: MockOffer[] = [
        { gpuName: 'BadRep', pricePerHr: 1.0, repScore: 0.2, latencyMs: 200 },
        { gpuName: 'GoodRep', pricePerHr: 1.0, repScore: 0.9, latencyMs: 30 },
      ];
      const sorted = sortBalanced(offers);
      expect(sorted[0].gpuName).toBe('GoodRep');
    });

    it('a slightly more expensive offer with much better quality wins', () => {
      const offers: MockOffer[] = [
        { gpuName: 'Cheap+Bad', pricePerHr: 0.50, repScore: 0.1, latencyMs: 300 },
        { gpuName: 'Pricey+Good', pricePerHr: 0.80, repScore: 0.9, latencyMs: 20 },
      ];
      const sorted = sortBalanced(offers);
      expect(sorted[0].gpuName).toBe('Pricey+Good');
    });

    it('unknown latency (null) gets neutral 0.5 score', () => {
      const offers: MockOffer[] = [
        { gpuName: 'Unknown', pricePerHr: 1.0, repScore: 0.8, latencyMs: null },
        { gpuName: 'Known', pricePerHr: 1.0, repScore: 0.8, latencyMs: 30 },
      ];
      const sorted = sortBalanced(offers);
      // Known (tcp=1.0) beats Unknown (tcp=0.5) at same price and rep
      expect(sorted[0].gpuName).toBe('Known');
    });
  });
});
