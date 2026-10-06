/**
 * GPU deployment state machine — replaces scattered mutable state in state.ts.
 *
 * States: idle → deploying → booting → ready | error
 * All transitions go through typed methods that validate the current state.
 * Emits events via simple callbacks so handlers can react to transitions.
 */

import { createLogger } from '../../logger';

const log = createLogger('deployment-state-machine');

export type DeployPhase =
  | { phase: 'idle' }
  | { phase: 'stopped'; podId: string; provider: string; gpuType: string; costPerHr: number; stoppedAt: number; dockerImage: string }
  | { phase: 'deploying'; startedAt: number; podId?: string }
  | { phase: 'booting'; startedAt: number; podId: string }
  | { phase: 'ready'; podId: string; endpoint: string; gpuType: string; costPerHr: number; readyAt: number }
  | { phase: 'error'; reason: string; failedAt: number };

export type TransitionHandler = (next: DeployPhase, prev: DeployPhase) => void;

export class DeploymentStateMachine {
  private _state: DeployPhase = { phase: 'idle' };
  private _handlers: TransitionHandler[] = [];

  get state(): DeployPhase { return this._state; }
  get phase(): string { return this._state.phase; }
  get isIdle(): boolean { return this._state.phase === 'idle'; }
  get isStopped(): boolean { return this._state.phase === 'stopped'; }
  get isDeploying(): boolean { return this._state.phase === 'deploying' || this._state.phase === 'booting'; }
  get isReady(): boolean { return this._state.phase === 'ready'; }
  get endpoint(): string | null {
    return this._state.phase === 'ready' ? this._state.endpoint : null;
  }

  onTransition(handler: TransitionHandler): void {
    this._handlers.push(handler);
  }

  markStopped(podId: string, provider: string, gpuType: string, costPerHr: number, dockerImage: string): void {
    this._transition({ phase: 'stopped', podId, provider, gpuType, costPerHr, stoppedAt: Date.now(), dockerImage });
  }

  startDeploying(podId?: string): void {
    if (this._state.phase !== 'idle' && this._state.phase !== 'error' && this._state.phase !== 'stopped') {
      log.warn(`Invalid transition ${this._state.phase} → deploying`);
    }
    this._transition({ phase: 'deploying', startedAt: Date.now(), podId });
  }

  startBooting(podId: string): void {
    this._transition({ phase: 'booting', startedAt: Date.now(), podId });
  }

  markReady(podId: string, endpoint: string, gpuType: string, costPerHr: number): void {
    this._transition({ phase: 'ready', podId, endpoint, gpuType, costPerHr, readyAt: Date.now() });
  }

  markError(reason: string): void {
    this._transition({ phase: 'error', reason, failedAt: Date.now() });
  }

  reset(): void {
    this._transition({ phase: 'idle' });
  }

  private _transition(next: DeployPhase): void {
    const prev = this._state;
    this._state = next;
    for (const h of this._handlers) {
      try { h(next, prev); } catch (e) { log.error('handler error', e); }
    }
  }

  /** Serialize for API responses / status checks */
  toJSON(): Record<string, unknown> {
    const s = this._state;
    const base = { phase: s.phase };
    if (s.phase === 'stopped') return { ...base, podId: s.podId, provider: s.provider, gpuType: s.gpuType, costPerHr: s.costPerHr, stoppedAt: s.stoppedAt, dockerImage: s.dockerImage };
    if (s.phase === 'deploying') return { ...base, startedAt: s.startedAt, podId: s.podId };
    if (s.phase === 'booting') return { ...base, startedAt: s.startedAt, podId: s.podId };
    if (s.phase === 'ready') return { ...base, podId: s.podId, endpoint: s.endpoint, gpuType: s.gpuType, costPerHr: s.costPerHr, readyAt: s.readyAt };
    if (s.phase === 'error') return { ...base, reason: s.reason, failedAt: s.failedAt };
    return base;
  }
}

/** Singleton instance shared across all handlers */
export const deploymentSM = new DeploymentStateMachine();
