/**
 * GpuWorkloadDriver — bridges GPU deploy/stop/resume/terminate runtime
 * operations into the WorkloadDriver interface.
 */

import type { Workload, WorkloadConfig, WorkloadDriver, GpuWorkloadConfig } from './types';
import { WorkloadRegistry } from './registry';
import { getWorkloadServerRuntime } from './server-runtime';

export class GpuWorkloadDriver implements WorkloadDriver {
  readonly type = 'gpu' as const;

  private async serverState() {
    return getWorkloadServerRuntime().state();
  }

  private async gpuDeploy() {
    return getWorkloadServerRuntime().gpuDeploy();
  }

  private async providers() {
    return getWorkloadServerRuntime().providers();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async deploy(name: string, config: WorkloadConfig): Promise<Workload> {
    const cfg = config as GpuWorkloadConfig;
    const state = await this.serverState();
    const deploy = await this.gpuDeploy();

    // Build tiers from config
    const runpodKey = cfg.apiKey || process.env.RUNPOD_API_KEY || '';
    const vastKey = process.env.VAST_API_KEY || '';
    const hyperstackKey = process.env.HYPERSTACK_API_KEY || '';
    const tdKey = process.env.TENSORDOCK_API_KEY || '';
    const tdAuthId = process.env.TENSORDOCK_AUTH_ID || '';
    const modalKey = process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET
      ? `${process.env.MODAL_TOKEN_ID}:${process.env.MODAL_TOKEN_SECRET}` : '';

    const tiers = deploy.buildGpuTiers(
      runpodKey,
      vastKey || undefined,
      tdKey ? { apiKey: tdKey, authId: tdAuthId } : undefined,
      modalKey || undefined,
      hyperstackKey || undefined,
    );

    const dockerImage = cfg.dockerImage || '';
    const gpuTypes = cfg.gpuTypes || [];

    // Reset deploy state so deployCancelled=false (set by terminate/resetDeployState)
    // doesn't abort the new deploy loop immediately.
    state.setDeployCancelled(false);

    // Build extra options — pass env vars, storage, region from config
    const extra: Record<string, unknown> = {};
    if (cfg.env && Object.keys(cfg.env).length > 0) extra.env = cfg.env;
    if (cfg.storageGb) extra.storageGb = cfg.storageGb;
    if (cfg.region) extra.region = cfg.region;

    // Kick off deploy (non-blocking — returns immediately)
    deploy.startDeployWithTiers(tiers, dockerImage, gpuTypes, extra as any);

    const now = Date.now();
    return {
      id: WorkloadRegistry.newId(),
      type: 'gpu',
      name,
      status: 'deploying',
      provider: state.deployState.provider || 'runpod',
      costPerHr: 0,
      metadata: {
        dockerImage: cfg.dockerImage || '',
        gpuTypes: cfg.gpuTypes || [],
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  async stop(workload: Workload): Promise<Workload> {
    const state = await this.serverState();
    const deploy = await this.gpuDeploy();

    const provider = state.deployState.provider || 'runpod';
    const podId = state.deployState.podId;

    if (!podId) throw new Error('No active GPU pod to stop');

    const { client, credentials } = await this.resolveProvider(provider);
    await client.stopInstance(podId, credentials);

    deploy.stopGpuMonitoring();
    state.setDeployState({
      status: 'idle',
      message: `Pod ${podId} stopped (paused).`,
    });
    // Preserve podId for resume
    state.deployState.podId = podId;
    state.deployState.provider = provider;

    return {
      ...workload,
      status: 'stopped',
      updatedAt: Date.now(),
      metadata: { ...workload.metadata, podId, provider },
    };
  }

  async start(workload: Workload): Promise<Workload> {
    const state = await this.serverState();
    const podId = (workload.metadata.podId as string) || state.deployState.podId;
    const provider = (workload.metadata.provider as string) || state.deployState.provider || 'runpod';

    if (!podId) throw new Error('No pod ID to resume');

    const { client, credentials } = await this.resolveProvider(provider);
    await client.startInstance(podId, credentials);

    state.setDeployState({
      status: 'booting',
      message: `Resuming pod ${podId}...`,
    });

    return {
      ...workload,
      status: 'deploying',
      updatedAt: Date.now(),
      metadata: { ...workload.metadata, podId, provider },
    };
  }

  async terminate(workload: Workload): Promise<void> {
    const state = await this.serverState();
    const deploy = await this.gpuDeploy();
    const prov = await this.providers();

    deploy.stopGpuMonitoring();
    state.setDeployLock(false);
    state.resetDeployState();
    state.deploymentSM.reset();

    const apiKey = process.env.RUNPOD_API_KEY || '';
    const vastKey = process.env.VAST_API_KEY || '';
    const hyperstackKey = process.env.HYPERSTACK_API_KEY || '';
    const tdKey = process.env.TENSORDOCK_API_KEY || '';
    const tdAuthId = process.env.TENSORDOCK_AUTH_ID || '';

    if (apiKey) await deploy.cleanupAllPods(apiKey);
    if (vastKey) await deploy.cleanupVastInstances(vastKey);
    if (hyperstackKey) {
      const instances = await prov.hyperstack.listInstances({ apiKey: hyperstackKey }) as Array<{ status: string; instanceId: string }>;
      await Promise.allSettled(
        instances
          .filter((instance) => ['running', 'active', 'creating', 'booting'].includes(instance.status.toLowerCase()))
          .map((instance) => prov.hyperstack.deleteInstance(instance.instanceId, { apiKey: hyperstackKey })),
      );
    }
    if (tdKey) await deploy.cleanupTensordockInstances(tdKey, tdAuthId);
  }

  async status(workload: Workload): Promise<Workload> {
    const state = await this.serverState();
    const ds = state.deployState;

    const statusMap: Record<string, Workload['status']> = {
      idle: 'idle',
      searching: 'deploying',
      queued: 'deploying',
      creating: 'deploying',
      booting: 'deploying',
      installing: 'deploying',
      ready: 'running',
      error: 'error',
    };

    return {
      ...workload,
      status: statusMap[ds.status] || 'idle',
      provider: ds.provider || workload.provider,
      endpoint: ds.endpoint || workload.endpoint,
      costPerHr: ds.costPerHr || workload.costPerHr,
      instanceId: ds.podId || workload.instanceId,
      error: ds.status === 'error' ? ds.message : undefined,
      updatedAt: Date.now(),
      metadata: {
        ...workload.metadata,
        podId: ds.podId,
        gpuType: ds.gpuType,
        dockerImage: ds.dockerImage,
        step: ds.step,
        stepDetail: ds.stepDetail,
        gpuHealthy: state.gpuHealthy,
      },
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async resolveProvider(provider: string) {
    const prov = await this.providers();
    type GpuClient = import('../../gpu-providers/types').GpuProviderClient;
    type Creds = import('../../gpu-providers/types').ProviderCredentials;

    let client: GpuClient;
    let credentials: Creds;

    switch (provider) {
      case 'vast':
        client = prov.vast;
        credentials = { apiKey: process.env.VAST_API_KEY || '' };
        break;
      case 'hyperstack':
        client = prov.hyperstack;
        credentials = { apiKey: process.env.HYPERSTACK_API_KEY || '' };
        break;
      case 'tensordock':
        client = prov.tensordock;
        credentials = { apiKey: process.env.TENSORDOCK_API_KEY || '', authId: process.env.TENSORDOCK_AUTH_ID || '' };
        break;
      case 'modal':
        client = prov.modal;
        credentials = { apiKey: `${process.env.MODAL_TOKEN_ID || ''}:${process.env.MODAL_TOKEN_SECRET || ''}` };
        break;
      default:
        client = prov.runpod;
        credentials = { apiKey: process.env.RUNPOD_API_KEY || '' };
    }

    return { client, credentials };
  }
}
