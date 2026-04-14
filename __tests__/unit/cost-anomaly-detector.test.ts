import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCostAnomalyDetector, type CostAnomaly } from '@ai-gateway/tracking/cost-anomaly-detector';
import type { UsageLogStore } from '@ai-gateway';

describe('CostAnomalyDetector', () => {
  let usageLogStore: UsageLogStore;
  let detector: ReturnType<typeof createCostAnomalyDetector>;

  beforeEach(() => {
    usageLogStore = {
      groupByUser: vi.fn(),
      countByContext: vi.fn(),
      countInRange: vi.fn(),
      groupByModelAndRoute: vi.fn(),
      countByStage: vi.fn(),
    };

    detector = createCostAnomalyDetector(usageLogStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('detectAnomalies', () => {
    it('should return empty array when no anomalies', async () => {
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(0);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(0);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies).toEqual([]);
    });

    it('should detect high-spend users', async () => {
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([
        { userId: 'user-1', costUsd: 10.5 },
      ]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(0);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(0);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        type: 'high_spend_user',
        severity: 'critical',
        message: expect.stringContaining('user-1'),
        data: { userId: 'user-1', costUsd: 10.5 },
      });
    });

    it('should flag high spend > $5 as critical', async () => {
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([
        { userId: 'user-1', costUsd: 6.0 },
      ]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(0);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(0);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies[0].severity).toBe('critical');
    });

    it('should flag high spend <= $5 as warning', async () => {
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([
        { userId: 'user-1', costUsd: 3.0 },
      ]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(0);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(0);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies[0].severity).toBe('warning');
    });

    it('should detect background call spike', async () => {
      // Need bgToday > bgYesterday * multiplier (3 * 10 = 30)
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(31);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(10);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        type: 'background_spike',
        severity: 'warning',
        message: expect.stringContaining('31'),
        data: { today: 31, yesterday: 10 },
      });
    });

    it('should not flag spike if below threshold', async () => {
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(12);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(10);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies).toHaveLength(0);
    });

    it('should not flag spike if yesterday was zero', async () => {
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(5);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(0);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies).toHaveLength(0);
    });

    it('should detect expensive models in background', async () => {
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(0);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(0);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([
        { model: 'gpt-4o', route: '/api/background', count: 5, costUsd: 2.5 },
      ]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        type: 'expensive_model',
        severity: 'info',
        message: expect.stringContaining('gpt-4o'),
        data: { model: 'gpt-4o', route: '/api/background', count: 5, costUsd: 2.5 },
      });
    });

    it('should detect untracked realtime sessions', async () => {
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(0);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(0);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(3);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        type: 'untracked_realtime',
        severity: 'info',
        message: expect.stringContaining('3'),
        data: { count: 3 },
      });
    });

    it('should combine multiple anomaly types', async () => {
      // Need bgToday > 3 * bgYesterday for spike (3 * 10 = 30)
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([
        { userId: 'user-1', costUsd: 1.5 },
      ]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(31);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(10);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([
        { model: 'gpt-4o', route: '/api/background', count: 2, costUsd: 1.0 },
      ]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(5);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies).toHaveLength(4);
      const types = anomalies.map((a) => a.type);
      expect(types).toContain('high_spend_user');
      expect(types).toContain('background_spike');
      expect(types).toContain('expensive_model');
      expect(types).toContain('untracked_realtime');
    });

    it('should use custom config', async () => {
      const customDetector = createCostAnomalyDetector(usageLogStore, {
        highSpendThresholdUsd: 5.0,
        backgroundSpikeMultiplier: 2,
        expensiveModels: ['custom-model'],
      });

      // With multiplier=2, need 20 > 2*10 for spike
      // With threshold=5, cost of 3 won't trigger high_spend_user
      vi.mocked(usageLogStore.groupByUser).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(21);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(10);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await customDetector.detectAnomalies();

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].type).toBe('background_spike');
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(usageLogStore.groupByUser).mockRejectedValue(new Error('DB error'));
      vi.mocked(usageLogStore.countByContext).mockResolvedValue(0);
      vi.mocked(usageLogStore.countInRange).mockResolvedValue(0);
      vi.mocked(usageLogStore.groupByModelAndRoute).mockResolvedValue([]);
      vi.mocked(usageLogStore.countByStage).mockResolvedValue(0);

      const anomalies = await detector.detectAnomalies();

      expect(anomalies).toEqual([]);
    });
  });
});
