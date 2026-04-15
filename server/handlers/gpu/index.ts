/**
 * GPU Handlers — Modular Implementation
 * 
 * Split from the original 1656-line gpu-handlers.ts into focused modules:
 * - types.ts: TypeScript interfaces
 * - vram.ts: VRAM estimation and validation
 * - deploy-utils.ts: Deploy utility functions
 * - lifecycle.ts: Deploy, stop, resume, terminate handlers
 * - snapshots.ts: Snapshot CRUD operations
 */

// Types
export type {
  DeployRequest,
  DeployResponse,
  VramValidationResult,
  SnapshotRequest,
  GpuVramInfo,
  DeployTier,
  DeployHistoryEntry,
  HttpHandler,
} from './types';

// VRAM
export {
  GPU_VRAM_GB,
  estimateModelVramGb,
  gpuTypesWithSufficientVram,
  gpuTypesWithInsufficientVram,
  validateVramForModel,
  type VramEstimate,
} from './vram';

// Deploy Utilities
export {
  generateDeployId,
  validateGpuCredentials,
  estimateDeployCost,
  formatDeployStatus,
  parseDeployBody,
  sanitizeGpuTypes,
  updateDeployProgress,
  calculateDeployTimeout,
  isDeployInProgress,
} from './deploy-utils';

// Lifecycle Handlers
export {
  handleGpuDeploy,
  handleGpuTerminate,
  handleGpuStop,
  handleGpuResume,
  handleGpuStatus,
} from './lifecycle';

// Snapshot Handlers
export {
  handleSnapshotCreate,
  handleSnapshotList,
  handleSnapshotRestore,
  handleSnapshotDelete,
} from './snapshots';
