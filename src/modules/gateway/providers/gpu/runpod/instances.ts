/**
 * RunPod Instance/Pod Management
 */

import { createLogger } from '../../../../logger';
import { safeCatch } from '../../../../safe-catch';
import { runpodRequest, resolvePodEndpoint, isPodRunning, isPodTerminal } from './utils';
import { RUNPOD_GPU_TYPE_MAP, resolveDatacenterIds } from './constants';
import type {
  RunpodPod,
  RunpodInstance,
  RunpodInstanceDetail,
  CreatePodRequest,
  RunpodCredentials
} from './types';

const log = createLogger('runpod-instances');

/**
 * List all pods/instances
 */
export async function listPods(credentials: RunpodCredentials): Promise<RunpodPod[]> {
  try {
    const pods = await runpodRequest<RunpodPod[]>('/pods', credentials.apiKey);
    return pods || [];
  } catch (err) {
    log.error('Failed to list pods:', err);
    throw err;
  }
}

/**
 * Get pod details by ID
 */
export async function getPod(
  podId: string,
  credentials: RunpodCredentials
): Promise<RunpodPod | null> {
  try {
    const pod = await runpodRequest<RunpodPod>(`/pods/${podId}`, credentials.apiKey);
    return pod || null;
  } catch (err) {
    log.error(`Failed to get pod ${podId}:`, err);
    return null;
  }
}

/**
 * Create a new pod
 */
export async function createPod(
  config: CreatePodRequest,
  credentials: RunpodCredentials
): Promise<{ id: string; success: boolean; error?: string }> {
  try {
    const response = await runpodRequest<{ id: string; imageName: string }>(
      '/pods',
      credentials.apiKey,
      {
        method: 'POST',
        body: JSON.stringify({
          name: config.name || `pod-${Date.now()}`,
          imageName: config.imageName,
          dockerArgs: config.dockerArgs || '',
          ports: config.ports || '8000/http',
          volumeMountPath: config.volumeMountPath || '/workspace',
          env: buildEnvArray(config.env),
          networkVolumeId: config.networkVolumeId,
          gpuCount: config.gpuCount,
          volumeInGb: config.volumeInGb,
          containerDiskInGb: config.containerDiskInGb,
          minVcpuCount: config.minVcpuCount,
          minMemoryInGb: config.minMemoryInGb,
          gpuTypeId: config.gpuTypeId,
          dataCenterId: config.dataCenterId,
          cloudType: config.cloudType,
          supportPublicIp: config.supportPublicIp,
          startSsh: config.startSsh ?? true,
          startJupyter: config.startJupyter ?? false,
        }),
      }
    );

    if (!response?.id) {
      return { id: '', success: false, error: 'No pod ID returned' };
    }

    log.log(`Pod created: ${response.id}`);
    return { id: response.id, success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('Failed to create pod:', err);
    return { id: '', success: false, error: errorMsg };
  }
}

/**
 * Stop a pod
 */
export async function stopPod(
  podId: string,
  credentials: RunpodCredentials
): Promise<boolean> {
  try {
    await runpodRequest(
      `/pods/${podId}/stop`,
      credentials.apiKey,
      { method: 'POST' }
    );
    log.log(`Pod ${podId} stopped`);
    return true;
  } catch (err) {
    log.error(`Failed to stop pod ${podId}:`, err);
    return false;
  }
}

/**
 * Start a stopped pod
 */
export async function startPod(
  podId: string,
  credentials: RunpodCredentials
): Promise<boolean> {
  try {
    await runpodRequest(
      `/pods/${podId}/resume`,
      credentials.apiKey,
      { method: 'POST' }
    );
    log.log(`Pod ${podId} started`);
    return true;
  } catch (err) {
    log.error(`Failed to start pod ${podId}:`, err);
    return false;
  }
}

/**
 * Terminate/delete a pod
 */
export async function terminatePod(
  podId: string,
  credentials: RunpodCredentials
): Promise<boolean> {
  try {
    await runpodRequest(
      `/pods/${podId}`,
      credentials.apiKey,
      { method: 'DELETE' }
    );
    log.log(`Pod ${podId} terminated`);
    return true;
  } catch (err) {
    log.error(`Failed to terminate pod ${podId}:`, err);
    return false;
  }
}

/**
 * Get detailed instance information
 */
export async function getInstanceDetail(
  podId: string,
  credentials: RunpodCredentials
): Promise<RunpodInstanceDetail | null> {
  try {
    const pod = await getPod(podId, credentials);
    if (!pod) return null;

    const endpoint = resolvePodEndpoint(pod);
    const gpuType = pod.machine?.gpuDisplayName || pod.gpuTypeId || 'Unknown';

    // Check for ghost machine
    const ghostMachine = pod.desiredStatus === 'RUNNING' &&
                         !pod.runtime?.uptimeInSeconds &&
                         Date.now() - (pod as unknown as Record<string, number>).createdAt > 90000;

    return {
      id: pod.id,
      status: pod.desiredStatus,
      imageName: pod.imageName,
      gpuType,
      costPerHr: pod.deployCost || 0,
      runtime: pod.runtime,
      endpoint,
      desiredStatus: pod.desiredStatus,
      machineId: pod.machineId,
      dataCenterId: pod.dataCenterId,
      ghostMachine,
    };
  } catch (err) {
    log.error(`Failed to get instance detail for ${podId}:`, err);
    return null;
  }
}

/**
 * Get instance status
 */
export async function getInstanceStatus(
  podId: string,
  credentials: RunpodCredentials
): Promise<string | null> {
  const pod = await getPod(podId, credentials);
  if (!pod) return null;
  return pod.desiredStatus;
}

/**
 * Resolve instance endpoint
 */
export async function resolveInstanceEndpoint(
  podId: string,
  credentials: RunpodCredentials
): Promise<string | null> {
  const detail = await getInstanceDetail(podId, credentials);
  return detail?.endpoint || null;
}

/**
 * Check account balance
 */
export async function checkBalance(
  credentials: RunpodCredentials
): Promise<{ balance: number } | null> {
  try {
    const response = await runpodRequest<{ balance: number }>(
      '/user/balance',
      credentials.apiKey
    );
    return response;
  } catch (err) {
    log.error('Failed to check balance:', err);
    return null;
  }
}

/**
 * Wait for pod to reach a status
 */
export async function waitForStatus(
  podId: string,
  targetStatus: string,
  credentials: RunpodCredentials,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const { timeoutMs = 1800000, intervalMs = 10000 } = options; // 30 min default
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await getInstanceStatus(podId, credentials);

    if (status === targetStatus) {
      return true;
    }

    if (status === 'ERROR' || status === 'EXITED') {
      log.error(`Pod ${podId} reached terminal status: ${status}`);
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  log.warn(`Timeout waiting for pod ${podId} to reach ${targetStatus}`);
  return false;
}

/**
 * Convert RunPod pod to generic GpuInstance
 */
export function podToInstance(pod: RunpodPod): RunpodInstance {
  return {
    instanceId: pod.id,
    instanceName: pod.name,
    endpoint: '',
    status: pod.desiredStatus.toLowerCase() as RunpodInstance['status'],
    podId: pod.id,
    gpuType: pod.machine?.gpuDisplayName ?? pod.gpuTypeId,
    dataCenterId: pod.dataCenterId,
    cloudType: pod.cloudType,
    runtime: pod.runtime,
    providerMeta: { provider: 'runpod', dataCenterId: pod.dataCenterId, cloudType: pod.cloudType, gpuType: pod.machine?.gpuDisplayName ?? pod.gpuTypeId },
    ghostMachine: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Helper function
function buildEnvArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}
