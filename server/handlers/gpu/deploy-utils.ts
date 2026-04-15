/**
 * GPU Deploy Utilities
 */

import { createLogger } from '../../../src/logger';
import { deployState, setDeployState } from '../../state';

const log = createLogger('gpu-deploy-utils');

/**
 * Generate a unique deploy ID
 */
export function generateDeployId(): string {
  return `deploy-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Validate GPU credentials for a provider
 */
export function validateGpuCredentials(
  provider: string,
  apiKey?: string
): { valid: boolean; error?: string } {
  if (!apiKey || apiKey.length < 10) {
    return { valid: false, error: `Invalid API key for ${provider}` };
  }
  return { valid: true };
}

/**
 * Calculate estimated deploy cost
 */
export function estimateDeployCost(
  gpuType: string,
  provider: string,
  durationHours: number = 1
): number {
  // Base prices per GPU type (approximate)
  const basePrices: Record<string, number> = {
    'NVIDIA GeForce RTX 4090': 0.44,
    'NVIDIA GeForce RTX 5090': 0.69,
    'NVIDIA RTX A6000': 0.79,
    'NVIDIA L40S': 0.79,
    'NVIDIA RTX A5000': 0.32,
    'NVIDIA A40': 0.59,
    'NVIDIA A100 80GB PCIe': 1.99,
    'NVIDIA H100 80GB HBM3': 2.49,
  };

  const basePrice = basePrices[gpuType] || 0.50;
  const providerMultiplier = provider === 'runpod' ? 1.0 : provider === 'vast' ? 0.8 : 1.0;

  return basePrice * providerMultiplier * durationHours;
}

/**
 * Format deploy status for response
 */
export function formatDeployStatus(): Record<string, unknown> {
  return {
    status: deployState.status,
    deployId: deployState.deployId,
    provider: deployState.provider,
    gpuType: deployState.gpuType,
    dockerImage: deployState.dockerImage,
    endpoint: deployState.endpoint,
    message: deployState.message,
    step: deployState.step,
    progress: deployState.stepDetail,
    startedAt: deployState.startedAt,
    duration: deployState.deployDurationMs,
    costPerHr: deployState.costPerHr,
    alert: deployState.alert,
    alertLevel: deployState.alertLevel,
  };
}

/**
 * Check if deploy is in progress
 */
export function isDeployInProgress(): boolean {
  return ['creating', 'booting', 'installing'].includes(deployState.status);
}

/**
 * Parse request body for deploy
 */
export function parseDeployBody(body: Record<string, unknown>): {
  dockerImage: string;
  gpuTypes: string[];
  env: Record<string, string>;
  options: Record<string, unknown>;
} {
  const dockerImage = String(body.dockerImage || '');
  const gpuTypes = Array.isArray(body.gpuTypes) 
    ? body.gpuTypes.map(String) 
    : ['NVIDIA GeForce RTX 4090'];
  
  const env = (body.env as Record<string, string>) || {};
  
  const options: Record<string, unknown> = {
    onstart: body.onstart,
    dockerfile: body.dockerfile,
    networkVolumeId: body.networkVolumeId,
    diskGb: body.diskGb,
    region: body.region,
    priority: body.priority,
    sortBy: body.sortBy,
    llmModel: body.llmModel,
    skipIfRunning: body.skipIfRunning,
    force: body.force,
    race: body.race,
    maxCostUsd: body.maxCostUsd,
  };

  return { dockerImage, gpuTypes, env, options };
}

/**
 * Sanitize GPU types input
 */
export function sanitizeGpuTypes(gpuTypes: unknown): string[] {
  if (!gpuTypes) {
    return ['NVIDIA GeForce RTX 4090'];
  }
  
  if (typeof gpuTypes === 'string') {
    return gpuTypes.split(',').map(g => g.trim()).filter(Boolean);
  }
  
  if (Array.isArray(gpuTypes)) {
    return gpuTypes.map(String).filter(Boolean);
  }
  
  return ['NVIDIA GeForce RTX 4090'];
}

/**
 * Update deploy state with progress
 */
export function updateDeployProgress(
  step: string,
  message: string,
  detail?: string
): void {
  setDeployState({
    step,
    message,
    ...(detail && { stepDetail: detail }),
  });
  log.log(`[Deploy] ${step}: ${message}`);
}

/**
 * Calculate deploy timeout based on provider and config
 */
export function calculateDeployTimeout(
  provider: string,
  dockerImage: string,
  baseTimeout: number = 30
): number {
  // Add extra time for large images
  const isLargeImage = /(70b|65b|200b)/i.test(dockerImage);
  const extraTime = isLargeImage ? 15 : 0;
  
  // RunPod typically needs more time
  const providerMultiplier = provider === 'runpod' ? 1.5 : 1.0;
  
  return (baseTimeout + extraTime) * providerMultiplier;
}
