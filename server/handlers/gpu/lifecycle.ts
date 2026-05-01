/**
 * GPU Lifecycle Handlers
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createLogger } from '../../../src/logger';
import { safeClose } from '../../../src/safe-catch';
import {
  deployState,
  setDeployState,
  deployCancelled,
  setDeployCancelled,
  deployLock,
  setDeployLock,
  deployPromise,
  setDeployPromise,
  resetDeployState,
} from '../../state';
import {
  startDeployWithTiers,
  startDeployRace,
  buildGpuTiers,
  cleanupAllPods,
  IDLE_TIMEOUT_MS,
  clearAutoDestroyTimer,
} from '../../gpu-deploy';
import { logGpuEvent, updateDeploySession } from '../../metrics';
import { readJsonBody } from '../../http-utils';
import { categorizeDeployError } from '../../../src/errors/deploy-errors';
import { errorSummary } from '../../../src/error-summary';
import { timerManager } from '../../../src/timer-manager';
import { generateDeployId, formatDeployStatus, parseDeployBody, updateDeployProgress } from './deploy-utils';
import { GPU_VRAM_GB, estimateModelVramGb, validateVramForModel } from './vram';
import type { DeployRequest, DeployResponse } from './types';

const log = createLogger('gpu-lifecycle');

/**
 * Handle GPU deploy request
 */
export async function handleGpuDeploy(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = generateDeployId();
  log.log(`[${requestId}] Starting GPU deploy handler`);

  try {
    // Check if deploy already in progress
    if (deployLock) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'Deploy already in progress',
        currentDeploy: formatDeployStatus(),
      }));
      return;
    }

    // Parse request body
    const body = await readJsonBody(req) as unknown as DeployRequest;

    if (!body.dockerImage) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'dockerImage is required',
      }));
      return;
    }

    // Check force flag
    if (body.force && deployState.status !== 'idle') {
      log.warn(`[${requestId}] Force deploy requested - terminating current deploy`);
      await cleanupAllPods(process.env.RUNPOD_API_KEY || '', deployState.podId ? [deployState.podId] : []);
      resetDeployState();
    }

    // Validate VRAM requirements
    const vramEstimate = estimateModelVramGb(
      body.dockerImage,
      body.onstart || '',
      body.env || {},
      body.llmModel || ''
    );

    if (vramEstimate.vramGb > 0) {
      const gpuTypes = body.gpuTypes || Object.keys(GPU_VRAM_GB);
      const validation = validateVramForModel(
        gpuTypes,
        vramEstimate.vramGb,
        vramEstimate.hint
      );

      if (!validation.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: validation.message,
          requiredVram: vramEstimate.vramGb,
          hint: vramEstimate.hint,
        }));
        return;
      }
    }

    // Start deploy
    setDeployLock(true);
    setDeployCancelled(false);

    const deployId = generateDeployId();
    setDeployState({
      status: 'creating',
      deployId,
      dockerImage: body.dockerImage,
      gpuType: body.gpuTypes?.[0] || 'NVIDIA GeForce RTX 4090',
      message: 'Starting deploy...',
      step: 'initializing',
      startedAt: Date.now(),
    });

    logGpuEvent('deploy_start', 'gateway', true, {
      metadata: {
        deployId,
        dockerImage: body.dockerImage,
        gpuTypes: body.gpuTypes,
      },
    });

    // Build tiers and start deploy
    const gpuTypes = body.gpuTypes || ['NVIDIA GeForce RTX 4090'];
    const tiers = buildGpuTiers(
      process.env.RUNPOD_API_KEY || '',
      process.env.VAST_API_KEY || undefined,
      (process.env.TENSORDOCK_API_KEY && process.env.TENSORDOCK_AUTH_ID)
        ? { apiKey: process.env.TENSORDOCK_API_KEY, authId: process.env.TENSORDOCK_AUTH_ID }
        : undefined,
      (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET)
        ? `${process.env.MODAL_TOKEN_ID}:${process.env.MODAL_TOKEN_SECRET}`
        : undefined,
      process.env.HYPERSTACK_API_KEY || undefined,
    );

    if (body.race) {
      // Race deploy across multiple providers
      const racePromise = startDeployRace(tiers, body.dockerImage, gpuTypes, {
        env: body.env,
        onstart: body.onstart,
        storageGb: body.diskGb,
        region: body.region,
      }, body.raceCount ?? 2);
      setDeployPromise(racePromise);
    } else {
      // Sequential tier deploy
      const tierPromise = startDeployWithTiers(
        tiers,
        body.dockerImage,
        gpuTypes,
        {
          env: body.env,
          onstart: body.onstart,
          storageGb: body.diskGb,
          region: body.region,
        }
      );
      setDeployPromise(tierPromise);
    }

    // Return immediately with deploy ID
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      deployId,
      message: 'Deploy started',
      status: formatDeployStatus(),
    }));

    // Continue deploy in background
    deployPromise?.then(() => {
      log.log(`[${requestId}] Deploy completed successfully`);
      updateDeploySession({ status: 'completed' });
    }).catch((err) => {
      log.error(`[${requestId}] Deploy failed:`, err);
      const deployErr = categorizeDeployError(err, {
        provider: deployState.provider,
        detail: 'Background deploy',
      });
      errorSummary.record(deployErr);
      updateDeploySession({ status: 'failed', errorMessage: err instanceof Error ? err.message : String(err) });
    }).finally(() => {
      setDeployLock(false);
      setDeployPromise(null);
    });

  } catch (err) {
    log.error(`[${requestId}] Deploy handler error:`, err);
    setDeployLock(false);

    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: errorMsg,
    }));
  }
}

/**
 * Handle GPU terminate request
 */
export async function handleGpuTerminate(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  log.log('Terminating GPU deploy');

  try {
    // Cancel any in-progress deploy
    setDeployCancelled(true);

    // Clear auto-destroy timer if set
    clearAutoDestroyTimer();

    // Clean up all pods
    const cleanupResult = await cleanupAllPods(process.env.RUNPOD_API_KEY || '', deployState.podId ? [deployState.podId] : []);

    // Reset deploy state
    resetDeployState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'GPU terminated',
      cleanupResult,
    }));

  } catch (err) {
    log.error('Terminate error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: errorMsg,
    }));
  }
}

/**
 * Handle GPU stop request
 */
export async function handleGpuStop(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  log.log('Stopping GPU');

  try {
    if (deployState.status !== 'ready' || !deployState.podId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'No active GPU to stop',
      }));
      return;
    }

    // Update state
    setDeployState({
      status: 'stopped',
      message: 'GPU stopped',
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'GPU stopped',
      status: formatDeployStatus(),
    }));

  } catch (err) {
    log.error('Stop error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: errorMsg,
    }));
  }
}

/**
 * Handle GPU resume request
 */
export async function handleGpuResume(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  log.log('Resuming GPU');

  try {
    if (deployState.status !== 'stopped') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'GPU is not stopped',
      }));
      return;
    }

    // Update state
    setDeployState({
      status: 'booting',
      message: 'Resuming GPU...',
      step: 'resuming',
    });

    // In a real implementation, this would call the provider's resume API
    // For now, we just update the state
    setTimeout(() => {
      setDeployState({
        status: 'ready',
        message: 'GPU resumed',
      });
    }, 5000);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'GPU resume initiated',
      status: formatDeployStatus(),
    }));

  } catch (err) {
    log.error('Resume error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: errorMsg,
    }));
  }
}

/**
 * Handle deploy status request
 */
export async function handleGpuStatus(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: true,
    status: formatDeployStatus(),
  }));
}
