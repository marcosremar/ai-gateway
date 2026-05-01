/**
 * RunPod Offer Search
 */

import { createLogger } from '../../../../logger';
import { runpodRequest } from './utils';
import { RUNPOD_GPU_TYPE_MAP, resolveDatacenterIds } from './constants';
import type { RunpodOffer, RunpodCredentials } from './types';

const log = createLogger('runpod-offers');

export interface OfferSearchFilters {
  gpuType?: string;
  minVcpu?: number;
  minMemory?: number;
  minGpuCount?: number;
  maxPrice?: number;
  dataCenterId?: string;
  region?: string;
  cloudType?: 'COMMUNITY' | 'SECURE' | 'BOTH';
}

/**
 * List all available GPU offers
 */
export async function listOffers(
  credentials: RunpodCredentials
): Promise<RunpodOffer[]> {
  try {
    const offers = await runpodRequest<RunpodOffer[]>(
      '/gpus',
      credentials.apiKey
    );
    return offers || [];
  } catch (err) {
    log.error('Failed to list offers:', err);
    throw err;
  }
}

/**
 * Search offers with filters
 */
export async function searchOffers(
  filters: OfferSearchFilters,
  credentials: RunpodCredentials
): Promise<RunpodOffer[]> {
  try {
    let offers = await listOffers(credentials);

    // Apply filters
    if (filters.gpuType) {
      const fullGpuType = RUNPOD_GPU_TYPE_MAP[filters.gpuType] || filters.gpuType;
      offers = offers.filter(o => o.gpuType.displayName === fullGpuType);
    }

    if (filters.minVcpu) {
      offers = offers.filter(o => o.minVcpu >= filters.minVcpu!);
    }

    if (filters.minMemory) {
      offers = offers.filter(o => o.minMemory >= filters.minMemory!);
    }

    if (filters.minGpuCount) {
      offers = offers.filter(o => o.maxPodGpuCount >= filters.minGpuCount!);
    }

    if (filters.maxPrice) {
      offers = offers.filter(o =>
        o.communityPrice <= filters.maxPrice! ||
        o.securePrice <= filters.maxPrice!
      );
    }

    if (filters.dataCenterId) {
      offers = offers.filter(o => o.dataCenterId === filters.dataCenterId);
    }

    if (filters.region) {
      const datacenterIds = resolveDatacenterIds(filters.region);
      if (datacenterIds) {
        offers = offers.filter(o => datacenterIds.includes(o.dataCenterId));
      }
    }

    if (filters.cloudType && filters.cloudType !== 'BOTH') {
      // Filter based on availability in specific cloud type
      offers = offers.filter(o => {
        if (filters.cloudType === 'COMMUNITY') {
          return o.communityPrice > 0;
        }
        if (filters.cloudType === 'SECURE') {
          return o.securePrice > 0;
        }
        return true;
      });
    }

    // Sort by price (cheapest first)
    offers.sort((a, b) => {
      const priceA = Math.min(a.communityPrice || Infinity, a.securePrice || Infinity);
      const priceB = Math.min(b.communityPrice || Infinity, b.securePrice || Infinity);
      return priceA - priceB;
    });

    log.log(`Found ${offers.length} offers matching filters`);
    return offers;
  } catch (err) {
    log.error('Failed to search offers:', err);
    throw err;
  }
}

/**
 * Get best offer for a GPU type
 */
export async function getBestOffer(
  gpuType: string,
  credentials: RunpodCredentials,
  options: {
    dataCenterId?: string;
    maxPrice?: number;
  } = {}
): Promise<RunpodOffer | null> {
  const offers = await searchOffers(
    {
      gpuType,
      dataCenterId: options.dataCenterId,
      maxPrice: options.maxPrice,
    },
    credentials
  );

  return offers.length > 0 ? offers[0] : null;
}

/**
 * Get offers grouped by GPU type
 */
export async function getOffersByGpuType(
  credentials: RunpodCredentials
): Promise<Record<string, RunpodOffer[]>> {
  const offers = await listOffers(credentials);

  const grouped: Record<string, RunpodOffer[]> = {};

  for (const offer of offers) {
    const gpuName = offer.gpuType.displayName;
    if (!grouped[gpuName]) {
      grouped[gpuName] = [];
    }
    grouped[gpuName].push(offer);
  }

  // Sort each group by price
  for (const gpuName of Object.keys(grouped)) {
    grouped[gpuName].sort((a, b) => {
      const priceA = Math.min(a.communityPrice || Infinity, a.securePrice || Infinity);
      const priceB = Math.min(b.communityPrice || Infinity, b.securePrice || Infinity);
      return priceA - priceB;
    });
  }

  return grouped;
}

/**
 * Get cheapest offer for each GPU type
 */
export async function getCheapestOffers(
  credentials: RunpodCredentials
): Promise<Record<string, RunpodOffer>> {
  const grouped = await getOffersByGpuType(credentials);

  const cheapest: Record<string, RunpodOffer> = {};

  for (const [gpuName, offers] of Object.entries(grouped)) {
    if (offers.length > 0) {
      cheapest[gpuName] = offers[0];
    }
  }

  return cheapest;
}

/**
 * Calculate estimated cost for a deployment
 */
export function estimateCost(
  offer: RunpodOffer,
  config: {
    gpuCount: number;
    hours: number;
    cloudType: 'COMMUNITY' | 'SECURE';
  }
): number {
  const pricePerHour = config.cloudType === 'COMMUNITY'
    ? offer.communityPrice
    : offer.securePrice;

  return pricePerHour * config.gpuCount * config.hours;
}
