/**
 * Tests for memory-watcher module.
 */

import { describe, it, expect } from 'vitest';
import { getMemoryStats } from '../../src/memory-watcher';

describe('MemoryWatcher', () => {
  it('should return memory stats', () => {
    const stats = getMemoryStats();
    expect(stats).toHaveProperty('rssMb');
    expect(stats).toHaveProperty('heapTotalMb');
    expect(stats).toHaveProperty('heapUsedMb');
    expect(stats).toHaveProperty('heapUsedPercent');
    expect(stats.rssMb).toBeGreaterThan(0);
  });
});
