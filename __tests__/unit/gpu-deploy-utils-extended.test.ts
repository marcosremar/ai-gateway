/**
 * GPU Deploy Utilities — extended unit tests.
 *
 * Covers the functions not yet tested in gpu-handlers.test.ts:
 *   validateGpuCredentials, parseDeployBody, calculateDeployTimeout,
 *   isDeployInProgress, formatDeployStatus, updateDeployProgress
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock server state BEFORE importing the module under test ─────────────────

const mockState = {
  status: 'idle' as string,
  deployId: 'dep-123',
  provider: 'runpod',
  gpuType: 'NVIDIA GeForce RTX 4090',
  dockerImage: 'test-image:latest',
  endpoint: 'https://gpu.example.com',
  message: 'Deploying...',
  step: 'creating',
  stepDetail: '12%',
  startedAt: 1000,
  deployDurationMs: 5000,
  costPerHr: 0.44,
  alert: '',
  alertLevel: undefined as string | undefined,
};

vi.mock('../../server/state', () => ({
  get deployState() { return mockState; },
  setDeployState: vi.fn((patch: Record<string, unknown>) => { Object.assign(mockState, patch); }),
}));

vi.mock('../../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  validateGpuCredentials,
  parseDeployBody,
  calculateDeployTimeout,
  isDeployInProgress,
  formatDeployStatus,
  updateDeployProgress,
} from '../../server/handlers/gpu/deploy-utils';

// ── validateGpuCredentials ────────────────────────────────────────────────────

describe('validateGpuCredentials', () => {
  it('returns valid:true for a long enough API key', () => {
    const result = validateGpuCredentials('runpod', 'a-valid-api-key-123');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns valid:false when apiKey is missing', () => {
    const result = validateGpuCredentials('runpod');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('runpod');
  });

  it('returns valid:false for empty string', () => {
    const result = validateGpuCredentials('vast', '');
    expect(result.valid).toBe(false);
  });

  it('returns valid:false for key shorter than 10 chars', () => {
    const result = validateGpuCredentials('tensordock', 'short');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('tensordock');
  });

  it('accepts key that is exactly 10 characters', () => {
    const result = validateGpuCredentials('modal', '1234567890');
    expect(result.valid).toBe(true);
  });
});

// ── parseDeployBody ───────────────────────────────────────────────────────────

describe('parseDeployBody', () => {
  it('extracts dockerImage from body', () => {
    const result = parseDeployBody({ dockerImage: 'my-image:v1' });
    expect(result.dockerImage).toBe('my-image:v1');
  });

  it('defaults gpuTypes to RTX 4090 when not specified', () => {
    const result = parseDeployBody({ dockerImage: 'img' });
    expect(result.gpuTypes).toEqual(['NVIDIA GeForce RTX 4090']);
  });

  it('extracts gpuTypes array from body', () => {
    const result = parseDeployBody({ dockerImage: 'img', gpuTypes: ['GPU-A', 'GPU-B'] });
    expect(result.gpuTypes).toEqual(['GPU-A', 'GPU-B']);
  });

  it('extracts env record from body', () => {
    const result = parseDeployBody({ dockerImage: 'img', env: { FOO: 'bar', NUM: '42' } });
    expect(result.env).toEqual({ FOO: 'bar', NUM: '42' });
  });

  it('defaults env to empty object when missing', () => {
    const result = parseDeployBody({ dockerImage: 'img' });
    expect(result.env).toEqual({});
  });

  it('extracts known option fields', () => {
    const result = parseDeployBody({
      dockerImage: 'img',
      onstart: 'echo hello',
      networkVolumeId: 'vol-123',
      diskGb: 50,
      region: 'us-west',
      race: true,
      maxCostUsd: 5.0,
    });
    expect(result.options.onstart).toBe('echo hello');
    expect(result.options.networkVolumeId).toBe('vol-123');
    expect(result.options.diskGb).toBe(50);
    expect(result.options.region).toBe('us-west');
    expect(result.options.race).toBe(true);
    expect(result.options.maxCostUsd).toBe(5.0);
  });

  it('handles empty body object', () => {
    const result = parseDeployBody({});
    expect(result.dockerImage).toBe('');
    expect(result.gpuTypes).toEqual(['NVIDIA GeForce RTX 4090']);
    expect(result.env).toEqual({});
  });
});

// ── calculateDeployTimeout ────────────────────────────────────────────────────

describe('calculateDeployTimeout', () => {
  it('returns base timeout in minutes for a standard image', () => {
    const minutes = calculateDeployTimeout('runpod', 'babelcast-subtitle:latest');
    expect(minutes).toBeGreaterThan(0);
  });

  it('adds extra time for large models (70B)', () => {
    const normal = calculateDeployTimeout('vast', 'my-image:latest');
    const large = calculateDeployTimeout('vast', 'llama-70b-image:latest');
    expect(large).toBeGreaterThan(normal);
  });

  it('adds extra time for 65B models', () => {
    const normal = calculateDeployTimeout('vast', 'my-image:latest');
    const large65 = calculateDeployTimeout('vast', 'llama-65b-image:latest');
    expect(large65).toBeGreaterThan(normal);
  });

  it('applies RunPod multiplier (1.5×) making it longer than vast', () => {
    const runpod = calculateDeployTimeout('runpod', 'my-image:latest');
    const vast = calculateDeployTimeout('vast', 'my-image:latest');
    expect(runpod).toBeGreaterThan(vast);
    expect(runpod / vast).toBeCloseTo(1.5, 1);
  });

  it('uses default baseTimeout of 30 min when not provided', () => {
    // vast (multiplier 1.0) × 30 min base = 30
    const result = calculateDeployTimeout('vast', 'img');
    expect(result).toBe(30);
  });

  it('respects custom baseTimeout', () => {
    const result = calculateDeployTimeout('vast', 'img', 60);
    expect(result).toBe(60);
  });

  it('large model on RunPod gets both extra time and RunPod multiplier', () => {
    const base = calculateDeployTimeout('runpod', 'img'); // (30+0)*1.5 = 45
    const large = calculateDeployTimeout('runpod', 'llama-70b:latest'); // (30+15)*1.5 = 67.5
    expect(large).toBeGreaterThan(base);
    expect(large).toBeCloseTo(67.5, 0);
  });
});

// ── isDeployInProgress ────────────────────────────────────────────────────────

describe('isDeployInProgress', () => {
  beforeEach(() => {
    mockState.status = 'idle';
  });

  it('returns false for idle status', () => {
    mockState.status = 'idle';
    expect(isDeployInProgress()).toBe(false);
  });

  it('returns true for creating status', () => {
    mockState.status = 'creating';
    expect(isDeployInProgress()).toBe(true);
  });

  it('returns true for booting status', () => {
    mockState.status = 'booting';
    expect(isDeployInProgress()).toBe(true);
  });

  it('returns true for installing status', () => {
    mockState.status = 'installing';
    expect(isDeployInProgress()).toBe(true);
  });

  it('returns false for ready status', () => {
    mockState.status = 'ready';
    expect(isDeployInProgress()).toBe(false);
  });

  it('returns false for error status', () => {
    mockState.status = 'error';
    expect(isDeployInProgress()).toBe(false);
  });
});

// ── formatDeployStatus ────────────────────────────────────────────────────────

describe('formatDeployStatus', () => {
  beforeEach(() => {
    mockState.status = 'ready';
    mockState.deployId = 'dep-42';
    mockState.provider = 'vast';
    mockState.gpuType = 'NVIDIA RTX A6000';
    mockState.dockerImage = 'img:latest';
    mockState.endpoint = 'https://ep.example.com';
    mockState.message = 'GPU ready';
    mockState.step = 'ready';
    mockState.stepDetail = '';
    mockState.startedAt = 0;
    mockState.deployDurationMs = 120_000;
    mockState.costPerHr = 0.79;
    mockState.alert = '';
    mockState.alertLevel = undefined;
  });

  it('returns an object with status field', () => {
    const result = formatDeployStatus();
    expect(result.status).toBe('ready');
  });

  it('reflects current deployId', () => {
    const result = formatDeployStatus();
    expect(result.deployId).toBe('dep-42');
  });

  it('includes provider and gpuType', () => {
    const result = formatDeployStatus();
    expect(result.provider).toBe('vast');
    expect(result.gpuType).toBe('NVIDIA RTX A6000');
  });

  it('includes endpoint', () => {
    const result = formatDeployStatus();
    expect(result.endpoint).toBe('https://ep.example.com');
  });

  it('includes costPerHr', () => {
    const result = formatDeployStatus();
    expect(result.costPerHr).toBe(0.79);
  });

  it('includes message and step', () => {
    const result = formatDeployStatus();
    expect(result.message).toBe('GPU ready');
    expect(result.step).toBe('ready');
  });

  it('reflects state changes between calls', () => {
    const r1 = formatDeployStatus();
    expect(r1.status).toBe('ready');
    mockState.status = 'error';
    mockState.message = 'Deploy failed';
    const r2 = formatDeployStatus();
    expect(r2.status).toBe('error');
    expect(r2.message).toBe('Deploy failed');
  });
});

// ── updateDeployProgress ──────────────────────────────────────────────────────

import * as stateModule from '../../server/state';

describe('updateDeployProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls setDeployState with step and message', () => {
    updateDeployProgress('booting', 'Waiting for GPU to boot');
    expect(stateModule.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'booting', message: 'Waiting for GPU to boot' }),
    );
  });

  it('includes stepDetail when provided', () => {
    updateDeployProgress('installing', 'Installing packages', '45%');
    expect(stateModule.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'installing', message: 'Installing packages', stepDetail: '45%' }),
    );
  });

  it('does not include stepDetail when not provided', () => {
    updateDeployProgress('ready', 'GPU is ready');
    const call = (stateModule.setDeployState as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('stepDetail');
  });
});
