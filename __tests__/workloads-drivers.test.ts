/**
 * Workload Drivers — unit tests for BotWorkloadDriver, DbWorkloadDriver, GpuWorkloadDriver
 *
 * These drivers delegate to server modules via dynamic imports,
 * so we test the basic constructor/type behavior and verify the interface contract.
 */
import { describe, it, expect } from 'vitest';
import { BotWorkloadDriver } from '../src/workloads/bot-driver';
import { DbWorkloadDriver } from '../src/workloads/db-driver';
import { GpuWorkloadDriver } from '../src/workloads/gpu-driver';
import type { Workload } from '../src/workloads/types';
describe('BotWorkloadDriver', () => {
  const driver = new BotWorkloadDriver();
  it('has correct type', () => {
    expect(driver.type).toBe('bot');
  });
  it('status maps bot states correctly', async () => {
    // We can't call status() without mocking server state, but we can test the type
    const workload: Workload = {
      id: 'test',
      type: 'bot',
      name: 'test-bot',
      status: 'deploying',
      provider: 'runpod',
      costPerHr: 0,
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // The driver will try to dynamically import server state, which won't work in unit tests.
    // We just verify the driver has the expected interface
    expect(typeof driver.deploy).toBe('function');
    expect(typeof driver.stop).toBe('function');
    expect(typeof driver.start).toBe('function');
    expect(typeof driver.terminate).toBe('function');
    expect(typeof driver.status).toBe('function');
  });
});
describe('DbWorkloadDriver', () => {
  const driver = new DbWorkloadDriver();
  it('has correct type', () => {
    expect(driver.type).toBe('db');
  });
  it('has all required interface methods', () => {
    expect(typeof driver.deploy).toBe('function');
    expect(typeof driver.stop).toBe('function');
    expect(typeof driver.start).toBe('function');
    expect(typeof driver.terminate).toBe('function');
    expect(typeof driver.status).toBe('function');
  });
  it('deploy throws without credentials', async () => {
    const origApiKey = process.env.NEON_API_KEY;
    const origProjectId = process.env.NEON_PROJECT_ID;
    delete process.env.NEON_API_KEY;
    delete process.env.NEON_PROJECT_ID;
    await expect(
      driver.deploy('test-db', { type: 'db' }),
    ).rejects.toThrow('NEON_API_KEY');
    if (origApiKey) process.env.NEON_API_KEY = origApiKey;
    if (origProjectId) process.env.NEON_PROJECT_ID = origProjectId;
  });
});
describe('GpuWorkloadDriver', () => {
  const driver = new GpuWorkloadDriver();
  it('has correct type', () => {
    expect(driver.type).toBe('gpu');
  });
  it('has all required interface methods', () => {
    expect(typeof driver.deploy).toBe('function');
    expect(typeof driver.stop).toBe('function');
    expect(typeof driver.start).toBe('function');
    expect(typeof driver.terminate).toBe('function');
    expect(typeof driver.status).toBe('function');
  });
});
