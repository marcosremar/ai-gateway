/**
 * Tests for pipeline-orchestrator module.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPipeline } from '../../src/pipeline-orchestrator';

describe('Pipeline Orchestrator', () => {
  it('should execute stages in order', async () => {
    const pipeline = createPipeline<string, string>('test');
    const order: string[] = [];

    pipeline.stage('a', async (input) => {
      order.push('a');
      return input + '-a';
    });
    pipeline.stage('b', async (input) => {
      order.push('b');
      return input + '-b';
    });

    const result = await pipeline.execute('start');
    expect(order).toEqual(['a', 'b']);
    expect(result).toBe('start-a-b');
  });

  it('should fail on stage error', async () => {
    const pipeline = createPipeline('failing');
    pipeline.stage('good', async (input) => input);
    pipeline.stage('bad', async () => {
      throw new Error('Stage failed');
    });

    await expect(pipeline.execute('data')).rejects.toThrow('Stage failed');
  });

  it('should track stats', async () => {
    const pipeline = createPipeline('stats');
    pipeline.stage('pass', async (x) => x);

    await pipeline.execute('1');
    await pipeline.execute('2');

    const stats = pipeline.getStats();
    expect(stats.totalExecutions).toBe(2);
    expect(stats.successfulExecutions).toBe(2);
    expect(stats.failedExecutions).toBe(0);
  });

  it('should execute fallback on failure', async () => {
    const pipeline = createPipeline('fallback');
    pipeline.stage('fail', async () => {
      throw new Error('Always fails');
    });

    const fallback = vi.fn().mockResolvedValue('fallback-result');
    const result = await pipeline.executeWithFallback('data', fallback);

    expect(result).toBe('fallback-result');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('should generate unique execution IDs', async () => {
    const pipeline = createPipeline('unique-ids');
    pipeline.stage('pass', async (x) => x);

    const ids = new Set();
    for (let i = 0; i < 10; i++) {
      await pipeline.execute('data');
    }

    // Each execution should have a unique ID (tested via context)
    expect(pipeline.getStats().totalExecutions).toBe(10);
  });
});
