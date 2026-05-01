/**
 * RunPod Client Utilities
 */

import { createLogger } from '../../../../logger';
import { RUNPOD_API_BASE, RUNPOD_RETRY_DELAY_MS, RUNPOD_MAX_RETRIES } from './constants';
import { categorizeDeployError } from '../../../../errors/deploy-errors';
import type { RunpodPod } from './types';

const log = createLogger('runpod-utils');

/**
 * Make authenticated request to RunPod API with retry logic
 */
export async function runpodRequest<T>(
  endpoint: string,
  apiKey: string,
  options: RequestInit = {},
  retryOptions: {
    maxRetries?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const { maxRetries = RUNPOD_MAX_RETRIES, retryDelayMs = RUNPOD_RETRY_DELAY_MS, timeoutMs = 30000 } = retryOptions;

  const url = `${RUNPOD_API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    ...(options.headers as Record<string, string>),
  };

  // Add Content-Type for POST/PUT requests
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Return response on success or non-retryable error
      if (response.ok || response.status < 500) {
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`RunPod API error: HTTP ${response.status} ${errorText.substring(0, 300)}`);
        }

        // Handle empty response
        const contentLength = response.headers.get('content-length');
        if (contentLength === '0' || response.status === 204) {
          return undefined as T;
        }

        return await response.json() as T;
      }

      // Retry on 5xx errors
      if (attempt < maxRetries) {
        log.warn(`RunPod API retry ${attempt + 1}/${maxRetries + 1}: HTTP ${response.status}`);
        await new Promise(r => setTimeout(r, retryDelayMs));
      } else {
        const errorText = await response.text().catch(() => '');
        throw new Error(`RunPod API error: HTTP ${response.status} ${errorText.substring(0, 300)}`);
      }
    } catch (err) {
      if (attempt >= maxRetries) {
        const deployErr = categorizeDeployError(err, {
          provider: 'runpod',
          detail: `API request to ${endpoint}`,
        });
        log.error({ code: deployErr.code, category: deployErr.category }, `RunPod request failed: ${deployErr.message}`);
        throw err;
      }

      // Don't retry on 4xx errors
      if (err instanceof Error && err.message.includes('HTTP 4')) {
        throw err;
      }

      log.warn(`RunPod API retry ${attempt + 1}/${maxRetries + 1}: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  throw new Error('Unexpected end of retry loop');
}

/**
 * Resolve endpoint URL from pod data
 */
export function resolvePodEndpoint(pod: RunpodPod): string {
  const runtime = pod.runtime;
  const runtimePorts = runtime?.ports;
  const runtimeIp = typeof runtimePorts?.[0]?.ip === 'string' ? runtimePorts[0].ip : undefined;
  const portEntry = runtimePorts?.find((p) => p.privatePort === 8000);
  const runtimePort = typeof portEntry?.publicPort === 'number' ? portEntry.publicPort : undefined;

  // Fallback to top-level properties
  const podRecord = pod as unknown as Record<string, unknown>;
  const topIp = typeof podRecord.publicIp === 'string'
    ? podRecord.publicIp
    : undefined;
  const portMappings = podRecord.portMappings as Record<string, unknown> | undefined;
  const topPort = typeof portMappings?.['8000'] === 'number' ? portMappings['8000'] as number : undefined;

  // Build endpoint URL
  if (runtimeIp && runtimePort) {
    return `http://${runtimeIp}:${runtimePort}`;
  }

  if (topIp && topPort) {
    return `http://${topIp}:${topPort}`;
  }

  // Default proxy URL
  return `https://${pod.id}-8000.proxy.runpod.net`;
}

/**
 * Check if pod is in running state
 */
export function isPodRunning(pod: RunpodPod): boolean {
  return pod.desiredStatus === 'RUNNING' && pod.runtime?.uptimeInSeconds !== undefined;
}

/**
 * Check if pod is in terminal state
 */
export function isPodTerminal(pod: RunpodPod): boolean {
  return ['EXITED', 'ERROR', 'TERMINATED'].includes(pod.desiredStatus);
}

/**
 * Format GPU type name for display
 */
export function formatGpuType(gpuTypeId: string): string {
  return gpuTypeId.replace('NVIDIA ', '');
}

/**
 * Parse environment variables from array to object
 */
export function parseEnvVars(envArray: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of envArray) {
    const [key, value] = entry.split('=');
    if (key) {
      env[key] = value || '';
    }
  }
  return env;
}

/**
 * Build environment variables array from object
 */
export function buildEnvVars(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}
