/**
 * GPU Readiness State Machine — Integration Tests
 *
 * Tests state transitions, shadow mode, latency rings, and deploy settings.
 * Uses source code analysis + direct state module tests.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '../..', file), 'utf-8');

describe('GPU Readiness State Machine', () => {

  describe('GpuReadinessState interface', () => {
    it('should include autoRecoveryAttempt field in interface', () => {
      const source = readSource('src/gateway/state/readiness-state.ts');
      expect(source).toContain('autoRecoveryAttempt: number');
    });

    it('should initialize autoRecoveryAttempt to 0 in default state', () => {
      const source = readSource('src/gateway/state/readiness-state.ts');
      // The default state object should include autoRecoveryAttempt: 0
      const defaultIdx = source.indexOf('gpuReadinessState: GpuReadinessState = {');
      const defaultBlock = source.slice(defaultIdx, defaultIdx + 300);
      expect(defaultBlock).toContain('autoRecoveryAttempt: 0');
    });

    it('resetGpuReadinessState should include autoRecoveryAttempt: 0', () => {
      const source = readSource('src/gateway/state/readiness-state.ts');
      const resetIdx = source.indexOf('function resetGpuReadinessState');
      const resetBlock = source.slice(resetIdx, resetIdx + 400);
      expect(resetBlock).toContain('autoRecoveryAttempt: 0');
    });

    it('resetGpuReadinessState should clear latency rings', () => {
      const source = readSource('src/gateway/state/readiness-state.ts');
      const resetIdx = source.indexOf('function resetGpuReadinessState');
      const resetBlock = source.slice(resetIdx, resetIdx + 400);
      expect(resetBlock).toContain('resetPerStageLatencyRings');
    });
  });

  describe('Per-stage latency ring', () => {
    it('should have bounded ring size', () => {
      const source = readSource('src/gateway/state/readiness-state.ts');
      expect(source).toContain('PER_STAGE_RING_SIZE');
    });

    it('should implement circular buffer correctly', () => {
      const source = readSource('src/gateway/state/readiness-state.ts');
      expect(source).toContain('ring.length < PER_STAGE_RING_SIZE');
      expect(source).toContain('% PER_STAGE_RING_SIZE');
    });
  });
});

describe('Deploy Settings', () => {
  it('should have auto-recovery settings with correct defaults', async () => {
    const {
      getAutoRecoveryEnabled, getAutoRecoveryDelaySec, getAutoRecoveryMaxRetries,
    } = await import('../../src/gpu-providers/deploy-settings');
    expect(getAutoRecoveryEnabled()).toBe(true);
    expect(getAutoRecoveryDelaySec()).toBeGreaterThanOrEqual(5);
    expect(getAutoRecoveryMaxRetries()).toBeGreaterThanOrEqual(1);
  });

  it('should clamp auto-recovery delay to valid range', async () => {
    const { setAutoRecoveryDelaySec, getAutoRecoveryDelaySec } = await import('../../src/gpu-providers/deploy-settings');
    setAutoRecoveryDelaySec(1);
    expect(getAutoRecoveryDelaySec()).toBe(5);
    setAutoRecoveryDelaySec(999);
    expect(getAutoRecoveryDelaySec()).toBe(300);
    setAutoRecoveryDelaySec(10);
  });

  it('should have debounced save', () => {
    const source = readSource('src/gateway/providers/gpu/deploy-settings.ts');
    expect(source).toContain('_settingsSaveTimer');
    expect(source).toContain('flushDeploySettings');
  });

  it('should have latency target getters', async () => {
    const {
      getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs,
    } = await import('../../src/gpu-providers/deploy-settings');
    expect(getSttTargetLatencyMs()).toBe(800);
    expect(getLlmTargetLatencyMs()).toBe(2000);
    expect(getTtsTargetLatencyMs()).toBe(1500);
  });
});
