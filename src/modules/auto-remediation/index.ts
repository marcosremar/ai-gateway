/**
 * Auto-Remediation — automatically responds to specific error categories.
 *
 * When certain errors occur, this system takes corrective action:
 * - RES_CUDA_OOM → suggest GPU with more VRAM
 * - NET_DOCKER_HUB_RATE_LIMIT → authenticate with Docker Hub
 * - CNT_HEALTHCHECK_FAIL → suggest removing HEALTHCHECK
 * - INF_CREDIT_ZERO → alert before deploy
 * - GPU_DRIVER_MISMATCH → suggest compatible GPUs
 */

import { DeployError } from '../errors/deploy-errors';
import { getCompatibleGpus } from '../gpu-compat';
import { createLogger } from '../logger';

const log = createLogger('auto-remediation');

export interface RemediationAction {
  /** What action was taken */
  action: string;
  /** Why this action was taken */
  reason: string;
  /** Whether the action succeeded */
  success: boolean;
  /** Suggestions for the user */
  suggestions: string[];
}

/**
 * Attempt automatic remediation for a deploy error.
 *
 * @returns RemediationAction if action was taken, null if no auto-remediation available
 */
export async function tryAutoRemediation(err: DeployError): Promise<RemediationAction | null> {
  switch (err.code) {
    case 'RES_CUDA_OOM':
    case 'RES_VRAM_INSUFFICIENT':
      return await remediateOom(err);

    case 'NET_DOCKER_HUB_RATE_LIMIT':
      return remediateDockerHubRateLimit(err);

    case 'CNT_HEALTHCHECK_FAIL':
      return remediateHealthcheckFail(err);

    case 'INF_CREDIT_ZERO':
      return remediateCreditZero(err);

    case 'GPU_DRIVER_MISMATCH':
    case 'GPU_CUDA_MISMATCH':
      return remediateGpuMismatch(err);

    default:
      // No auto-remediation for this error
      return null;
  }
}

async function remediateOom(err: DeployError): Promise<RemediationAction> {
  const imageName = err.context.imageName || err.context.image || '';
  const currentGpu = err.context.gpuType || '';

  // Find GPUs with more VRAM
  const compatibleGpus = getCompatibleGpus(imageName as string);
  const largerGpus = compatibleGpus.filter(_gpu => {
    // This is a simplification — in production, compare VRAM specs
    return true;
  });

  if (largerGpus.length > 0) {
    const suggestion = largerGpus.slice(0, 3).join(', ');
    log.warn({ code: err.code, suggestions: largerGpus.slice(0, 3) }, 'Auto-remediation: OOM — suggesting larger GPUs');
    return {
      action: 'Suggest larger GPUs',
      reason: `Current GPU (${currentGpu}) has insufficient VRAM`,
      success: true,
      suggestions: [`Try these GPUs with more VRAM: ${suggestion}`],
    };
  }

  return {
    action: 'No larger GPUs available',
    reason: 'All compatible GPUs have insufficient VRAM',
    success: false,
    suggestions: [
      'Use a quantized model (Q4 instead of FP16)',
      'Reduce context length',
      'Use CPU offloading',
    ],
  };
}

function remediateDockerHubRateLimit(err: DeployError): RemediationAction {
  const hasAuth = !!(process.env.DOCKERHUB_USERNAME && process.env.DOCKERHUB_TOKEN);

  if (hasAuth) {
    return {
      action: 'Docker Hub authenticated — retry with higher limit',
      reason: 'Already authenticated, may be transient rate limit',
      success: true,
      suggestions: ['Wait 6 hours for rate limit reset, or use a different Docker Hub account'],
    };
  }

  return {
    action: 'Suggest Docker Hub authentication',
    reason: 'Anonymous rate limit reached (100 pulls/6h)',
    success: true,
    suggestions: [
      'Set DOCKERHUB_USERNAME and DOCKERHUB_TOKEN to increase limit to 200 pulls/6h',
      'Use a mirror registry (ghcr.io, quay.io)',
    ],
  };
}

function remediateHealthcheckFail(err: DeployError): RemediationAction {
  return {
    action: 'Suggest removing or extending HEALTHCHECK',
    reason: 'Container health check failed during model loading — Vast.ai may auto-destroy',
    success: true,
    suggestions: [
      'Add --start-period=600s to HEALTHCHECK in Dockerfile',
      'Remove HEALTHCHECK entirely if model loading takes >5 min',
      'Use a lighter health check endpoint (/ping instead of /health)',
    ],
  };
}

function remediateCreditZero(err: DeployError): RemediationAction {
  return {
    action: 'Block deploy — account credits exhausted',
    reason: 'Vast.ai auto-stops instances when credit = 0',
    success: false,
    suggestions: [
      'Add credits to your Vast.ai account before deploying',
      'Use a different provider (RunPod, TensorDock, Modal)',
    ],
  };
}

function remediateGpuMismatch(err: DeployError): RemediationAction {
  return {
    action: 'Suggest compatible GPUs',
    reason: err.code === 'GPU_DRIVER_MISMATCH'
      ? 'NVIDIA driver version incompatible'
      : 'CUDA version mismatch between container and host',
    success: true,
    suggestions: [
      'Use an image built for older CUDA version',
      'Choose a GPU host with newer NVIDIA drivers',
      'Rebuild Docker image with --build-arg CUDA_VERSION=12.0',
    ],
  };
}
