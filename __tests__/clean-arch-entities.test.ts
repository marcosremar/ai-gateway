/**
 * Clean Architecture entities — validate that invariants are enforced.
 *
 * These entities are the heart of the new domain layer: state transitions
 * only happen through entity methods, illegal transitions throw.
 */

import { describe, it, expect } from 'vitest';
import { Deployment, InvalidDeployTransitionError } from '../src/gateway/entities/deployment';
import {
  Workload,
  InvalidWorkloadTransitionError,
} from '../src/gateway/entities/workload';
import { Budget, BudgetExceededError } from '../src/gateway/entities/value-objects/budget';
import { DeployId } from '../src/gateway/entities/value-objects/deploy-id';

describe('DeployId', () => {
  it('generates branded unique IDs', () => {
    const a = DeployId.generate();
    const b = DeployId.generate();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^dep_/);
  });

  it('rejects empty strings', () => {
    expect(() => DeployId.from('')).toThrow();
  });
});

describe('Budget', () => {
  it('unlimited budget always allows deploys', () => {
    const b = Budget.unlimited(100);
    const d = b.canAfford(5);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('no_cap');
  });

  it('hard limit blocks deploys above cap', () => {
    const b = Budget.of(10, 8);
    const d = b.canAfford(5); // 8 + 5 = 13 > 10
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('hard_limit_exceeded');
  });

  it('soft limit blocks new deploys at >=80% spend', () => {
    const b = Budget.of(10, 8.5); // 85% already
    const d = b.canAfford(0.1);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('soft_limit_exceeded');
  });

  it('under cap allows deploys', () => {
    const b = Budget.of(10, 2);
    const d = b.canAfford(3); // 2 + 3 = 5, 20% of cap
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('under_cap');
  });

  it('rejects negative cap', () => {
    expect(() => Budget.of(-1, 0)).toThrow();
  });

  it('rejects negative estimated cost', () => {
    const b = Budget.of(10, 0);
    expect(() => b.canAfford(-1)).toThrow();
  });

  it('BudgetExceededError carries structured decision', () => {
    const b = Budget.of(10, 9);
    const d = b.canAfford(5);
    const err = new BudgetExceededError(d);
    expect(err.decision.reason).toBe('hard_limit_exceeded');
    expect(err.message).toContain('hard_limit_exceeded');
  });
});

describe('Deployment entity', () => {
  it('starts in idle phase', () => {
    const d = Deployment.create({ provider: 'runpod' });
    expect(d.phase).toBe('idle');
    expect(d.isReady).toBe(false);
  });

  it('follows happy path: idle → searching → creating → booting → ready', () => {
    let d = Deployment.create({ provider: 'runpod' });
    d = d.startSearch('runpod');
    expect(d.phase).toBe('searching');
    d = d.markCreating('pod-123', 'RTX 4090', 0.5);
    expect(d.phase).toBe('creating');
    d = d.markBooting('https://pod-123.runpod.io');
    expect(d.phase).toBe('booting');
    d = d.markReady();
    expect(d.phase).toBe('ready');
    expect(d.isReady).toBe(true);
    expect(d.endpoint).toBe('https://pod-123.runpod.io');
  });

  it('refuses illegal transitions', () => {
    const d = Deployment.create();
    expect(() => d.markReady()).toThrow(InvalidDeployTransitionError);
    expect(() => d.markBooting('ep')).toThrow(InvalidDeployTransitionError);
  });

  it('can transition to error from any phase', () => {
    const d = Deployment.create({ provider: 'vast' }).startSearch('vast');
    const err = d.markError('API 429');
    expect(err.phase).toBe('error');
    expect(err.snapshot.errorMessage).toBe('API 429');
  });

  it('reset returns to idle only from error', () => {
    const d = Deployment.create().startSearch('runpod').markError('boom');
    const reset = d.reset();
    expect(reset.phase).toBe('idle');
    expect(reset.snapshot.errorMessage).toBe('');
  });

  it('is immutable — each transition returns a new Deployment', () => {
    const a = Deployment.create({ provider: 'runpod' });
    const b = a.startSearch('runpod');
    expect(a.phase).toBe('idle');      // original unchanged
    expect(b.phase).toBe('searching'); // new instance changed
    expect(a).not.toBe(b);
  });

  it('rehydrates from snapshot for persistence', () => {
    const a = Deployment.create({ provider: 'modal' })
      .startSearch('modal')
      .markCreating('pod-x', 'A100', 1.2)
      .markBooting('ep');
    const b = Deployment.rehydrate(a.snapshot);
    expect(b.phase).toBe('booting');
    expect(b.snapshot.podId).toBe('pod-x');
    expect(b.snapshot.gpuType).toBe('A100');
  });
});

describe('Workload entity', () => {
  it('rejects empty name', () => {
    expect(() => Workload.create({ id: '1', type: 'gpu', name: '  ', provider: 'runpod' })).toThrow();
  });

  it('starts in deploying phase', () => {
    const w = Workload.create({ id: '1', type: 'db', name: 'my-db', provider: 'neon' });
    expect(w.phase).toBe('deploying');
  });

  it('transitions deploying → running → stopped', () => {
    let w = Workload.create({ id: '1', type: 'gpu', name: 'x', provider: 'runpod' });
    w = w.markRunning('ep', 'inst-1');
    expect(w.phase).toBe('running');
    w = w.markStopped();
    expect(w.phase).toBe('stopped');
  });

  it('refuses transition from stopped to running directly (must go through deploying)', () => {
    const w = Workload.create({ id: '1', type: 'gpu', name: 'x', provider: 'runpod' })
      .markRunning('ep', 'inst-1')
      .markStopped();
    expect(() => w.markRunning('ep', 'inst-1')).toThrow(InvalidWorkloadTransitionError);
  });

  it('allows resume via deploying → running', () => {
    const stopped = Workload.create({ id: '1', type: 'gpu', name: 'x', provider: 'runpod' })
      .markRunning('ep', 'inst-1')
      .markStopped();
    const w = stopped.markDeploying().markRunning('ep2', 'inst-2');
    expect(w.phase).toBe('running');
    expect(w.endpoint).toBe('ep2');
  });

  it('carries error message on error transition', () => {
    const w = Workload.create({ id: '1', type: 'bot', name: 'b', provider: 'fly' })
      .markError('join timeout');
    expect(w.phase).toBe('error');
    expect(w.snapshot.errorMessage).toBe('join timeout');
  });
});
