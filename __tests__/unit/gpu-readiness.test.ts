/**
 * GPU Readiness State Machine — Integration Tests
 *
 * Tests state transitions, shadow mode, latency rings, and deploy settings.
 * Uses source code analysis + direct state module tests.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

describe('GPU Readiness State Machine', () => {

  describe('GpuReadinessState interface', () => {
    it('should include autoRecoveryAttempt field in interface', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('autoRecoveryAttempt: number');
    });

    it('should initialize autoRecoveryAttempt to 0 in default state', () => {
      const source = readSource('server/state.ts');
      // The default state object should include autoRecoveryAttempt: 0
      const defaultIdx = source.indexOf('gpuReadinessState: GpuReadinessState = {');
      const defaultBlock = source.slice(defaultIdx, defaultIdx + 300);
      expect(defaultBlock).toContain('autoRecoveryAttempt: 0');
    });

    it('resetGpuReadinessState should include autoRecoveryAttempt: 0', () => {
      const source = readSource('server/state.ts');
      const resetIdx = source.indexOf('function resetGpuReadinessState');
      const resetBlock = source.slice(resetIdx, resetIdx + 400);
      expect(resetBlock).toContain('autoRecoveryAttempt: 0');
    });

    it('resetGpuReadinessState should clear latency rings', () => {
      const source = readSource('server/state.ts');
      const resetIdx = source.indexOf('function resetGpuReadinessState');
      const resetBlock = source.slice(resetIdx, resetIdx + 400);
      expect(resetBlock).toContain('resetPerStageLatencyRings');
    });
  });

  describe('Per-stage latency ring', () => {
    it('should have bounded ring size', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('PER_STAGE_RING_SIZE');
    });

    it('should implement circular buffer correctly', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('ring.length < PER_STAGE_RING_SIZE');
      expect(source).toContain('% PER_STAGE_RING_SIZE');
    });
  });

  describe('resetReadinessCheck', () => {
    it('should cancel repechage timer', () => {
      const source = readSource('server/gpu-readiness.ts');
      const resetIdx = source.indexOf('function resetReadinessCheck');
      const body = source.slice(resetIdx, resetIdx + 300);
      expect(body).toContain('clearTimeout(repechageTimer)');
    });

    it('should cancel auto-recovery timer', () => {
      const source = readSource('server/gpu-readiness.ts');
      const resetIdx = source.indexOf('function resetReadinessCheck');
      const body = source.slice(resetIdx, resetIdx + 300);
      expect(body).toContain('clearTimeout(autoRecoveryTimer)');
    });

    it('should reset shadowStartedAt', () => {
      const source = readSource('server/gpu-readiness.ts');
      // shadowStartedAt = 0 should appear in resetReadinessCheck
      const resetIdx = source.indexOf('function resetReadinessCheck');
      const body = source.slice(resetIdx, resetIdx + 500);
      expect(body).toContain('shadowStartedAt');
    });

    it('should reset autoRecoveryAttempt', () => {
      const source = readSource('server/gpu-readiness.ts');
      const resetIdx = source.indexOf('function resetReadinessCheck');
      const body = source.slice(resetIdx, resetIdx + 500);
      expect(body).toContain('autoRecoveryAttempt');
    });
  });

  describe('recordShadowRun guards', () => {
    it('should guard against concurrent readiness check', () => {
      const source = readSource('server/gpu-readiness.ts');
      const fnIdx = source.indexOf('function recordShadowRun');
      const body = source.slice(fnIdx, fnIdx + 500);
      expect(body).toContain('if (checkInProgress)');
      expect(body).toContain('Shadow run skipped');
    });

    it('should have shadow timeout constant (1 hour)', () => {
      const source = readSource('server/gpu-readiness.ts');
      expect(source).toContain('SHADOW_TIMEOUT_MS');
      expect(source).toContain('60 * 60 * 1000');
    });

    it('should reset shadowStartedAt on completion', () => {
      const source = readSource('server/gpu-readiness.ts');
      const fnIdx = source.indexOf('function recordShadowRun');
      const body = source.slice(fnIdx, fnIdx + 3000);
      expect(body).toContain('shadowStartedAt');
      expect(body).toContain('Shadow mode complete');
    });

    it('should support early activation for fast GPUs', () => {
      const source = readSource('server/gpu-readiness.ts');
      expect(source).toContain('earlyActivationThreshold');
      expect(source).toContain('proven fast GPU');
    });
  });

  describe('STT benchmark WAV reuse', () => {
    it('should create WAV buffer once at module level', () => {
      const source = readSource('server/gpu-readiness.ts');
      expect(source).toContain('const STT_BENCH_WAV');
    });

    it('should use pre-built WAV in benchmarkService', () => {
      const source = readSource('server/gpu-readiness.ts');
      const fnIdx = source.indexOf('async function benchmarkService');
      const body = source.slice(fnIdx, fnIdx + 2000);
      expect(body).toContain('STT_BENCH_WAV');
      expect(body).not.toContain('Buffer.alloc(headerSize');
    });
  });

  describe('WS broadcast batching', () => {
    it('should batch broadcasts during benchmark', () => {
      const source = readSource('server/gpu-readiness.ts');
      // Should broadcast every 3rd run, plus first and last
      expect(source).toContain('% 3 === 0');
    });
  });
});

describe('Deploy Settings', () => {
  it('should have auto-recovery settings with correct defaults', async () => {
    const {
      getAutoRecoveryEnabled, getAutoRecoveryDelaySec, getAutoRecoveryMaxRetries,
    } = await import('../src/gpu-providers/deploy-settings');
    expect(getAutoRecoveryEnabled()).toBe(true);
    expect(getAutoRecoveryDelaySec()).toBeGreaterThanOrEqual(5);
    expect(getAutoRecoveryMaxRetries()).toBeGreaterThanOrEqual(1);
  });

  it('should clamp auto-recovery delay to valid range', async () => {
    const { setAutoRecoveryDelaySec, getAutoRecoveryDelaySec } = await import('../src/gpu-providers/deploy-settings');
    setAutoRecoveryDelaySec(1);
    expect(getAutoRecoveryDelaySec()).toBe(5);
    setAutoRecoveryDelaySec(999);
    expect(getAutoRecoveryDelaySec()).toBe(300);
    setAutoRecoveryDelaySec(10);
  });

  it('should have debounced save', () => {
    const source = readSource('src/gpu-providers/deploy-settings.ts');
    expect(source).toContain('_settingsSaveTimer');
    expect(source).toContain('flushDeploySettings');
  });

  it('should have latency target getters', async () => {
    const {
      getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs,
    } = await import('../src/gpu-providers/deploy-settings');
    expect(getSttTargetLatencyMs()).toBe(800);
    expect(getLlmTargetLatencyMs()).toBe(2000);
    expect(getTtsTargetLatencyMs()).toBe(1500);
  });
});
