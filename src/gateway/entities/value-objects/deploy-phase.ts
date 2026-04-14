/**
 * DeployPhase — the lifecycle state of a GPU deployment.
 * Transitions are validated by the Deployment entity.
 */

export type DeployPhase =
  | 'idle'
  | 'searching'
  | 'queued'
  | 'creating'
  | 'booting'
  | 'installing'
  | 'ready'
  | 'stopped'
  | 'error';

/** Valid transitions. Any transition not listed is illegal and will throw. */
const ALLOWED: Record<DeployPhase, readonly DeployPhase[]> = {
  idle: ['searching', 'creating', 'error'],
  searching: ['queued', 'creating', 'error', 'idle'],
  queued: ['creating', 'error', 'idle'],
  creating: ['booting', 'error', 'idle'],
  booting: ['installing', 'ready', 'error', 'stopped'],
  installing: ['ready', 'error', 'stopped'],
  ready: ['stopped', 'error'],
  stopped: ['booting', 'error', 'idle'],
  error: ['idle'],
};

export function canTransition(from: DeployPhase, to: DeployPhase): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertTransition(from: DeployPhase, to: DeployPhase): void {
  if (!canTransition(from, to)) {
    throw new InvalidDeployTransitionError(from, to);
  }
}

export class InvalidDeployTransitionError extends Error {
  constructor(public readonly from: DeployPhase, public readonly to: DeployPhase) {
    super(`Invalid deploy transition: ${from} → ${to}`);
    this.name = 'InvalidDeployTransitionError';
  }
}
