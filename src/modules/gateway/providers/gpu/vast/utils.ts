/**
 * Vast.ai Client Utilities
 */

import { createLogger } from '../../../../logger';
import type { VastCredentials } from './types';

const log = createLogger('vast-client');

export const VAST_API_BASE = 'https://console.vast.ai/api/v0';

/**
 * Make authenticated request to Vast.ai API
 */
export async function vastRequest<T>(
  endpoint: string,
  credentials: VastCredentials,
  options: RequestInit = {}
): Promise<T> {
  const url = `${VAST_API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  // Add Authorization header if API key provided
  if (credentials.apiKey) {
    headers['Authorization'] = `Bearer ${credentials.apiKey}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Vast.ai API error: HTTP ${response.status} ${errorText.substring(0, 300)}`);
  }

  const data = await response.json() as T;
  return data;
}

/**
 * Extract error message from Vast.ai error response
 */
export function extractVastError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown Vast.ai error';
}

/**
 * Calculate score for an offer based on various factors
 */
export function calculateOfferScore(offer: {
  dph_total: number;
  reliability: number;
  dlperf: number;
  inet_up: number;
  inet_down: number;
}): number {
  // Lower price is better (inverted)
  const priceScore = offer.dph_total > 0 ? 100 / offer.dph_total : 0;

  // Higher reliability is better
  const reliabilityScore = offer.reliability * 100;

  // Higher performance is better
  const perfScore = offer.dlperf;

  // Higher bandwidth is better
  const bandwidthScore = (offer.inet_up + offer.inet_down) / 100;

  // Weighted combination
  return priceScore * 0.3 + reliabilityScore * 0.3 + perfScore * 0.2 + bandwidthScore * 0.2;
}

/**
 * Format instance status from Vast.ai to internal format
 */
export function formatInstanceStatus(status: string): string {
  const statusMap: Record<string, string> = {
    'running': 'running',
    'created': 'creating',
    'loading': 'loading',
    'stopping': 'stopping',
    'stopped': 'stopped',
    'terminated': 'terminated',
    'error': 'error',
    'queued': 'queued',
  };

  return statusMap[status.toLowerCase()] || status.toLowerCase();
}

/**
 * Check if instance status is terminal
 */
export function isTerminalStatus(status: string): boolean {
  const terminalStatuses = ['terminated', 'error', 'stopped'];
  return terminalStatuses.includes(status.toLowerCase());
}

/**
 * Check if instance is in running state
 */
export function isRunningStatus(status: string): boolean {
  return status.toLowerCase() === 'running';
}
