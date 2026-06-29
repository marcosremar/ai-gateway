// ── DeploymentStateMachine — unit tests ──────────────────────────────────────
// Covers all state transitions, guard computeds, onTransition callbacks,
// toJSON serialisation, and the exported singleton.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeploymentStateMachine, deploymentSM } from '../../src/gateway/deploy/state-machine';

// ── helpers ───────────────────────────────────────────────────────────────────

function freshSM() {
  return new DeploymentStateMachine();
}

// ── initial state ─────────────────────────────────────────────────────────────

describe('DeploymentStateMachine — initial state', () => {
  it('starts in idle phase', () => {
    const sm = freshSM();
    expect(sm.phase).toBe('idle');
  });

  it('isIdle is true initially', () => {
    expect(freshSM().isIdle).toBe(true);
  });

  it('isDeploying is false initially', () => {
    expect(freshSM().isDeploying).toBe(false);
  });

  it('isReady is false initially', () => {
    expect(freshSM().isReady).toBe(false);
  });

  it('isStopped is false initially', () => {
    expect(freshSM().isStopped).toBe(false);
  });

  it('endpoint is null initially', () => {
    expect(freshSM().endpoint).toBeNull();
  });

  it('state.phase is idle', () => {
    expect(freshSM().state.phase).toBe('idle');
  });
});

// ── startDeploying ─────────────────────────────────────────────────────────────

describe('startDeploying', () => {
  it('transitions idle → deploying', () => {
    const sm = freshSM();
    sm.startDeploying();
    expect(sm.phase).toBe('deploying');
  });

  it('isDeploying is true after startDeploying', () => {
    const sm = freshSM();
    sm.startDeploying();
    expect(sm.isDeploying).toBe(true);
  });

  it('isIdle becomes false', () => {
    const sm = freshSM();
    sm.startDeploying();
    expect(sm.isIdle).toBe(false);
  });

  it('stores optional podId in state', () => {
    const sm = freshSM();
    sm.startDeploying('pod-abc');
    const s = sm.state;
    expect(s.phase).toBe('deploying');
    if (s.phase === 'deploying') expect(s.podId).toBe('pod-abc');
  });

  it('startedAt is set to a recent timestamp', () => {
    const before = Date.now();
    const sm = freshSM();
    sm.startDeploying();
    const s = sm.state;
    if (s.phase === 'deploying') {
      expect(s.startedAt).toBeGreaterThanOrEqual(before);
      expect(s.startedAt).toBeLessThanOrEqual(Date.now());
    }
  });

  it('transitions from error → deploying without throwing', () => {
    const sm = freshSM();
    sm.markError('oops');
    sm.startDeploying();
    expect(sm.phase).toBe('deploying');
  });

  it('transitions from stopped → deploying without throwing', () => {
    const sm = freshSM();
    sm.markStopped('pod-1', 'runpod', 'RTX4090', 0.5, 'img:latest');
    sm.startDeploying();
    expect(sm.phase).toBe('deploying');
  });
});

// ── startBooting ──────────────────────────────────────────────────────────────

describe('startBooting', () => {
  it('transitions deploying → booting', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('pod-xyz');
    expect(sm.phase).toBe('booting');
  });

  it('isDeploying remains true while booting', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('pod-xyz');
    expect(sm.isDeploying).toBe(true);
  });

  it('stores podId in booting state', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('pod-xyz');
    const s = sm.state;
    if (s.phase === 'booting') expect(s.podId).toBe('pod-xyz');
  });

  it('startedAt is set on booting', () => {
    const before = Date.now();
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('pod-xyz');
    const s = sm.state;
    if (s.phase === 'booting') {
      expect(s.startedAt).toBeGreaterThanOrEqual(before);
    }
  });
});

// ── markReady ─────────────────────────────────────────────────────────────────

describe('markReady', () => {
  function readySM() {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('pod-1');
    sm.markReady('pod-1', 'http://gpu:8000', 'RTX4090', 0.49);
    return sm;
  }

  it('transitions to ready', () => {
    expect(readySM().phase).toBe('ready');
  });

  it('isReady becomes true', () => {
    expect(readySM().isReady).toBe(true);
  });

  it('isDeploying becomes false', () => {
    expect(readySM().isDeploying).toBe(false);
  });

  it('endpoint returns the URL', () => {
    expect(readySM().endpoint).toBe('http://gpu:8000');
  });

  it('stores podId, gpuType, costPerHr in ready state', () => {
    const sm = readySM();
    const s = sm.state;
    if (s.phase === 'ready') {
      expect(s.podId).toBe('pod-1');
      expect(s.gpuType).toBe('RTX4090');
      expect(s.costPerHr).toBe(0.49);
    }
  });

  it('readyAt is set to a recent timestamp', () => {
    const before = Date.now();
    const sm = readySM();
    const s = sm.state;
    if (s.phase === 'ready') {
      expect(s.readyAt).toBeGreaterThanOrEqual(before);
    }
  });
});

// ── markError ─────────────────────────────────────────────────────────────────

describe('markError', () => {
  it('transitions idle → error', () => {
    const sm = freshSM();
    sm.markError('network timeout');
    expect(sm.phase).toBe('error');
  });

  it('transitions deploying → error', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.markError('pod rejected');
    expect(sm.phase).toBe('error');
  });

  it('stores reason in error state', () => {
    const sm = freshSM();
    sm.markError('out of capacity');
    const s = sm.state;
    if (s.phase === 'error') expect(s.reason).toBe('out of capacity');
  });

  it('failedAt is set on error', () => {
    const before = Date.now();
    const sm = freshSM();
    sm.markError('x');
    const s = sm.state;
    if (s.phase === 'error') {
      expect(s.failedAt).toBeGreaterThanOrEqual(before);
    }
  });

  it('isReady becomes false after error', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('p');
    sm.markReady('p', 'http://x', 'A100', 1.0);
    sm.markError('crashed');
    expect(sm.isReady).toBe(false);
  });

  it('endpoint returns null after error', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('p');
    sm.markReady('p', 'http://x', 'A100', 1.0);
    sm.markError('crashed');
    expect(sm.endpoint).toBeNull();
  });
});

// ── markStopped ───────────────────────────────────────────────────────────────

describe('markStopped', () => {
  it('transitions to stopped', () => {
    const sm = freshSM();
    sm.markStopped('pod-99', 'vast', 'RTX4090', 0.35, 'img:latest');
    expect(sm.phase).toBe('stopped');
  });

  it('isStopped becomes true', () => {
    const sm = freshSM();
    sm.markStopped('pod-99', 'vast', 'RTX4090', 0.35, 'img:latest');
    expect(sm.isStopped).toBe(true);
  });

  it('isReady becomes false', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('p');
    sm.markReady('p', 'http://x', 'RTX4090', 0.5);
    sm.markStopped('p', 'runpod', 'RTX4090', 0.5, 'img:latest');
    expect(sm.isReady).toBe(false);
  });

  it('stores all stopped fields', () => {
    const before = Date.now();
    const sm = freshSM();
    sm.markStopped('pod-42', 'tensordock', 'A6000', 0.55, 'my-image:v2');
    const s = sm.state;
    if (s.phase === 'stopped') {
      expect(s.podId).toBe('pod-42');
      expect(s.provider).toBe('tensordock');
      expect(s.gpuType).toBe('A6000');
      expect(s.costPerHr).toBe(0.55);
      expect(s.dockerImage).toBe('my-image:v2');
      expect(s.stoppedAt).toBeGreaterThanOrEqual(before);
    }
  });

  it('endpoint is null when stopped', () => {
    const sm = freshSM();
    sm.markStopped('p', 'vast', 'RTX4090', 0.35, 'img');
    expect(sm.endpoint).toBeNull();
  });
});

// ── reset ─────────────────────────────────────────────────────────────────────

describe('reset', () => {
  it('returns to idle from deploying', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.reset();
    expect(sm.phase).toBe('idle');
  });

  it('returns to idle from ready', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('p');
    sm.markReady('p', 'http://gpu', 'RTX4090', 0.5);
    sm.reset();
    expect(sm.isIdle).toBe(true);
  });

  it('returns to idle from error', () => {
    const sm = freshSM();
    sm.markError('fail');
    sm.reset();
    expect(sm.phase).toBe('idle');
  });

  it('endpoint is null after reset', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('p');
    sm.markReady('p', 'http://endpoint', 'RTX4090', 1.0);
    sm.reset();
    expect(sm.endpoint).toBeNull();
  });

  it('isIdle is true after reset from stopped', () => {
    const sm = freshSM();
    sm.markStopped('p', 'runpod', 'RTX4090', 0.5, 'img');
    sm.reset();
    expect(sm.isIdle).toBe(true);
  });
});

// ── onTransition ──────────────────────────────────────────────────────────────

describe('onTransition callbacks', () => {
  it('fires handler with (next, prev) on transition', () => {
    const sm = freshSM();
    const handler = vi.fn();
    sm.onTransition(handler);
    sm.startDeploying();
    expect(handler).toHaveBeenCalledOnce();
    const [next, prev] = handler.mock.calls[0];
    expect(prev.phase).toBe('idle');
    expect(next.phase).toBe('deploying');
  });

  it('fires for every transition', () => {
    const sm = freshSM();
    const handler = vi.fn();
    sm.onTransition(handler);
    sm.startDeploying();
    sm.startBooting('p');
    sm.markReady('p', 'http://x', 'RTX4090', 0.5);
    sm.reset();
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('multiple handlers all receive the transition', () => {
    const sm = freshSM();
    const h1 = vi.fn();
    const h2 = vi.fn();
    sm.onTransition(h1);
    sm.onTransition(h2);
    sm.startDeploying();
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('swallows handler errors so other handlers still run', () => {
    const sm = freshSM();
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const safe = vi.fn();
    sm.onTransition(throwing);
    sm.onTransition(safe);
    expect(() => sm.startDeploying()).not.toThrow();
    expect(safe).toHaveBeenCalledOnce();
  });

  it('handler receives previous state as second arg on error transition', () => {
    const sm = freshSM();
    sm.startDeploying();
    const handler = vi.fn();
    sm.onTransition(handler);
    sm.markError('oops');
    const [, prev] = handler.mock.calls[0];
    expect(prev.phase).toBe('deploying');
  });
});

// ── toJSON ────────────────────────────────────────────────────────────────────

describe('toJSON', () => {
  it('idle serialises to { phase: "idle" }', () => {
    expect(freshSM().toJSON()).toEqual({ phase: 'idle' });
  });

  it('deploying includes startedAt', () => {
    const sm = freshSM();
    sm.startDeploying('pod-1');
    const j = sm.toJSON();
    expect(j.phase).toBe('deploying');
    expect(typeof j.startedAt).toBe('number');
    expect(j.podId).toBe('pod-1');
  });

  it('booting includes startedAt and podId', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('pod-boot');
    const j = sm.toJSON();
    expect(j.phase).toBe('booting');
    expect(j.podId).toBe('pod-boot');
    expect(typeof j.startedAt).toBe('number');
  });

  it('ready includes endpoint, gpuType, costPerHr, and readyAt timestamp', () => {
    const sm = freshSM();
    const before = Date.now();
    sm.startDeploying();
    sm.startBooting('pod-r');
    sm.markReady('pod-r', 'http://gpu:9000', 'A6000', 0.75);
    const j = sm.toJSON();
    expect(j.phase).toBe('ready');
    expect(j.endpoint).toBe('http://gpu:9000');
    expect(j.gpuType).toBe('A6000');
    expect(j.costPerHr).toBe(0.75);
    expect(j.podId).toBe('pod-r');
    // readyAt was added so callers can compute time-to-ready
    expect(typeof j.readyAt).toBe('number');
    expect(j.readyAt as number).toBeGreaterThanOrEqual(before);
  });

  it('error includes reason and failedAt timestamp', () => {
    const sm = freshSM();
    const before = Date.now();
    sm.markError('no capacity');
    const j = sm.toJSON();
    expect(j.phase).toBe('error');
    expect(j.reason).toBe('no capacity');
    // failedAt was added so callers can compute time-since-failure
    expect(typeof j.failedAt).toBe('number');
    expect(j.failedAt as number).toBeGreaterThanOrEqual(before);
  });

  it('stopped includes all stopped fields', () => {
    const sm = freshSM();
    sm.markStopped('pod-s', 'vast', 'L40S', 0.60, 'myimg:latest');
    const j = sm.toJSON();
    expect(j.phase).toBe('stopped');
    expect(j.podId).toBe('pod-s');
    expect(j.provider).toBe('vast');
    expect(j.gpuType).toBe('L40S');
    expect(j.costPerHr).toBe(0.60);
    expect(j.dockerImage).toBe('myimg:latest');
    expect(typeof j.stoppedAt).toBe('number');
  });
});

// ── full lifecycle round-trips ────────────────────────────────────────────────

describe('full lifecycle round-trips', () => {
  it('idle → deploying → booting → ready → idle', () => {
    const sm = freshSM();
    sm.startDeploying('p1');
    expect(sm.phase).toBe('deploying');
    sm.startBooting('p1');
    expect(sm.phase).toBe('booting');
    sm.markReady('p1', 'http://ready', 'RTX4090', 0.49);
    expect(sm.isReady).toBe(true);
    expect(sm.endpoint).toBe('http://ready');
    sm.reset();
    expect(sm.isIdle).toBe(true);
    expect(sm.endpoint).toBeNull();
  });

  it('idle → deploying → error → deploying (retry)', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.markError('cold start failed');
    expect(sm.phase).toBe('error');
    sm.startDeploying();
    expect(sm.phase).toBe('deploying');
  });

  it('ready → stopped → deploying (resume cycle)', () => {
    const sm = freshSM();
    sm.startDeploying();
    sm.startBooting('p');
    sm.markReady('p', 'http://x', 'RTX4090', 0.5);
    sm.markStopped('p', 'runpod', 'RTX4090', 0.5, 'img');
    expect(sm.isStopped).toBe(true);
    sm.startDeploying();
    expect(sm.isDeploying).toBe(true);
  });

  it('transitions accumulate correct callback sequence', () => {
    const phases: string[] = [];
    const sm = freshSM();
    sm.onTransition((next) => phases.push(next.phase));
    sm.startDeploying();
    sm.startBooting('p');
    sm.markReady('p', 'http://x', 'RTX4090', 0.5);
    sm.markError('post-ready crash');
    sm.reset();
    expect(phases).toEqual(['deploying', 'booting', 'ready', 'error', 'idle']);
  });
});

// ── singleton export ──────────────────────────────────────────────────────────

describe('deploymentSM singleton', () => {
  it('is an instance of DeploymentStateMachine', () => {
    expect(deploymentSM).toBeInstanceOf(DeploymentStateMachine);
  });

  it('starts in idle or a valid phase (may carry state from module init)', () => {
    const validPhases = ['idle', 'deploying', 'booting', 'ready', 'error', 'stopped'];
    expect(validPhases).toContain(deploymentSM.phase);
  });
});
