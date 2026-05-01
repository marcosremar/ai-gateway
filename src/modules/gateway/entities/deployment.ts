/**
 * Deployment — the aggregate root for a GPU deploy lifecycle.
 *
 * Classical Clean Architecture entity: encapsulates state + invariants, exposes
 * commands (methods) that validate transitions. Illegal states are impossible
 * because the only way to construct/mutate a Deployment is through methods.
 *
 * Note: this is an IMMUTABLE-event style entity — each mutation returns a new
 * Deployment. Concrete persistence layers (repositories) snapshot these.
 */

import { DeployId } from './value-objects/deploy-id';
import { type DeployPhase, assertTransition } from './value-objects/deploy-phase';

export type Provider =
  | 'runpod' | 'vast' | 'tensordock' | 'modal' | 'snapgpu' | '';

export interface DeploymentSnapshot {
  id: DeployId;
  phase: DeployPhase;
  provider: Provider;
  podId: string;
  endpoint: string;
  gpuType: string;
  dockerImage: string;
  startedAt: number;
  retryCount: number;
  costPerHr: number;
  /** Last-known error message when phase === 'error'. */
  errorMessage: string;
}

export class Deployment {
  private constructor(private readonly s: DeploymentSnapshot) {}

  // ── Factories ──────────────────────────────────────────────────────────

  /** Create a brand-new idle deployment. Starting point for all transitions. */
  static create(params: {
    id?: DeployId;
    provider?: Provider;
    gpuType?: string;
    dockerImage?: string;
  } = {}): Deployment {
    return new Deployment({
      id: params.id ?? DeployId.generate(),
      phase: 'idle',
      provider: params.provider ?? '',
      podId: '',
      endpoint: '',
      gpuType: params.gpuType ?? '',
      dockerImage: params.dockerImage ?? '',
      startedAt: 0,
      retryCount: 0,
      costPerHr: 0,
      errorMessage: '',
    });
  }

  /** Rehydrate from persisted snapshot — used by repositories on load. */
  static rehydrate(snapshot: DeploymentSnapshot): Deployment {
    return new Deployment({ ...snapshot });
  }

  // ── Queries ────────────────────────────────────────────────────────────

  get id(): DeployId { return this.s.id; }
  get phase(): DeployPhase { return this.s.phase; }
  get provider(): Provider { return this.s.provider; }
  get endpoint(): string { return this.s.endpoint; }
  get podId(): string { return this.s.podId; }
  get isReady(): boolean { return this.s.phase === 'ready'; }
  get isTerminal(): boolean { return this.s.phase === 'error' || this.s.phase === 'stopped'; }
  get snapshot(): Readonly<DeploymentSnapshot> { return this.s; }

  // ── Commands (state transitions) ───────────────────────────────────────

  /** Begin searching for an instance on a provider. idle → searching. */
  startSearch(provider: Provider): Deployment {
    assertTransition(this.s.phase, 'searching');
    return new Deployment({
      ...this.s,
      phase: 'searching',
      provider,
      startedAt: Date.now(),
    });
  }

  /** Provider accepted the request, instance is being created. searching|queued → creating. */
  markCreating(podId: string, gpuType: string, costPerHr: number): Deployment {
    assertTransition(this.s.phase, 'creating');
    return new Deployment({
      ...this.s,
      phase: 'creating',
      podId,
      gpuType: gpuType || this.s.gpuType,
      costPerHr,
    });
  }

  /** Instance created, container starting up. creating → booting. */
  markBooting(endpoint: string): Deployment {
    assertTransition(this.s.phase, 'booting');
    return new Deployment({
      ...this.s,
      phase: 'booting',
      endpoint,
    });
  }

  /** Container booted, models loading. booting → installing. */
  markInstalling(): Deployment {
    assertTransition(this.s.phase, 'installing');
    return new Deployment({ ...this.s, phase: 'installing' });
  }

  /** Deployment passed health probe. booting|installing → ready. */
  markReady(): Deployment {
    assertTransition(this.s.phase, 'ready');
    return new Deployment({ ...this.s, phase: 'ready', errorMessage: '' });
  }

  /** Deploy failed with an error. Any phase → error. */
  markError(message: string): Deployment {
    assertTransition(this.s.phase, 'error');
    return new Deployment({ ...this.s, phase: 'error', errorMessage: message });
  }

  /** Gracefully pause a ready deployment. ready|booting|installing → stopped. */
  markStopped(): Deployment {
    assertTransition(this.s.phase, 'stopped');
    return new Deployment({ ...this.s, phase: 'stopped' });
  }

  /** Resume a stopped deployment. stopped → booting. */
  resume(): Deployment {
    assertTransition(this.s.phase, 'booting');
    return new Deployment({ ...this.s, phase: 'booting' });
  }

  /** Increment retry counter — useful for exponential backoff tracking. */
  withRetry(): Deployment {
    return new Deployment({ ...this.s, retryCount: this.s.retryCount + 1 });
  }

  /** Reset to idle — used by resetDeployState(). error → idle. */
  reset(): Deployment {
    assertTransition(this.s.phase, 'idle');
    return new Deployment({
      ...this.s,
      phase: 'idle',
      podId: '',
      endpoint: '',
      retryCount: 0,
      errorMessage: '',
    });
  }
}
