/**
 * GPU Handlers Types
 */

import type { IncomingMessage, ServerResponse } from 'http';

export interface DeployRequest {
  dockerImage: string;
  gpuTypes?: string[];
  env?: Record<string, string>;
  onstart?: string;
  dockerfile?: string;
  networkVolumeId?: string;
  diskGb?: number;
  region?: string;
  apiKey?: string;
  priority?: string[];
  sortBy?: string;
  llmModel?: string;
  skipIfRunning?: boolean;
  force?: boolean;
  race?: boolean;
  raceCount?: number;
  maxCostUsd?: number;
}

export interface DeployResponse {
  success: boolean;
  deployId?: string;
  provider?: string;
  endpoint?: string;
  error?: string;
  message?: string;
}

export interface VramValidationResult {
  vramGb: number;
  hint: string;
}

export interface SnapshotRequest {
  name?: string;
  description?: string;
}

export interface GpuVramInfo {
  gpu: string;
  vram: number;
}

export interface DeployTier {
  provider: string;
  gpuType: string;
  estimatedCost: number;
  region?: string;
}

export interface DeployHistoryEntry {
  deployId: string;
  timestamp: number;
  provider: string;
  gpuType: string;
  dockerImage: string;
  status: string;
  duration?: number;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
