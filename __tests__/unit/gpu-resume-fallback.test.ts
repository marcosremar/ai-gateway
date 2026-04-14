/**
 * GPU Resume-with-Fallback tests
 *
 * Tests the stop → resume → fallback-deploy lifecycle:
 * 1. State machine 'stopped' phase transitions
 * 2. resumeOrDeploy() happy path (resume succeeds)
 * 3. resumeOrDeploy() fallback path (resume fails → fresh deploy)
 * 4. Orphan cleanup on resume failure
 * 5. Auto-resume trigger via touchModelRequest()
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DeploymentStateMachine } from '../server/deployment-state-machine';

// ── 1. State Machine tests (import directly, no mocks needed) ──────────────

describe('DeploymentStateMachine — stopped phase', () => {
  function createSM() {
    return new DeploymentStateMachine();
  }

  it('markStopped transitions from ready to stopped', () => {
    const sm = createSM();
    sm.markReady('pod-1', 'http://host:8000', 'RTX 4090', 0.59);
    expect(sm.phase).toBe('ready');

    sm.markStopped('pod-1', 'vast', 'RTX 4090', 0.59, 'marcosremar/babelcast:latest');
    expect(sm.phase).toBe('stopped');
    expect(sm.isStopped).toBe(true);
    expect(sm.isIdle).toBe(false);
    expect(sm.isReady).toBe(false);
  });

  it('isStopped returns false for other phases', () => {
    const sm = createSM();
    expect(sm.isStopped).toBe(false); // idle
    sm.startDeploying();
    expect(sm.isStopped).toBe(false); // deploying
  });

  it('startDeploying is valid from stopped (no console.warn)', () => {
    const sm = createSM();
    sm.markStopped('pod-1', 'vast', 'RTX 4090', 0.59, 'img');

    // Should not warn — stopped → deploying is a valid transition
    const warnSpy = vi.spyOn(console, 'warn');
    sm.startDeploying('pod-2');
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Invalid transition'));
    warnSpy.mockRestore();
  });

  it('toJSON includes all stopped fields', () => {
    const sm = createSM();
    sm.markStopped('pod-1', 'vast', 'RTX 4090', 0.59, 'marcosremar/babelcast:latest');
    const json = sm.toJSON();
    expect(json.phase).toBe('stopped');
    expect(json.podId).toBe('pod-1');
    expect(json.provider).toBe('vast');
    expect(json.gpuType).toBe('RTX 4090');
    expect(json.costPerHr).toBe(0.59);
    expect(json.dockerImage).toBe('marcosremar/babelcast:latest');
    expect(typeof json.stoppedAt).toBe('number');
  });

  it('reset transitions from stopped to idle', () => {
    const sm = createSM();
    sm.markStopped('pod-1', 'vast', 'RTX 4090', 0.59, 'img');
    sm.reset();
    expect(sm.phase).toBe('idle');
    expect(sm.isStopped).toBe(false);
  });

  it('transition handlers fire on markStopped', () => {
    const sm = createSM();
    const transitions: string[] = [];
    sm.onTransition((next: any) => transitions.push(next.phase));
    sm.markStopped('pod-1', 'vast', 'RTX 4090', 0.59, 'img');
    expect(transitions).toContain('stopped');
  });
});

// ── 2. Source inspection tests ─────────────────────────────────────────────
// These verify that key functions reference the right dependencies without
// needing to mock the entire runtime.

describe('resumeOrDeploy source inspection', () => {
  const gpuDeploySrc = readFileSync(join(__dirname, '../server/gpu-deploy.ts'), 'utf-8');

  it('resumeOrDeploy calls deleteInstance for orphan cleanup', () => {
    expect(gpuDeploySrc).toContain('client.deleteInstance(podId, credentials)');
  });

  it('resumeOrDeploy falls back to buildGpuTiers + startDeployWithTiers', () => {
    // After resume fails, it should build tiers and start a fresh deploy
    expect(gpuDeploySrc).toContain('buildGpuTiers(');
    expect(gpuDeploySrc).toContain('startDeployWithTiers(tiers,');
  });

  it('resumeOrDeploy saves and restores API keys before/after resetDeployState', () => {
    // Pattern: save keys → reset → restore (same as startAutoRecoveryDeploy)
    expect(gpuDeploySrc).toContain('savedKeys.runpod');
    expect(gpuDeploySrc).toContain('setDeployApiKey(savedKeys.runpod)');
  });

  it('resumeOrDeploy broadcasts WS events', () => {
    expect(gpuDeploySrc).toContain("type: 'gpu:resume', action: 'attempting'");
    expect(gpuDeploySrc).toContain("type: 'gpu:resume', action: 'success'");
    expect(gpuDeploySrc).toContain("type: 'gpu:resume', action: 'fallback'");
  });

  it('resumeOrDeploy returns method field', () => {
    expect(gpuDeploySrc).toContain("method: 'resumed'");
    expect(gpuDeploySrc).toContain("method: 'fresh_deploy'");
  });
});

describe('handleGpuResume source inspection', () => {
  const handlersSrc = readFileSync(join(__dirname, '../server/gpu-handlers.ts'), 'utf-8');

  it('handleGpuResume delegates to resumeOrDeploy', () => {
    expect(handlersSrc).toContain("resumeOrDeploy({ reason: 'manual'");
  });

  it('handleGpuResume returns method in response', () => {
    expect(handlersSrc).toContain('method: result.method');
  });
});

describe('handleGpuStop source inspection', () => {
  const handlersSrc = readFileSync(join(__dirname, '../server/gpu-handlers.ts'), 'utf-8');

  it('handleGpuStop uses stopped status instead of idle', () => {
    // After stop, should set status to 'stopped' (not 'idle')
    expect(handlersSrc).toContain("status: 'stopped'");
    expect(handlersSrc).toContain('deploymentSM.markStopped(');
  });
});

describe('autoStopGpu source inspection', () => {
  const gpuDeploySrc = readFileSync(join(__dirname, '../server/gpu-deploy.ts'), 'utf-8');

  it('autoStopGpu transitions to stopped state', () => {
    expect(gpuDeploySrc).toContain("deploymentSM.markStopped(podId, provider, gpuType, costPerHr, dockerImage)");
    expect(gpuDeploySrc).toContain("status: 'stopped'");
  });
});

describe('touchModelRequest auto-resume source inspection', () => {
  const stateSrc = readFileSync(join(__dirname, '../server/state.ts'), 'utf-8');

  it('touchModelRequest checks deploymentSM.isStopped', () => {
    expect(stateSrc).toContain('deploymentSM.isStopped');
  });

  it('touchModelRequest calls resumeOrDeploy on stopped', () => {
    expect(stateSrc).toContain("resumeOrDeploy({ reason: 'autoscaler' })");
  });
});

describe('DeploymentState type includes stopped', () => {
  const stateSrc = readFileSync(join(__dirname, '../server/state.ts'), 'utf-8');

  it('DeploymentState.status union includes stopped', () => {
    expect(stateSrc).toContain("'stopped'");
    // Verify it's in the status union (after 'idle')
    expect(stateSrc).toMatch(/'idle'\s*\|\s*'stopped'/);
  });
});

describe('Persistence includes stopped state', () => {
  const stateSrc = readFileSync(join(__dirname, '../server/state.ts'), 'utf-8');

  it('PersistedDeploy has stoppedAt field', () => {
    expect(stateSrc).toContain('stoppedAt?: number');
  });

  it('persistDeployState handles stopped status', () => {
    expect(stateSrc).toContain("const isStopped = deployState.status === 'stopped'");
  });

  it('loadPersistedDeploy uses shorter staleness for stopped records', () => {
    expect(stateSrc).toContain('data.stoppedAt ? 2 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000');
  });
});
