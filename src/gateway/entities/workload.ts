/**
 * Workload — aggregate root for user-provisioned compute (GPU / Bot / DB).
 *
 * Unlike Deployment (which is the gateway's own GPU for self-hosted inference),
 * a Workload is a product the user provisions via the Compute API.
 *
 * Clean Architecture entity: immutable-by-transition, invariants enforced.
 */

export type WorkloadType = 'gpu' | 'bot' | 'db';
export type WorkloadPhase = 'idle' | 'deploying' | 'running' | 'stopped' | 'error';

const ALLOWED: Record<WorkloadPhase, readonly WorkloadPhase[]> = {
  idle: ['deploying', 'error'],
  deploying: ['running', 'error', 'stopped'],
  running: ['stopped', 'error'],
  stopped: ['deploying', 'error'],
  error: ['idle', 'deploying'],
};

export class InvalidWorkloadTransitionError extends Error {
  constructor(public readonly from: WorkloadPhase, public readonly to: WorkloadPhase) {
    super(`Invalid workload transition: ${from} → ${to}`);
    this.name = 'InvalidWorkloadTransitionError';
  }
}

function assertWorkloadTransition(from: WorkloadPhase, to: WorkloadPhase): void {
  if (!ALLOWED[from]?.includes(to)) {
    throw new InvalidWorkloadTransitionError(from, to);
  }
}

export interface WorkloadSnapshot {
  id: string;
  type: WorkloadType;
  name: string;
  phase: WorkloadPhase;
  provider: string;
  endpoint: string;
  costPerHr: number;
  instanceId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  errorMessage: string;
}

export class Workload {
  private constructor(private readonly s: WorkloadSnapshot) {}

  static create(params: {
    id: string;
    type: WorkloadType;
    name: string;
    provider: string;
    endpoint?: string;
    costPerHr?: number;
    instanceId?: string;
    metadata?: Record<string, unknown>;
  }): Workload {
    if (!params.name.trim()) throw new Error('Workload name cannot be empty');
    const now = Date.now();
    return new Workload({
      id: params.id,
      type: params.type,
      name: params.name,
      phase: 'deploying',
      provider: params.provider,
      endpoint: params.endpoint ?? '',
      costPerHr: params.costPerHr ?? 0,
      instanceId: params.instanceId ?? '',
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      errorMessage: '',
    });
  }

  static rehydrate(snapshot: WorkloadSnapshot): Workload {
    return new Workload({ ...snapshot });
  }

  // ── Queries ────────────────────────────────────────────────────────────

  get id(): string { return this.s.id; }
  get type(): WorkloadType { return this.s.type; }
  get name(): string { return this.s.name; }
  get phase(): WorkloadPhase { return this.s.phase; }
  get endpoint(): string { return this.s.endpoint; }
  get isRunning(): boolean { return this.s.phase === 'running'; }
  get isTerminal(): boolean { return this.s.phase === 'error'; }
  get snapshot(): Readonly<WorkloadSnapshot> { return this.s; }

  // ── Commands ───────────────────────────────────────────────────────────

  markRunning(endpoint: string, instanceId: string): Workload {
    assertWorkloadTransition(this.s.phase, 'running');
    return new Workload({
      ...this.s,
      phase: 'running',
      endpoint: endpoint || this.s.endpoint,
      instanceId: instanceId || this.s.instanceId,
      updatedAt: Date.now(),
      errorMessage: '',
    });
  }

  markStopped(): Workload {
    assertWorkloadTransition(this.s.phase, 'stopped');
    return new Workload({ ...this.s, phase: 'stopped', updatedAt: Date.now() });
  }

  markDeploying(): Workload {
    assertWorkloadTransition(this.s.phase, 'deploying');
    return new Workload({ ...this.s, phase: 'deploying', updatedAt: Date.now(), errorMessage: '' });
  }

  markError(message: string): Workload {
    assertWorkloadTransition(this.s.phase, 'error');
    return new Workload({
      ...this.s,
      phase: 'error',
      errorMessage: message,
      updatedAt: Date.now(),
    });
  }
}
