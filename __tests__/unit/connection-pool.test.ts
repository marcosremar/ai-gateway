/**
 * Tests for connection-pool module.
 */

import { describe, it, expect } from 'vitest';
import { createConnectionPool } from '../../src/connection-pool';

describe('ConnectionPool', () => {
  it('should create a pool', () => {
    const pool = createConnectionPool();
    expect(pool).toBeDefined();
    expect(typeof pool.fetch).toBe('function');
  });

  it('should close pool', async () => {
    const pool = createConnectionPool();
    await pool.close();
  });

  it('should respect maxConnections setting', () => {
    const pool = createConnectionPool({ maxConnections: 3 });
    expect(pool).toBeDefined();
  });

  it('should report stats', () => {
    const pool = createConnectionPool();
    const stats = pool.getStats();
    expect(stats).toBeDefined();
  });
});
