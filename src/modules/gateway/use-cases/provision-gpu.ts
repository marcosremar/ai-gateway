/**
 * ProvisionGpu — use case: provision a GPU deployment from idle to ready.
 *
 * Clean Architecture use case: orchestrates the Deployment entity + ports.
 * Contains zero HTTP/framework knowledge; pure domain flow.
 *
 * Flow:
 *   1. Check budget (Budget value object decides)
 *   2. Build a fresh Deployment entity (idle)
 *   3. Transition through phases as provider responds
 *   4. Persist via DeploymentRepository
 *   5. Publish events at each transition
 *
 * Caller is responsible for retry / tier cascade — this use case handles a
 * single provision attempt on a single provider.
 */

import { Deployment, type Provider } from '../entities/deployment';
import { Budget, BudgetExceededError } from '../entities/value-objects/budget';
import type { DeploymentRepository, EventPublisher, GpuProvisioner, ProvisionRequest } from '../ports';

export interface ProvisionGpuInput {
  provider: Provider;
  gpuType: string;
  dockerImage: string;
  apiKey: string;
  region?: string;
  /** Estimated hourly cost to check against the budget. Default: $2/hr. */
  estimatedCostPerHr?: number;
  /** Health probe timeout. Default: 10 minutes. */
  healthTimeoutMs?: number;
}

export interface ProvisionGpuOutput {
  deployment: Deployment;
  durationMs: number;
}

export interface ProvisionGpuDeps {
  provisioner: GpuProvisioner;
  repository: DeploymentRepository;
  events: EventPublisher;
  /** Callback to read the current budget state (injected because cost tracking lives elsewhere). */
  budget: () => Budget;
}

export class ProvisionGpu {
  constructor(private readonly deps: ProvisionGpuDeps) {}

  async execute(input: ProvisionGpuInput): Promise<ProvisionGpuOutput> {
    const startedAt = Date.now();

    // 1. Budget gate (domain rule, not HTTP concern)
    const budget = this.deps.budget();
    const decision = budget.canAfford(input.estimatedCostPerHr ?? 2);
    if (!decision.allowed) {
      this.deps.events.publish({
        type: 'deploy.rejected',
        timestamp: Date.now(),
        payload: { reason: decision.reason, budget: decision },
      });
      throw new BudgetExceededError(decision);
    }

    // 2. Create entity and start search
    let deployment = Deployment.create({
      provider: input.provider,
      gpuType: input.gpuType,
      dockerImage: input.dockerImage,
    }).startSearch(input.provider);
    await this.deps.repository.save(deployment);
    this.deps.events.publish({
      type: 'deploy.started',
      timestamp: Date.now(),
      payload: { id: deployment.id, provider: input.provider, gpuType: input.gpuType },
    });

    try {
      // 3. Provision via provider adapter
      const request: ProvisionRequest = {
        provider: input.provider,
        gpuType: input.gpuType,
        dockerImage: input.dockerImage,
        region: input.region,
        apiKey: input.apiKey,
        healthTimeoutMs: input.healthTimeoutMs,
      };
      const instance = await this.deps.provisioner.provision(request);

      // 4. Transition through creating → booting → ready
      deployment = deployment
        .markCreating(instance.podId, instance.gpuType, instance.costPerHr)
        .markBooting(instance.endpoint)
        .markReady();

      await this.deps.repository.save(deployment);
      this.deps.events.publish({
        type: 'deploy.ready',
        timestamp: Date.now(),
        payload: {
          id: deployment.id,
          endpoint: instance.endpoint,
          gpuType: instance.gpuType,
          costPerHr: instance.costPerHr,
        },
      });

      return { deployment, durationMs: Date.now() - startedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deployment = deployment.markError(message);
      await this.deps.repository.save(deployment);
      this.deps.events.publish({
        type: 'deploy.failed',
        timestamp: Date.now(),
        payload: { id: deployment.id, provider: input.provider, error: message },
      });
      throw err;
    }
  }
}
