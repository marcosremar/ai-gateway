/**
 * Tests for metrics-collector module.
 */

import { describe, it, expect } from 'vitest';
import { metrics, METRICS } from '../../src/metrics-collector';

describe('MetricsCollector', () => {
  it('should increment counters', () => {
    metrics.increment('test.counter');
    expect(metrics.getCounter('test.counter')).toBeGreaterThan(0);
  });

  it('should set gauges', () => {
    metrics.gauge('test.gauge', 42);
    expect(metrics.getGauge('test.gauge')).toBe(42);
  });

  it('should record histograms', () => {
    metrics.histogram('test.histogram', 100);
    metrics.histogram('test.histogram', 200);

    const stats = metrics.getHistogramStats('test.histogram');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(2);
    expect(stats!.avg).toBe(150);
  });

  it('should calculate percentiles', () => {
    for (let i = 1; i <= 100; i++) {
      metrics.histogram('test.percentiles', i);
    }

    const stats = metrics.getHistogramStats('test.percentiles');
    expect(stats).not.toBeNull();
    expect(stats!.p50).toBeGreaterThanOrEqual(49);
    expect(stats!.p50).toBeLessThanOrEqual(51);
    expect(stats!.p95).toBeGreaterThanOrEqual(94);
    expect(stats!.p99).toBeGreaterThanOrEqual(98);
  });

  it('should export Prometheus format', () => {
    metrics.increment('prom.test', {}, 5);
    metrics.gauge('prom.gauge', 100);

    const prometheus = metrics.exportPrometheus();
    expect(typeof prometheus).toBe('string');
    expect(prometheus.length).toBeGreaterThan(0);
  });

  it('should reset all metrics', () => {
    metrics.increment('reset.test');
    metrics.gauge('reset.gauge', 42);
    metrics.histogram('reset.histogram', 100);

    metrics.reset();

    expect(metrics.getCounter('reset.test')).toBe(0);
    expect(metrics.getGauge('reset.gauge')).toBeUndefined();
    expect(metrics.getHistogramStats('reset.histogram')).toBeNull();
  });
});

describe('METRICS', () => {
  it('should have all standard metric names', () => {
    expect(METRICS.REQUESTS_TOTAL).toBe('http_requests_total');
    expect(METRICS.REQUEST_DURATION_MS).toBe('http_request_duration_ms');
    expect(METRICS.PROVIDER_CALLS_TOTAL).toBe('provider_calls_total');
    expect(METRICS.GPU_INSTANCES_ACTIVE).toBe('gpu_instances_active');
    expect(METRICS.COST_TOTAL_USD).toBe('cost_total_usd');
  });
});
