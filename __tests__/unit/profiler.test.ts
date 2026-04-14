/**
 * Tests for profiler module.
 */

import { describe, it, expect } from 'vitest';
import { getMemoryStats, getCpuUsage } from '../../src/profiler';

describe('Profiler', () => {
  it('should get memory stats', () => {
    const stats = getMemoryStats();
    expect(stats).toHaveProperty('rss');
    expect(stats).toHaveProperty('heapTotal');
    expect(stats).toHaveProperty('heapUsed');
    expect(stats.rss).toBeGreaterThan(0);
  });

  it('should get CPU usage', () => {
    const usage = getCpuUsage();
    expect(usage).toHaveProperty('userMs');
    expect(usage).toHaveProperty('systemMs');
    expect(usage).toHaveProperty('totalMs');
  });
});
