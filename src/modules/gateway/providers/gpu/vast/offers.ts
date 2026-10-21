/**
 * Vast.ai Offer Search
 */

import { createLogger } from '../../../../logger';
import type { VastOffer, VastCredentials } from './types';
import { vastRequest, calculateOfferScore } from './utils';

const log = createLogger('vast-offers');

export interface OfferSearchFilters {
  gpuName?: string;
  minGpuRam?: number;
  minDlperf?: number;
  minInetUp?: number;
  minInetDown?: number;
  maxPrice?: number;
  minDisk?: number;
  verifiedOnly?: boolean;
  orderBy?: 'price' | 'dlperf' | 'reliability' | 'score';
  orderDir?: 'asc' | 'desc';
}

/**
 * Search for available GPU offers
 */
export async function searchOffers(
  filters: OfferSearchFilters = {},
  credentials: VastCredentials
): Promise<VastOffer[]> {
  try {
    // Build query string
    const params = new URLSearchParams();
    
    if (filters.gpuName) {
      params.set('gpu_name', filters.gpuName);
    }
    if (filters.minGpuRam) {
      params.set('gpu_ram', String(filters.minGpuRam));
    }
    if (filters.minDlperf) {
      params.set('dlperf', String(filters.minDlperf));
    }
    if (filters.minInetUp) {
      params.set('inet_up', String(filters.minInetUp));
    }
    if (filters.minInetDown) {
      params.set('inet_down', String(filters.minInetDown));
    }
    if (filters.maxPrice) {
      params.set('dph', String(filters.maxPrice));
    }
    if (filters.minDisk) {
      params.set('disk_space', String(filters.minDisk));
    }
    if (filters.verifiedOnly) {
      params.set('verified', 'true');
    }
    
    const queryString = params.toString();
    const endpoint = `/bundles/${queryString ? '?' + queryString : ''}`;
    
    const response = await vastRequest<{ offers: VastOffer[] }>(
      endpoint,
      credentials
    );
    
    let offers = response.offers || [];
    
    // Calculate scores for sorting
    offers = offers.map(offer => ({
      ...offer,
      score: calculateOfferScore(offer),
    }));
    
    // Sort results
    const orderBy = filters.orderBy || 'score';
    const orderDir = filters.orderDir || 'desc';
    
    offers.sort((a, b) => {
      let comparison = 0;
      
      switch (orderBy) {
        case 'price':
          comparison = a.dph_total - b.dph_total;
          break;
        case 'dlperf':
          comparison = a.dlperf - b.dlperf;
          break;
        case 'reliability':
          comparison = a.reliability - b.reliability;
          break;
        case 'score':
        default:
          comparison = (a.score || 0) - (b.score || 0);
          break;
      }
      
      return orderDir === 'asc' ? comparison : -comparison;
    });
    
    log.log(`Found ${offers.length} offers matching filters`);
    return offers;
  } catch (err) {
    log.error('Failed to search offers:', err);
    throw err;
  }
}

/**
 * Get best offer for a specific GPU type
 */
export async function getBestOffer(
  gpuName: string,
  credentials: VastCredentials,
  options: {
    maxPrice?: number;
    minReliability?: number;
  } = {}
): Promise<VastOffer | null> {
  const offers = await searchOffers(
    {
      gpuName,
      maxPrice: options.maxPrice,
      verifiedOnly: true,
      orderBy: 'score',
      orderDir: 'desc',
    },
    credentials
  );
  
  if (offers.length === 0) {
    return null;
  }
  
  // Filter by reliability if specified
  if (options.minReliability) {
    const reliableOffers = offers.filter(o => o.reliability >= options.minReliability!);
    if (reliableOffers.length > 0) {
      return reliableOffers[0];
    }
  }
  
  return offers[0];
}

/**
 * Get offers grouped by GPU type
 */
export async function getOffersByGpuType(
  credentials: VastCredentials
): Promise<Record<string, VastOffer[]>> {
  const offers = await searchOffers({}, credentials);
  
  const grouped: Record<string, VastOffer[]> = {};
  
  for (const offer of offers) {
    const gpuName = offer.gpu_name;
    if (!grouped[gpuName]) {
      grouped[gpuName] = [];
    }
    grouped[gpuName].push(offer);
  }
  
  // Sort each group by score
  for (const gpuName of Object.keys(grouped)) {
    grouped[gpuName].sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  
  return grouped;
}

/**
 * Get cheapest offer for each GPU type
 */
export async function getCheapestOffers(
  credentials: VastCredentials
): Promise<Record<string, VastOffer>> {
  const grouped = await getOffersByGpuType(credentials);
  
  const cheapest: Record<string, VastOffer> = {};
  
  for (const [gpuName, offers] of Object.entries(grouped)) {
    if (offers.length > 0) {
      // Sort by price ascending
      const sorted = [...offers].sort((a, b) => a.dph_total - b.dph_total);
      cheapest[gpuName] = sorted[0];
    }
  }
  
  return cheapest;
}
