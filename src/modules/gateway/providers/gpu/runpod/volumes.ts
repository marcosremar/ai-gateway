/**
 * RunPod Network Volume Management
 *
 * Network volumes are persistent storage attached at /workspace.
 * KEY CONSTRAINTS:
 *   - Volumes are tied to ONE datacenter (e.g. EU-RO-1)
 *   - Pods using a volume MUST be deployed to that same datacenter
 *   - Volumes persist across pod terminations (charged $0.07/GB/month)
 *   - Volume size can be expanded later but never reduced
 */

import { createLogger } from '../../../../logger';
import { runpodRequest } from './utils';
import type { RunpodNetworkVolume, RunpodCredentials } from './types';

const log = createLogger('runpod-volumes');

/**
 * List all network volumes
 */
export async function listNetworkVolumes(
  credentials: RunpodCredentials
): Promise<RunpodNetworkVolume[]> {
  try {
    const volumes = await runpodRequest<RunpodNetworkVolume[]>(
      '/networkvolumes',
      credentials.apiKey
    );
    return volumes || [];
  } catch (err) {
    log.error('Failed to list network volumes:', err);
    throw err;
  }
}

/**
 * Get network volume details
 */
export async function getNetworkVolume(
  volumeId: string,
  credentials: RunpodCredentials
): Promise<RunpodNetworkVolume | null> {
  try {
    const volume = await runpodRequest<RunpodNetworkVolume>(
      `/networkvolumes/${volumeId}`,
      credentials.apiKey
    );
    return volume || null;
  } catch (err) {
    log.error(`Failed to get network volume ${volumeId}:`, err);
    return null;
  }
}

/**
 * Create a new network volume
 */
export async function createNetworkVolume(
  name: string,
  sizeGb: number,
  dataCenterId: string,
  credentials: RunpodCredentials
): Promise<{ id: string; success: boolean; error?: string }> {
  try {
    const response = await runpodRequest<{ id: string }>(
      '/networkvolumes',
      credentials.apiKey,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          size: sizeGb,
          dataCenterId,
        }),
      }
    );

    if (!response?.id) {
      return { id: '', success: false, error: 'No volume ID returned' };
    }

    log.log(`Network volume created: ${response.id}`);
    return { id: response.id, success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('Failed to create network volume:', err);
    return { id: '', success: false, error: errorMsg };
  }
}

/**
 * Update network volume size (can only increase)
 */
export async function updateNetworkVolume(
  volumeId: string,
  newSizeGb: number,
  credentials: RunpodCredentials
): Promise<boolean> {
  try {
    await runpodRequest(
      `/networkvolumes/${volumeId}`,
      credentials.apiKey,
      {
        method: 'PUT',
        body: JSON.stringify({ size: newSizeGb }),
      }
    );

    log.log(`Network volume ${volumeId} updated to ${newSizeGb}GB`);
    return true;
  } catch (err) {
    log.error(`Failed to update network volume ${volumeId}:`, err);
    return false;
  }
}

/**
 * Delete a network volume
 */
export async function deleteNetworkVolume(
  volumeId: string,
  credentials: RunpodCredentials
): Promise<boolean> {
  try {
    await runpodRequest(
      `/networkvolumes/${volumeId}`,
      credentials.apiKey,
      { method: 'DELETE' }
    );

    log.log(`Network volume ${volumeId} deleted`);
    return true;
  } catch (err) {
    log.error(`Failed to delete network volume ${volumeId}:`, err);
    return false;
  }
}

/**
 * Get volumes by datacenter
 */
export async function getVolumesByDatacenter(
  dataCenterId: string,
  credentials: RunpodCredentials
): Promise<RunpodNetworkVolume[]> {
  const volumes = await listNetworkVolumes(credentials);
  return volumes.filter(v => v.dataCenterId === dataCenterId);
}

/**
 * Check if volume exists and has enough space
 */
export async function validateVolume(
  volumeId: string,
  requiredSizeGb: number,
  credentials: RunpodCredentials
): Promise<{ valid: boolean; error?: string }> {
  const volume = await getNetworkVolume(volumeId, credentials);

  if (!volume) {
    return { valid: false, error: `Volume ${volumeId} not found` };
  }

  if (volume.size < requiredSizeGb) {
    return {
      valid: false,
      error: `Volume ${volumeId} has ${volume.size}GB, need ${requiredSizeGb}GB`
    };
  }

  return { valid: true };
}
