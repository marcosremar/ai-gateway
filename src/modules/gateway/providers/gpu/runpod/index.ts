/**
 * RunPod Client — Modular Implementation
 * 
 * Split from the original 1661-line runpod-client.ts into focused modules:
 * - types.ts: TypeScript interfaces and types
 * - constants.ts: GPU mappings, datacenter maps, configuration
 * - utils.ts: API utilities, retry logic, endpoint resolution
 * - instances.ts: Pod lifecycle management
 * - volumes.ts: Network volume management
 * - offers.ts: GPU offer search and pricing
 */

// Re-export for backward compatibility
export { RunpodClient } from '../runpod-client';

// Types
export type {
  RunpodCredentials,
  RunpodNetworkVolume,
  RunpodPod,
  RunpodPodRuntime,
  RunpodPort,
  RunpodGpuInfo,
  RunpodOffer,
  CreatePodRequest,
  RunpodInstance,
  RunpodInstanceDetail,
  RunpodInstanceStatus,
} from './types';

// Constants
export {
  RUNPOD_GPU_FALLBACK,
  RUNPOD_GPU_TYPE_MAP,
  RUNPOD_DATACENTER_MAP,
  RUNPOD_API_BASE,
  RUNPOD_BOOT_TIME_SECS,
  RUNPOD_RETRY_DELAY_MS,
  RUNPOD_MAX_RETRIES,
  resolveDatacenterIds,
} from './constants';

// Utils
export {
  runpodRequest,
  resolvePodEndpoint,
  isPodRunning,
  isPodTerminal,
  formatGpuType,
  parseEnvVars,
  buildEnvVars,
} from './utils';

// Instances
export {
  listPods,
  getPod,
  createPod,
  stopPod,
  startPod,
  terminatePod,
  getInstanceDetail,
  getInstanceStatus,
  resolveInstanceEndpoint,
  checkBalance,
  waitForStatus,
  podToInstance,
} from './instances';

// Volumes
export {
  listNetworkVolumes,
  getNetworkVolume,
  createNetworkVolume,
  updateNetworkVolume,
  deleteNetworkVolume,
  getVolumesByDatacenter,
  validateVolume,
} from './volumes';

// Offers
export {
  listOffers,
  searchOffers,
  getBestOffer,
  getOffersByGpuType,
  getCheapestOffers,
  estimateCost,
  type OfferSearchFilters,
} from './offers';
