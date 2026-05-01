/**
 * Vast.ai Client — Modular Implementation
 *
 * Split from the original 2765-line vast-client.ts into focused modules:
 * - types.ts: TypeScript interfaces and types
 * - utils.ts: Utility functions and API helpers
 * - instances.ts: Instance lifecycle management
 * - offers.ts: Offer search and filtering
 * - templates.ts: Template management
 */

// Types
export type {
  VastInstance,
  VastOffer,
  VastTemplate,
  VastEndpoint,
  VastHostReputation,
  VastCredentials,
  VastInstanceStatus,
} from './types';

// Utils
export {
  VAST_API_BASE,
  vastRequest,
  extractVastError,
  calculateOfferScore,
  formatInstanceStatus,
  isTerminalStatus,
  isRunningStatus,
} from './utils';

// Instances
export {
  listInstances,
  getInstance,
  createInstance,
  destroyInstance,
  stopInstance,
  startInstance,
  labelInstance,
  getInstanceStatus,
  isInstanceActive,
  waitForStatus,
} from './instances';

// Offers
export {
  searchOffers,
  getBestOffer,
  getOffersByGpuType,
  getCheapestOffers,
  type OfferSearchFilters,
} from './offers';

// Templates
export {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from './templates';
