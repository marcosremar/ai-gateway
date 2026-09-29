/**
 * Unit tests for src/compute/run-gpu-job.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runGpuJob, type RunGpuJobDeps, type RunGpuJobInput } from '../../src/compute/run-gpu-job';
import type { InstanceSpec } from '../../src/gpu-providers/types';

const SPEC: InstanceSpec = {
  gpuTypes: ['NVIDIA GeForce RTX 4090'],
  dockerImage: 'test/image:latest',
};

function makeDeps(overrides: Partial<RunGpuJobDeps> = {}): RunGpuJobDeps & {
  deploy: ReturnType<typeof vi.fn>;
  waitReady: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return {
    deploy: vi.fn(async () => ({ instanceId: 'inst-1', provider: 'vast', endpoint: 'http://gpu' })),
    waitReady: vi.fn(async () => undefined),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
    destroy: vi.fn(async () => undefined),
    ...overrides,
  };
}

const baseInput = (overrides: Partial<RunGpuJobInput> = {}): RunGpuJobInput => ({
  spec: SPEC,
  command: 'python train.py',
  ...overrides,
});

describe('runGpuJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: deploy → wait → exec → destroy, destroyed true', async () => {
    const deps = makeDeps();
    const result = await runGpuJob(deps, baseInput());

    expect(deps.deploy).toHaveBeenCalledWith(SPEC);
    expect(deps.waitReady).toHaveBeenCalledWith('inst-1', { timeoutMs: 15 * 60_000 });
    expect(deps.exec).toHaveBeenCalledWith('inst-1', 'python train.py');
    expect(deps.destroy).toHaveBeenCalledWith('inst-1');

    expect(result).toMatchObject({
      instanceId: 'inst-1',
      provider: 'vast',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      destroyed: true,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('command fails + destroyOnFailure true → still destroy', async () => {
    const deps = makeDeps({
      exec: vi.fn(async () => ({ exitCode: 2, stdout: '', stderr: 'boom' })),
    });

    const result = await runGpuJob(deps, baseInput({ destroyOnFailure: true }));

    expect(deps.destroy).toHaveBeenCalledWith('inst-1');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('boom');
    expect(result.destroyed).toBe(true);
  });

  it('command fails + destroyOnFailure false → no destroy', async () => {
    const deps = makeDeps({
      exec: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'fail' })),
    });

    const result = await runGpuJob(deps, baseInput({ destroyOnFailure: false }));

    expect(deps.destroy).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.destroyed).toBe(false);
  });

  it('waitReady throws → destroy attempted in finally', async () => {
    const deps = makeDeps({
      waitReady: vi.fn(async () => {
        throw new Error('boot timeout');
      }),
    });

    await expect(runGpuJob(deps, baseInput())).rejects.toThrow('boot timeout');
    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.destroy).toHaveBeenCalledWith('inst-1');
  });

  it('waitReady throws + destroyOnFailure false → no destroy', async () => {
    const deps = makeDeps({
      waitReady: vi.fn(async () => {
        throw new Error('boot timeout');
      }),
    });

    await expect(runGpuJob(deps, baseInput({ destroyOnFailure: false }))).rejects.toThrow('boot timeout');
    expect(deps.destroy).not.toHaveBeenCalled();
  });

  it('destroy throw → warn and return destroyed:false', async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      destroy: vi.fn(async () => {
        throw new Error('terminate failed');
      }),
      logger: { log: vi.fn(), warn },
    });

    const result = await runGpuJob(deps, baseInput());

    expect(result.destroyed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('destroy failed'));
  });

  it('destroyOnSuccess false → keep instance after success', async () => {
    const deps = makeDeps();
    const result = await runGpuJob(deps, baseInput({ destroyOnSuccess: false }));

    expect(deps.destroy).not.toHaveBeenCalled();
    expect(result.destroyed).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('deploy throws → no destroy (no instance)', async () => {
    const deps = makeDeps({
      deploy: vi.fn(async () => {
        throw new Error('no GPUs');
      }),
    });

    await expect(runGpuJob(deps, baseInput())).rejects.toThrow('no GPUs');
    expect(deps.waitReady).not.toHaveBeenCalled();
    expect(deps.destroy).not.toHaveBeenCalled();
  });

  it('respects readyTimeoutMs', async () => {
    const deps = makeDeps();
    await runGpuJob(deps, baseInput({ readyTimeoutMs: 42_000 }));
    expect(deps.waitReady).toHaveBeenCalledWith('inst-1', { timeoutMs: 42_000 });
  });
});
