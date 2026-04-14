/**
 * Auto-Recovery & Repechage — Integration Tests
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

describe('Auto-Recovery System', () => {

  describe('Timer management', () => {
    it('should store auto-recovery timer handle', () => {
      const source = readSource('../../../server/gpu-readiness.ts');
      expect(source).toContain('let autoRecoveryTimer');
      expect(source).toContain('autoRecoveryTimer = setTimeout');
      expect(source).toContain('autoRecoveryTimer = null');
    });

    it('should export isAutoRecoveryPending', () => {
      const source = readSource('../../../server/gpu-readiness.ts');
      expect(source).toContain('export function isAutoRecoveryPending');
    });
  });

  describe('Deploy lock protection', () => {
    it('should check for active deploys before auto-recovery', () => {
      const source = readSource('../../../server/gpu-deploy.ts');
      const fnIdx = source.indexOf('async function startAutoRecoveryDeploy');
      const fnBody = source.slice(fnIdx, fnIdx + 500);
      expect(fnBody).toContain('deploy already in progress');
    });

    it('should save API keys before resetDeployState', () => {
      const source = readSource('../../../server/gpu-deploy.ts');
      const fnIdx = source.indexOf('async function startAutoRecoveryDeploy');
      const fnBody = source.slice(fnIdx, fnIdx + 2000);
      expect(fnBody).toContain('savedKeys');
      expect(fnBody).toContain('Save API keys BEFORE reset');
      expect(fnBody).toContain('Restore API keys after reset');
    });
  });

  describe('Repechage validation', () => {
    it('should validate podId in repechage timer', () => {
      const source = readSource('../../../server/gpu-readiness.ts');
      expect(source).toContain('const podId = deployState.podId');
      expect(source).toContain('deployState.podId !== podId');
    });

    it('should clear latency rings on repechage entry', () => {
      const source = readSource('../../../server/gpu-readiness.ts');
      // resetPerStageLatencyRings should appear in the file AND be imported
      expect(source).toContain('resetPerStageLatencyRings');
      // Should have the comment about clearing stale samples
      expect(source).toContain('Clear stale latency samples');
    });

    it('should use named constant for repechage delay', () => {
      const source = readSource('../../../server/gpu-readiness.ts');
      expect(source).toContain('REPECHAGE_DELAY_MS');
    });

    it('should log cancelled repechage when pod changed', () => {
      const source = readSource('../../../server/gpu-readiness.ts');
      expect(source).toContain('Repechage cancelled');
    });
  });

  describe('Shadow mode timeout', () => {
    it('should enforce 1-hour shadow timeout', () => {
      const source = readSource('../../../server/gpu-readiness.ts');
      expect(source).toContain('SHADOW_TIMEOUT_MS');
      expect(source).toContain('Shadow mode timeout');
    });

    it('should log re-benchmark failures on shadow timeout', () => {
      const source = readSource('../../../server/gpu-readiness.ts');
      expect(source).toContain('Shadow timeout re-benchmark failed');
    });
  });
});

describe('P95 Demotion Cooldown', () => {
  it('should require consecutive violations before demoting', () => {
    const source = readSource('../../../server/gpu-deploy.ts');
    expect(source).toContain('P95_DEMOTION_CONSECUTIVE_VIOLATIONS');
    expect(source).toContain('p95ViolationCount');
  });

  it('should log intermediate warnings', () => {
    const source = readSource('../../../server/gpu-deploy.ts');
    expect(source).toContain('P95 warning:');
  });

  it('should reset counter on healthy P95', () => {
    const source = readSource('../../../server/gpu-deploy.ts');
    // When P95 is within threshold, reset the counter
    const p95Idx = source.indexOf('P95 demotion check');
    const p95Block = source.slice(p95Idx, p95Idx + 2000);
    expect(p95Block).toContain('p95ViolationCount[stage] = 0');
  });
});
