/**
 * StopDeployment — use case: gracefully stop a running GPU deployment.
 *
 * Preserves the pod (auto-destroy happens later via a scheduled task).
 */

import { Deployment } from '../entities/deployment';
import type { DeploymentRepository, EventPublisher, GpuProvisioner } from '../ports';

export interface StopDeploymentInput {
  apiKey: string;
}

export interface StopDeploymentDeps {
  provisioner: GpuProvisioner;
  repository: DeploymentRepository;
  events: EventPublisher;
}

export class StopDeployment {
  constructor(private readonly deps: StopDeploymentDeps) {}

  async execute(input: StopDeploymentInput): Promise<Deployment> {
    const current = await this.deps.repository.loadActive();
    if (!current) throw new Error('No active deployment to stop');
    if (!current.isReady) {
      throw new Error(`Cannot stop deployment in phase '${current.phase}' (must be 'ready' or 'booting')`);
    }

    const snap = current.snapshot;
    await this.deps.provisioner.stop(snap.podId, snap.provider, input.apiKey);

    const stopped = current.markStopped();
    await this.deps.repository.save(stopped);

    this.deps.events.publish({
      type: 'deploy.stopped',
      timestamp: Date.now(),
      payload: { id: stopped.id, provider: snap.provider, podId: snap.podId },
    });

    return stopped;
  }
}
