import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeploymentStateMachine } from '../src/gateway/deploy/state-machine';

describe('DeploymentStateMachine', () => {
  let sm: DeploymentStateMachine;

  beforeEach(() => {
    sm = new DeploymentStateMachine();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts in idle phase', () => {
      expect(sm.phase).toBe('idle');
      expect(sm.state).toEqual({ phase: 'idle' });
    });

    it('isIdle is true initially', () => {
      expect(sm.isIdle).toBe(true);
    });

    it('isDeploying is false initially', () => {
      expect(sm.isDeploying).toBe(false);
    });

    it('isReady is false initially', () => {
      expect(sm.isReady).toBe(false);
    });

    it('isStopped is false initially', () => {
      expect(sm.isStopped).toBe(false);
    });

    it('endpoint is null initially', () => {
      expect(sm.endpoint).toBeNull();
    });
  });

  // ── startDeploying ────────────────────────────────────────────────────────

  describe('startDeploying()', () => {
    it('transitions idle → deploying', () => {
      sm.startDeploying();
      expect(sm.phase).toBe('deploying');
    });

    it('sets isDeploying to true', () => {
      sm.startDeploying();
      expect(sm.isDeploying).toBe(true);
      expect(sm.isIdle).toBe(false);
    });

    it('stores startedAt timestamp', () => {
      const before = Date.now();
      sm.startDeploying();
      const after = Date.now();
      const s = sm.state as Extract<typeof sm.state, { phase: 'deploying' }>;
      expect(s.startedAt).toBeGreaterThanOrEqual(before);
      expect(s.startedAt).toBeLessThanOrEqual(after);
    });

    it('can carry an optional podId', () => {
      sm.startDeploying('pod-123');
      const s = sm.state as Extract<typeof sm.state, { phase: 'deploying' }>;
      expect(s.podId).toBe('pod-123');
    });

    it('podId is undefined when not supplied', () => {
      sm.startDeploying();
      const s = sm.state as Extract<typeof sm.state, { phase: 'deploying' }>;
      expect(s.podId).toBeUndefined();
    });

    it('allows transition from error → deploying', () => {
      sm.markError('prior failure');
      sm.startDeploying();
      expect(sm.phase).toBe('deploying');
    });

    it('allows transition from stopped → deploying', () => {
      sm.markStopped('pod-1', 'runpod', 'RTX 4090', 0.5, 'img:latest');
      sm.startDeploying();
      expect(sm.phase).toBe('deploying');
    });
  });

  // ── startBooting ─────────────────────────────────────────────────────────

  describe('startBooting()', () => {
    it('transitions deploying → booting', () => {
      sm.startDeploying();
      sm.startBooting('pod-abc');
      expect(sm.phase).toBe('booting');
    });

    it('isDeploying is still true during booting', () => {
      sm.startDeploying();
      sm.startBooting('pod-abc');
      expect(sm.isDeploying).toBe(true);
    });

    it('stores podId on booting state', () => {
      sm.startDeploying();
      sm.startBooting('pod-abc');
      const s = sm.state as Extract<typeof sm.state, { phase: 'booting' }>;
      expect(s.podId).toBe('pod-abc');
    });

    it('stores startedAt on booting state', () => {
      sm.startDeploying();
      const before = Date.now();
      sm.startBooting('pod-abc');
      const after = Date.now();
      const s = sm.state as Extract<typeof sm.state, { phase: 'booting' }>;
      expect(s.startedAt).toBeGreaterThanOrEqual(before);
      expect(s.startedAt).toBeLessThanOrEqual(after);
    });
  });

  // ── markReady ─────────────────────────────────────────────────────────────

  describe('markReady()', () => {
    it('transitions booting → ready', () => {
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      expect(sm.phase).toBe('ready');
    });

    it('isReady is true after markReady', () => {
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      expect(sm.isReady).toBe(true);
      expect(sm.isDeploying).toBe(false);
    });

    it('exposes endpoint via getter', () => {
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      expect(sm.endpoint).toBe('http://gpu:8080');
    });

    it('stores all ready-state fields', () => {
      sm.startDeploying();
      sm.startBooting('pod-1');
      const before = Date.now();
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      const after = Date.now();
      const s = sm.state as Extract<typeof sm.state, { phase: 'ready' }>;
      expect(s.podId).toBe('pod-1');
      expect(s.endpoint).toBe('http://gpu:8080');
      expect(s.gpuType).toBe('RTX 4090');
      expect(s.costPerHr).toBe(1.2);
      expect(s.readyAt).toBeGreaterThanOrEqual(before);
      expect(s.readyAt).toBeLessThanOrEqual(after);
    });

    it('endpoint returns null when not ready', () => {
      sm.startDeploying();
      expect(sm.endpoint).toBeNull();
    });
  });

  // ── markError ────────────────────────────────────────────────────────────

  describe('markError()', () => {
    it('transitions any state → error', () => {
      sm.markError('deploy failed');
      expect(sm.phase).toBe('error');
    });

    it('stores reason and failedAt', () => {
      const before = Date.now();
      sm.markError('timeout');
      const after = Date.now();
      const s = sm.state as Extract<typeof sm.state, { phase: 'error' }>;
      expect(s.reason).toBe('timeout');
      expect(s.failedAt).toBeGreaterThanOrEqual(before);
      expect(s.failedAt).toBeLessThanOrEqual(after);
    });

    it('can transition from ready → error (crash)', () => {
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      sm.markError('pod crashed');
      expect(sm.phase).toBe('error');
      expect(sm.isReady).toBe(false);
    });

    it('can transition from deploying → error', () => {
      sm.startDeploying('pod-x');
      sm.markError('offer expired');
      expect(sm.phase).toBe('error');
    });
  });

  // ── markStopped ──────────────────────────────────────────────────────────

  describe('markStopped()', () => {
    it('transitions ready → stopped', () => {
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      sm.markStopped('pod-1', 'runpod', 'RTX 4090', 1.2, 'img:latest');
      expect(sm.phase).toBe('stopped');
    });

    it('isStopped is true', () => {
      sm.markStopped('pod-1', 'runpod', 'RTX 4090', 1.2, 'img:latest');
      expect(sm.isStopped).toBe(true);
      expect(sm.isIdle).toBe(false);
    });

    it('stores all stopped-state fields', () => {
      const before = Date.now();
      sm.markStopped('pod-1', 'runpod', 'RTX 4090', 1.2, 'img:latest');
      const after = Date.now();
      const s = sm.state as Extract<typeof sm.state, { phase: 'stopped' }>;
      expect(s.podId).toBe('pod-1');
      expect(s.provider).toBe('runpod');
      expect(s.gpuType).toBe('RTX 4090');
      expect(s.costPerHr).toBe(1.2);
      expect(s.dockerImage).toBe('img:latest');
      expect(s.stoppedAt).toBeGreaterThanOrEqual(before);
      expect(s.stoppedAt).toBeLessThanOrEqual(after);
    });

    it('endpoint returns null when stopped', () => {
      sm.markStopped('pod-1', 'runpod', 'RTX 4090', 1.2, 'img:latest');
      expect(sm.endpoint).toBeNull();
    });
  });

  // ── reset ────────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('returns to idle from ready', () => {
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      sm.reset();
      expect(sm.phase).toBe('idle');
      expect(sm.isIdle).toBe(true);
    });

    it('returns to idle from error', () => {
      sm.markError('failed');
      sm.reset();
      expect(sm.phase).toBe('idle');
    });

    it('returns to idle from deploying', () => {
      sm.startDeploying();
      sm.reset();
      expect(sm.phase).toBe('idle');
    });

    it('reset clears endpoint', () => {
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      sm.reset();
      expect(sm.endpoint).toBeNull();
    });
  });

  // ── onTransition handlers ────────────────────────────────────────────────

  describe('onTransition()', () => {
    it('calls handler on each state change', () => {
      const handler = vi.fn();
      sm.onTransition(handler);
      sm.startDeploying();
      expect(handler).toHaveBeenCalledOnce();
    });

    it('passes next and prev states to handler', () => {
      const calls: Array<[unknown, unknown]> = [];
      sm.onTransition((next, prev) => calls.push([next, prev]));
      sm.startDeploying();
      expect(calls[0][1]).toEqual({ phase: 'idle' });
      expect((calls[0][0] as { phase: string }).phase).toBe('deploying');
    });

    it('supports multiple handlers', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      sm.onTransition(h1);
      sm.onTransition(h2);
      sm.startDeploying();
      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });

    it('does not throw if a handler throws — other handlers still run', () => {
      const throwing = vi.fn(() => { throw new Error('handler error'); });
      const safe = vi.fn();
      sm.onTransition(throwing);
      sm.onTransition(safe);
      expect(() => sm.startDeploying()).not.toThrow();
      expect(safe).toHaveBeenCalledOnce();
    });

    it('accumulates handler calls across multiple transitions', () => {
      const handler = vi.fn();
      sm.onTransition(handler);
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('handler sees updated state.phase for each transition', () => {
      const phases: string[] = [];
      sm.onTransition(next => phases.push(next.phase));
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      sm.reset();
      expect(phases).toEqual(['deploying', 'booting', 'ready', 'idle']);
    });
  });

  // ── toJSON ───────────────────────────────────────────────────────────────

  describe('toJSON()', () => {
    it('serializes idle state', () => {
      expect(sm.toJSON()).toEqual({ phase: 'idle' });
    });

    it('serializes deploying state (with podId)', () => {
      sm.startDeploying('pod-abc');
      const j = sm.toJSON();
      expect(j.phase).toBe('deploying');
      expect(j.podId).toBe('pod-abc');
      expect(typeof j.startedAt).toBe('number');
    });

    it('serializes deploying state (without podId)', () => {
      sm.startDeploying();
      const j = sm.toJSON();
      expect(j.phase).toBe('deploying');
      expect(j.podId).toBeUndefined();
    });

    it('serializes booting state', () => {
      sm.startDeploying();
      sm.startBooting('pod-xyz');
      const j = sm.toJSON();
      expect(j.phase).toBe('booting');
      expect(j.podId).toBe('pod-xyz');
      expect(typeof j.startedAt).toBe('number');
    });

    it('serializes ready state', () => {
      sm.startDeploying();
      sm.startBooting('pod-1');
      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      const j = sm.toJSON();
      expect(j.phase).toBe('ready');
      expect(j.podId).toBe('pod-1');
      expect(j.endpoint).toBe('http://gpu:8080');
      expect(j.gpuType).toBe('RTX 4090');
      expect(j.costPerHr).toBe(1.2);
      expect(typeof j.readyAt).toBe('number');
    });

    it('serializes error state', () => {
      sm.markError('deploy timeout');
      const j = sm.toJSON();
      expect(j.phase).toBe('error');
      expect(j.reason).toBe('deploy timeout');
      expect(typeof j.failedAt).toBe('number');
    });

    it('serializes stopped state with all fields', () => {
      sm.markStopped('pod-s', 'vast', 'RTX A6000', 0.8, 'myimage:v2');
      const j = sm.toJSON();
      expect(j.phase).toBe('stopped');
      expect(j.podId).toBe('pod-s');
      expect(j.provider).toBe('vast');
      expect(j.gpuType).toBe('RTX A6000');
      expect(j.costPerHr).toBe(0.8);
      expect(j.dockerImage).toBe('myimage:v2');
      expect(typeof j.stoppedAt).toBe('number');
    });
  });

  // ── full lifecycle sequence ──────────────────────────────────────────────

  describe('full lifecycle', () => {
    it('idle → deploying → booting → ready → stopped → deploying (resume cycle)', () => {
      sm.startDeploying();
      expect(sm.phase).toBe('deploying');

      sm.startBooting('pod-1');
      expect(sm.phase).toBe('booting');

      sm.markReady('pod-1', 'http://gpu:8080', 'RTX 4090', 1.2);
      expect(sm.phase).toBe('ready');
      expect(sm.endpoint).toBe('http://gpu:8080');

      sm.markStopped('pod-1', 'runpod', 'RTX 4090', 1.2, 'img:latest');
      expect(sm.phase).toBe('stopped');
      expect(sm.isStopped).toBe(true);

      sm.startDeploying('pod-1');
      expect(sm.phase).toBe('deploying');
      expect(sm.isDeploying).toBe(true);
    });

    it('idle → deploying → error → deploying (retry cycle)', () => {
      sm.startDeploying();
      sm.markError('instance not found');
      expect(sm.phase).toBe('error');

      sm.startDeploying('pod-retry');
      expect(sm.phase).toBe('deploying');
    });

    it('ready → error → reset → idle (crash and clear cycle)', () => {
      sm.startDeploying();
      sm.startBooting('pod-2');
      sm.markReady('pod-2', 'http://gpu:9000', 'RTX A6000', 0.8);
      sm.markError('OOM crash');
      expect(sm.phase).toBe('error');

      sm.reset();
      expect(sm.phase).toBe('idle');
      expect(sm.isIdle).toBe(true);
    });

    it('isDeploying covers both deploying and booting phases', () => {
      sm.startDeploying();
      expect(sm.isDeploying).toBe(true);

      sm.startBooting('pod-3');
      expect(sm.isDeploying).toBe(true);

      sm.markReady('pod-3', 'http://gpu:8080', 'RTX 4090', 1.2);
      expect(sm.isDeploying).toBe(false);
    });
  });
});
