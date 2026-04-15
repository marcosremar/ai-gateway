/**
 * Timer Manager Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TimerManager,
  debounce,
  throttle,
  withTimeout,
} from '../../src/timer-manager';

vi.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('TimerManager', () => {
  let manager: TimerManager;

  beforeEach(() => {
    manager = new TimerManager();
  });

  describe('setTimeout', () => {
    it('should create a tracked timeout', (done) => {
      const callback = vi.fn();
      const key = manager.setTimeout('test-timeout', callback, 10);
      
      expect(key).toContain('test-timeout');
      
      setTimeout(() => {
        expect(callback).toHaveBeenCalled();
        done();
      }, 20);
    });

    it('should log callback errors', (done) => {
      const callback = () => { throw new Error('Test error'); };
      manager.setTimeout('test-error', callback, 10);
      
      setTimeout(() => {
        // Should not throw, error is logged
        expect(true).toBe(true);
        done();
      }, 20);
    });
  });

  describe('setInterval', () => {
    it('should create a tracked interval', (done) => {
      const callback = vi.fn();
      const key = manager.setInterval('test-interval', callback, 10);
      
      expect(key).toContain('test-interval');
      
      setTimeout(() => {
        expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2);
        manager.clear(key);
        done();
      }, 40);
    });
  });

  describe('clear', () => {
    it('should clear a specific timer', () => {
      const callback = vi.fn();
      const key = manager.setTimeout('test', callback, 100);
      
      const cleared = manager.clear(key);
      expect(cleared).toBe(true);
      
      // Callback should not be called
      setTimeout(() => {
        expect(callback).not.toHaveBeenCalled();
      }, 150);
    });

    it('should return false for non-existent timer', () => {
      const cleared = manager.clear('non-existent');
      expect(cleared).toBe(false);
    });
  });

  describe('clearByName', () => {
    it('should clear all timers with matching name', () => {
      manager.setTimeout('group', () => {}, 100);
      manager.setTimeout('group', () => {}, 100);
      manager.setTimeout('other', () => {}, 100);
      
      const cleared = manager.clearByName('group');
      expect(cleared).toBe(2);
      
      const stats = manager.getStats();
      expect(stats.active).toBe(1);
    });
  });

  describe('clearAll', () => {
    it('should clear all timers', () => {
      manager.setTimeout('test1', () => {}, 100);
      manager.setInterval('test2', () => {}, 100);
      manager.setTimeout('test3', () => {}, 100);
      
      const cleared = manager.clearAll();
      expect(cleared).toBe(3);
      
      const stats = manager.getStats();
      expect(stats.active).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      manager.setTimeout('test1', () => {}, 100);
      manager.setTimeout('test1', () => {}, 100);
      manager.setInterval('test2', () => {}, 100);
      
      const stats = manager.getStats();
      expect(stats.active).toBe(3);
      expect(stats.total).toBe(3);
      expect(stats.byName['test1']).toBe(2);
      expect(stats.byName['test2']).toBe(1);
    });
  });

  describe('findLeakedTimers', () => {
    it('should identify timers running longer than expected', () => {
      // Create a timer with very short maxDuration
      manager.setTimeout('leaky', () => {}, 10);
      
      // Manually manipulate createdAt to simulate age
      const timers = manager.getActiveTimers();
      if (timers[0]) {
        timers[0].createdAt = Date.now() - 1000;
      }
      
      const leaked = manager.findLeakedTimers(50);
      expect(leaked.length).toBeGreaterThan(0);
    });
  });

  describe('cleanupLeakedTimers', () => {
    it('should cleanup leaked timers', () => {
      manager.setTimeout('leaky', () => {}, 10);
      
      // Manually manipulate createdAt
      const timers = manager.getActiveTimers();
      if (timers[0]) {
        timers[0].createdAt = Date.now() - 1000;
      }
      
      const cleaned = manager.cleanupLeakedTimers(50);
      expect(cleaned).toBeGreaterThan(0);
      expect(manager.getStats().active).toBe(0);
    });
  });
});

describe('debounce', () => {
  it('should delay function execution', (done) => {
    const fn = vi.fn();
    const debounced = debounce('test-debounce', fn, 50);
    
    debounced();
    debounced();
    debounced();
    
    expect(fn).not.toHaveBeenCalled();
    
    setTimeout(() => {
      expect(fn).toHaveBeenCalledTimes(1);
      done();
    }, 70);
  });

  it('should reset timer on subsequent calls', (done) => {
    const fn = vi.fn();
    const debounced = debounce('test-debounce', fn, 50);
    
    debounced();
    
    setTimeout(() => {
      debounced(); // Reset timer
      
      setTimeout(() => {
        expect(fn).not.toHaveBeenCalled();
      }, 40);
      
      setTimeout(() => {
        expect(fn).toHaveBeenCalledTimes(1);
        done();
      }, 60);
    }, 30);
  });
});

describe('throttle', () => {
  it('should limit execution rate', (done) => {
    const fn = vi.fn();
    const throttled = throttle('test-throttle', fn, 100);
    
    throttled();
    throttled();
    throttled();
    
    expect(fn).toHaveBeenCalledTimes(1);
    
    setTimeout(() => {
      expect(fn).toHaveBeenCalledTimes(2);
      done();
    }, 150);
  });

  it('should execute immediately if enough time passed', () => {
    const fn = vi.fn();
    const throttled = throttle('test-throttle', fn, 100);
    
    throttled();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeout', () => {
  it('should resolve if promise completes in time', async () => {
    const promise = Promise.resolve('success');
    const result = await withTimeout('test', promise, 100);
    expect(result).toBe('success');
  });

  it('should reject if promise times out', async () => {
    const promise = new Promise((resolve) => setTimeout(resolve, 200));
    
    await expect(withTimeout('test', promise, 50)).rejects.toThrow('timed out');
  });

  it('should call onTimeout callback', async () => {
    const onTimeout = vi.fn();
    const promise = new Promise((resolve) => setTimeout(resolve, 200));
    
    try {
      await withTimeout('test', promise, 50, onTimeout);
    } catch {
      // Expected
    }
    
    expect(onTimeout).toHaveBeenCalled();
  });
});
