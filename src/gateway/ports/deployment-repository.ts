/**
 * DeploymentRepository — persistence port for the Deployment aggregate.
 *
 * Use cases depend on this interface. Concrete implementations (file-backed,
 * Redis-backed, etc.) are adapters.
 */

import type { Deployment } from '../entities/deployment';
import type { DeployId } from '../entities/value-objects/deploy-id';

export interface DeploymentRepository {
  /** Load the currently-active deployment, or null if none. */
  loadActive(): Promise<Deployment | null>;

  /** Load a specific deployment by ID. */
  load(id: DeployId): Promise<Deployment | null>;

  /** Persist a deployment snapshot (overwrites current). */
  save(deployment: Deployment): Promise<void>;

  /** Clear the active deployment reference (does not delete history). */
  clearActive(): Promise<void>;
}
