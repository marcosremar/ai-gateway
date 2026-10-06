/**
 * Unit tests for the pure helper functions exported by server/gpu-poll-health.ts:
 *   - hasPipelineServices(data)
 *   - extractAppHealthError(data)
 *   - isGenericAppHealthReady(data)
 *
 * These functions determine how GPU /health responses are classified.
 * Strategy: mock all server-layer dependencies so only the pure logic runs.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// ── Server-layer mocks (must precede the import of gpu-poll-health) ───────────

vi.mock('../../server/state', () => ({
  deployState: {
    status: 'idle',
    endpoint: '',
    podId: '',
    deployCancelled: false,
  },
  setDeployState: vi.fn(),
  deployCancelled: false,
  setLastRequestTime: vi.fn(),
  updateGpuModelWarmth: vi.fn(),
  setDeployCancelled: vi.fn(),
}));

vi.mock('../../server/ws-state', () => ({
  broadcastWs: vi.fn(),
}));

vi.mock('../../server/providers', () => ({
  registry: {},
}));

vi.mock('../../src/gpu-providers/pull-time-estimator', () => ({
  estimatePullTimeout: vi.fn(() => Promise.resolve({ timeoutMs: 1_800_000, confidence: 'default', basis: 'test' })),
  deriveHostKey: vi.fn(() => 'test:unknown'),
  recordPullTime: vi.fn(),
}));

vi.mock('../../src/gateway/providers/gpu/docker-registry', () => ({
  autoRegisterDockerProvider: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/gpu-providers/deploy-settings', () => ({
  getDeployTimeoutMin: vi.fn(() => 45),
  getDeployTimeoutMinForProvider: vi.fn(() => 45),
}));

vi.mock('../../src/gpu-providers/runpod-client', () => ({
  RunpodClient: class {
    listContainerStatus = vi.fn(() => Promise.resolve(null));
  },
}));

vi.mock('../../src/gateway/providers/gpu/docker-manifest', () => ({
  validateDockerContractManifest: vi.fn(() => Promise.resolve([])),
  defaultApiPathsForCapabilities: vi.fn(() => []),
}));

vi.mock('../../src/logger', () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  })),
}));

// ── Import after mocks are registered ─────────────────────────────────────────

let hasPipelineServices: (data: unknown) => boolean;
let extractAppHealthError: (data: unknown) => { message: string; traceback?: string } | null;
let isGenericAppHealthReady: (data: unknown) => boolean;

beforeAll(async () => {
  const mod = await import('../../server/gpu-poll-health');
  hasPipelineServices = mod.hasPipelineServices;
  extractAppHealthError = mod.extractAppHealthError;
  isGenericAppHealthReady = mod.isGenericAppHealthReady;
});

// ── hasPipelineServices ────────────────────────────────────────────────────────

describe('hasPipelineServices', () => {
  // ── Falsy / non-object inputs ────────────────────────────────────────────────

  it('returns false for null', () => {
    expect(hasPipelineServices(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasPipelineServices(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(hasPipelineServices('healthy')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(hasPipelineServices(42)).toBe(false);
  });

  it('returns false for an array', () => {
    expect(hasPipelineServices(['whisper', 'stt'])).toBe(false);
  });

  it('returns false for empty object (no services field)', () => {
    expect(hasPipelineServices({})).toBe(false);
  });

  it('returns false when services field is missing', () => {
    expect(hasPipelineServices({ status: 'healthy' })).toBe(false);
  });

  it('returns false when services is null', () => {
    expect(hasPipelineServices({ status: 'healthy', services: null })).toBe(false);
  });

  it('returns false when services is a string', () => {
    expect(hasPipelineServices({ services: 'running' })).toBe(false);
  });

  it('returns false when services is an array', () => {
    expect(hasPipelineServices({ services: ['whisper', 'stt'] })).toBe(false);
  });

  it('returns false when services is an empty object', () => {
    expect(hasPipelineServices({ services: {} })).toBe(false);
  });

  it('returns false when services has only non-pipeline keys', () => {
    expect(hasPipelineServices({ services: { http: 'running', metrics: 'ok' } })).toBe(false);
  });

  // ── Pipeline service detection ───────────────────────────────────────────────

  it('returns true when services has "whisper" key', () => {
    expect(hasPipelineServices({ services: { whisper: 'warm' } })).toBe(true);
  });

  it('returns true when services has "stt" key', () => {
    expect(hasPipelineServices({ services: { stt: 'ready' } })).toBe(true);
  });

  it('returns true when services has "llama_cpp" key', () => {
    expect(hasPipelineServices({ services: { llama_cpp: 'loaded' } })).toBe(true);
  });

  it('returns true when services has "llm" key', () => {
    expect(hasPipelineServices({ services: { llm: 'ready' } })).toBe(true);
  });

  it('returns true when services has "tts" key', () => {
    expect(hasPipelineServices({ services: { tts: 'ready' } })).toBe(true);
  });

  it('returns true when services has multiple pipeline keys', () => {
    expect(hasPipelineServices({
      services: { whisper: 'warm', llama_cpp: 'loaded', tts: 'ready' },
    })).toBe(true);
  });

  it('returns true when services mixes pipeline and non-pipeline keys', () => {
    expect(hasPipelineServices({
      services: { http: 'running', whisper: 'warm' },
    })).toBe(true);
  });

  it('pipeline key detection does not depend on the value (even if value is falsy)', () => {
    // The code checks Object.keys(services).some(key => ...) — value is irrelevant
    expect(hasPipelineServices({ services: { whisper: false } })).toBe(true);
    expect(hasPipelineServices({ services: { stt: null } })).toBe(true);
    expect(hasPipelineServices({ services: { tts: '' } })).toBe(true);
  });

  it('realistic speech-pipeline health response is detected', () => {
    expect(hasPipelineServices({
      status: 'healthy',
      services: {
        whisper: 'warm',
        llama_cpp: 'warm',
        tts: 'warm',
      },
    })).toBe(true);
  });

  it('realistic non-speech health response is NOT detected', () => {
    expect(hasPipelineServices({
      status: 'healthy',
      services: {
        glb_renderer: 'ready',
        image_encoder: 'loaded',
      },
    })).toBe(false);
  });
});

// ── extractAppHealthError ──────────────────────────────────────────────────────

describe('extractAppHealthError', () => {
  // ── Non-object inputs ────────────────────────────────────────────────────────

  it('returns null for null', () => {
    expect(extractAppHealthError(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(extractAppHealthError(undefined)).toBeNull();
  });

  it('returns null for a string', () => {
    expect(extractAppHealthError('error')).toBeNull();
  });

  it('returns null for a number', () => {
    expect(extractAppHealthError(500)).toBeNull();
  });

  it('returns null for an array', () => {
    expect(extractAppHealthError([{ status: 'error' }])).toBeNull();
  });

  // ── Status !== 'error', no error field ──────────────────────────────────────

  it('returns null for healthy status with no error', () => {
    expect(extractAppHealthError({ status: 'healthy' })).toBeNull();
  });

  it('returns null for ok status with no error', () => {
    expect(extractAppHealthError({ status: 'ok' })).toBeNull();
  });

  it('returns null for degraded status with no error', () => {
    expect(extractAppHealthError({ status: 'degraded' })).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(extractAppHealthError({})).toBeNull();
  });

  // ── Status === 'error' ───────────────────────────────────────────────────────

  it('returns message from error field when status is error', () => {
    const result = extractAppHealthError({ status: 'error', error: 'CUDA OOM' });
    expect(result).toEqual({ message: 'CUDA OOM' });
  });

  it('falls back to message field when error field is absent but status is error', () => {
    const result = extractAppHealthError({ status: 'error', message: 'failed to load model' });
    expect(result).toEqual({ message: 'failed to load model' });
  });

  it('returns "unknown app error" when status is error but no error/message fields', () => {
    const result = extractAppHealthError({ status: 'error' });
    expect(result).toEqual({ message: 'unknown app error' });
  });

  it('includes traceback when error_traceback is present and non-empty', () => {
    const result = extractAppHealthError({
      status: 'error',
      error: 'RuntimeError',
      error_traceback: 'Traceback: line 42',
    });
    expect(result).toEqual({ message: 'RuntimeError', traceback: 'Traceback: line 42' });
  });

  it('omits traceback when error_traceback is empty string', () => {
    const result = extractAppHealthError({
      status: 'error',
      error: 'RuntimeError',
      error_traceback: '',
    });
    expect(result).toEqual({ message: 'RuntimeError' });
    expect(result?.traceback).toBeUndefined();
  });

  it('omits traceback when error_traceback is whitespace only', () => {
    const result = extractAppHealthError({
      status: 'error',
      error: 'RuntimeError',
      error_traceback: '   ',
    });
    expect(result?.traceback).toBeUndefined();
  });

  it('trims whitespace from error field', () => {
    const result = extractAppHealthError({ status: 'error', error: '  model load failed  ' });
    expect(result?.message).toBe('model load failed');
  });

  // ── Non-error status with error fields ──────────────────────────────────────

  it('returns error for generic (non-speech) app with error field even if status is not error', () => {
    const result = extractAppHealthError({
      status: 'loading',
      error: 'GPU not ready',
      // No speech pipeline services → generic app
    });
    expect(result).not.toBeNull();
    expect(result?.message).toBe('GPU not ready');
  });

  it('returns null for speech-pipeline app with error field when status is not error', () => {
    // When the app has pipeline services, non-error status + error field is NOT classified
    // as an error — speech pipelines report "error" in services while loading, which is normal.
    const result = extractAppHealthError({
      status: 'loading',
      error: 'stt still warming',
      services: { whisper: 'loading', llama_cpp: 'loading' },
    });
    expect(result).toBeNull();
  });

  it('returns null for generic app with traceback but no error field when status is not error', () => {
    // Traceback alone (without error string) should still trigger the fallback message
    const result = extractAppHealthError({
      status: 'healthy',
      error_traceback: 'Traceback (most recent call last): line 1',
    });
    expect(result).not.toBeNull();
    expect(result?.message).toBe('app reported an error in /health');
    expect(result?.traceback).toBe('Traceback (most recent call last): line 1');
  });

  it('status comparison is case-insensitive (ERROR → error)', () => {
    // healthStatus() calls .toLowerCase()
    const result = extractAppHealthError({ status: 'ERROR', error: 'crash' });
    expect(result).toEqual({ message: 'crash' });
  });
});

// ── isGenericAppHealthReady ────────────────────────────────────────────────────

describe('isGenericAppHealthReady', () => {
  // ── Rejections for disallowed statuses ───────────────────────────────────────

  it('returns false for null', () => {
    expect(isGenericAppHealthReady(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isGenericAppHealthReady(undefined)).toBe(false);
  });

  it('returns false for loading status (not in GENERIC_APP_READY_STATUSES)', () => {
    expect(isGenericAppHealthReady({ status: 'loading' })).toBe(false);
  });

  it('returns false for error status', () => {
    expect(isGenericAppHealthReady({ status: 'error' })).toBe(false);
  });

  it('returns false for unknown/missing status', () => {
    expect(isGenericAppHealthReady({})).toBe(false);
    expect(isGenericAppHealthReady({ status: 'unknown' })).toBe(false);
  });

  it('returns false for string payload (no status)', () => {
    expect(isGenericAppHealthReady('healthy')).toBe(false);
  });

  // ── Allowed statuses ─────────────────────────────────────────────────────────

  it('returns true for { status: "healthy" } with no pipeline services or error', () => {
    expect(isGenericAppHealthReady({ status: 'healthy' })).toBe(true);
  });

  it('returns true for { status: "ok" } with no pipeline services or error', () => {
    expect(isGenericAppHealthReady({ status: 'ok' })).toBe(true);
  });

  it('returns true for { status: "degraded" } with no pipeline services or error', () => {
    expect(isGenericAppHealthReady({ status: 'degraded' })).toBe(true);
  });

  it('returns true for { status: "ready" } with no pipeline services or error', () => {
    expect(isGenericAppHealthReady({ status: 'ready' })).toBe(true);
  });

  it('status comparison is case-insensitive (HEALTHY → healthy)', () => {
    expect(isGenericAppHealthReady({ status: 'HEALTHY' })).toBe(true);
  });

  // ── Speech pipeline apps must NOT pass as generic ────────────────────────────

  it('returns false even with "healthy" status when speech pipeline services are present', () => {
    // Speech pipeline app — use hybrid router, not generic path
    expect(isGenericAppHealthReady({
      status: 'healthy',
      services: { whisper: 'warm', llama_cpp: 'warm', tts: 'warm' },
    })).toBe(false);
  });

  it('returns false when any one pipeline service key is present (e.g. just "tts")', () => {
    expect(isGenericAppHealthReady({ status: 'ok', services: { tts: 'ready' } })).toBe(false);
  });

  // ── App error blocks ready state ─────────────────────────────────────────────

  it('returns false when status is healthy but error field is set (no pipeline services)', () => {
    // Generic app reporting an error in its health payload → not usable
    expect(isGenericAppHealthReady({
      status: 'healthy',
      error: 'model load failed',
    })).toBe(false);
  });

  it('returns false when status is healthy but traceback is present', () => {
    expect(isGenericAppHealthReady({
      status: 'ok',
      error_traceback: 'Traceback: crash at startup',
    })).toBe(false);
  });

  // ── Realistic health payloads ────────────────────────────────────────────────

  it('accepts realistic generic image-gen app health response', () => {
    expect(isGenericAppHealthReady({
      status: 'ready',
      model: 'sdxl-turbo',
      services: { image_encoder: 'loaded', unet: 'ready' },
    })).toBe(true);
  });

  it('rejects realistic speech-pipeline health response', () => {
    expect(isGenericAppHealthReady({
      status: 'healthy',
      services: {
        whisper: 'warm',
        llama_cpp: 'warm',
        tts: 'warm',
      },
    })).toBe(false);
  });

  it('accepts a simple ping-style health response', () => {
    expect(isGenericAppHealthReady({ status: 'ok' })).toBe(true);
  });
});
