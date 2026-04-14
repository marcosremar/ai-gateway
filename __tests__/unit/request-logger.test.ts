/**
 * Tests for request-logger module.
 */

import { describe, it, expect, vi } from 'vitest';
import { requestLogger } from '../../src/request-logger';

describe('RequestLogger', () => {
  it('should log requests', () => {
    requestLogger.log({
      requestId: 'test-1',
      method: 'POST',
      path: '/v1/chat',
      userId: 'user-1',
    });

    const recent = requestLogger.getRecent(10);
    expect(recent.length).toBeGreaterThan(0);
  });

  it('should log responses', () => {
    requestLogger.log({
      requestId: 'test-2',
      method: 'POST',
      path: '/v1/chat',
    });

    requestLogger.logResponse({
      requestId: 'test-2',
      statusCode: 200,
      durationMs: 234,
    });

    const entry = requestLogger.getById('test-2');
    expect(entry).toBeDefined();
    expect(entry?.statusCode).toBe(200);
    expect(entry?.durationMs).toBe(234);
  });

  it('should filter by user', () => {
    requestLogger.log({
      requestId: 'test-3',
      method: 'GET',
      path: '/health',
      userId: 'user-a',
    });

    const userA = requestLogger.getRecent(10, { userId: 'user-a' });
    expect(userA.length).toBeGreaterThan(0);
  });

  it('should filter errors only', () => {
    requestLogger.log({
      requestId: 'test-4',
      method: 'POST',
      path: '/v1/chat',
    });

    requestLogger.logResponse({
      requestId: 'test-4',
      statusCode: 500,
      durationMs: 100,
      error: 'Internal error',
    });

    const errors = requestLogger.getRecent(10, { errorOnly: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should return stats', () => {
    const stats = requestLogger.getStats();
    expect(stats.total).toBeGreaterThan(0);
    expect(typeof stats.avgDurationMs).toBe('number');
  });
});
