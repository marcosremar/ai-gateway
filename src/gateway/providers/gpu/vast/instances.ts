/**
 * Vast.ai Instance Management
 */

import { createLogger } from '../../../../logger';
import { safeCatch } from '../../../../safe-catch';
import type { VastInstance, VastCredentials, VastOffer } from './types';
import { vastRequest, formatInstanceStatus, isTerminalStatus } from './utils';

const log = createLogger('vast-instances');

/**
 * List all instances
 */
export async function listInstances(
  credentials: VastCredentials
): Promise<VastInstance[]> {
  try {
    const response = await vastRequest<{ instances: VastInstance[] }>(
      '/instances',
      credentials
    );
    return response.instances || [];
  } catch (err) {
    log.error('Failed to list instances:', err);
    throw err;
  }
}

/**
 * Get instance details
 */
export async function getInstance(
  instanceId: string,
  credentials: VastCredentials
): Promise<VastInstance | null> {
  try {
    const response = await vastRequest<{ instance: VastInstance }>(
      `/instances/${instanceId}`,
      credentials
    );
    return response.instance || null;
  } catch (err) {
    log.error(`Failed to get instance ${instanceId}:`, err);
    return null;
  }
}

/**
 * Create a new instance from an offer
 */
export async function createInstance(
  offerId: number,
  config: {
    image: string;
    env?: Record<string, string>;
    onstart?: string;
    dockerfile?: string;
    disk?: number;
    label?: string;
  },
  credentials: VastCredentials
): Promise<{ id: string; success: boolean; error?: string }> {
  try {
    const response = await vastRequest<{ success: boolean; instance?: VastInstance; error?: string }>(
      `/asks/${offerId}/?`,
      credentials,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'me',
          image: config.image,
          env: config.env || {},
          onstart: config.onstart || '',
          dockerfile: config.dockerfile || '',
          disk: config.disk || 10,
          label: config.label || '',
        }),
      }
    );
    
    if (!response.success) {
      return { 
        id: '', 
        success: false, 
        error: response.error || 'Unknown error creating instance' 
      };
    }
    
    return { 
      id: String(response.instance?.id || ''), 
      success: true 
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('Failed to create instance:', err);
    return { id: '', success: false, error: errorMsg };
  }
}

/**
 * Destroy an instance
 */
export async function destroyInstance(
  instanceId: string,
  credentials: VastCredentials
): Promise<boolean> {
  try {
    await vastRequest(
      `/instances/${instanceId}/`,
      credentials,
      { method: 'DELETE' }
    );
    log.log(`Instance ${instanceId} destroyed successfully`);
    return true;
  } catch (err) {
    log.error(`Failed to destroy instance ${instanceId}:`, err);
    return false;
  }
}

/**
 * Stop an instance
 */
export async function stopInstance(
  instanceId: string,
  credentials: VastCredentials
): Promise<boolean> {
  try {
    await vastRequest(
      `/instances/${instanceId}/stop/`,
      credentials,
      { method: 'PUT' }
    );
    log.log(`Instance ${instanceId} stopped successfully`);
    return true;
  } catch (err) {
    log.error(`Failed to stop instance ${instanceId}:`, err);
    return false;
  }
}

/**
 * Start a stopped instance
 */
export async function startInstance(
  instanceId: string,
  credentials: VastCredentials
): Promise<boolean> {
  try {
    await vastRequest(
      `/instances/${instanceId}/start/`,
      credentials,
      { method: 'PUT' }
    );
    log.log(`Instance ${instanceId} started successfully`);
    return true;
  } catch (err) {
    log.error(`Failed to start instance ${instanceId}:`, err);
    return false;
  }
}

/**
 * Label an instance
 */
export async function labelInstance(
  instanceId: string,
  label: string,
  credentials: VastCredentials
): Promise<boolean> {
  try {
    await vastRequest(
      `/instances/${instanceId}/label/`,
      credentials,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      }
    );
    return true;
  } catch (err) {
    log.error(`Failed to label instance ${instanceId}:`, err);
    return false;
  }
}

/**
 * Get instance status
 */
export async function getInstanceStatus(
  instanceId: string,
  credentials: VastCredentials
): Promise<string | null> {
  const instance = await getInstance(instanceId, credentials);
  if (!instance) return null;
  return formatInstanceStatus(instance.actual_status);
}

/**
 * Check if instance exists and is active
 */
export async function isInstanceActive(
  instanceId: string,
  credentials: VastCredentials
): Promise<boolean> {
  const status = await getInstanceStatus(instanceId, credentials);
  if (!status) return false;
  return !isTerminalStatus(status);
}

/**
 * Wait for instance to reach a specific status
 */
export async function waitForStatus(
  instanceId: string,
  targetStatus: string,
  credentials: VastCredentials,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const { timeoutMs = 300000, intervalMs = 5000 } = options;
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await getInstanceStatus(instanceId, credentials);
    
    if (status === targetStatus) {
      return true;
    }
    
    if (status === 'error' || status === 'terminated') {
      log.error(`Instance ${instanceId} reached terminal status: ${status}`);
      return false;
    }
    
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  log.warn(`Timeout waiting for instance ${instanceId} to reach ${targetStatus}`);
  return false;
}
