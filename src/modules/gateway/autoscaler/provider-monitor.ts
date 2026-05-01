import type { GpuProviderRegistry } from '../providers/gpu/registry';
import type { ProviderCredentials } from '../providers/gpu/types';
import type { Logger } from '../../deps';

export interface ProviderMonitorOptions {
  registry: GpuProviderRegistry;
  logger: Logger;
  resolveCredentials?: (provider: string) => Promise<ProviderCredentials | null>;
}

const PRICE_UPDATE_INTERVAL_MS = parseInt(process.env.PRICE_UPDATE_INTERVAL_MS || String(5 * 60 * 1000), 10);

/** Tracks real-time GPU pricing and provider reliability scores. */
export class ProviderMonitor {
  private priceCache = new Map<string, { price: number; timestamp: number }>();
  private lastPriceUpdate = 0;
  private reliabilityScores = new Map<string, number>();
  private providerHealthStats = new Map<string, { success: number; failure: number; lastUpdate: number }>();

  private readonly registry: GpuProviderRegistry;
  private readonly logger: Logger;
  private readonly resolveCredentials?: (provider: string) => Promise<ProviderCredentials | null>;

  constructor(opts: ProviderMonitorOptions) {
    this.registry = opts.registry;
    this.logger = opts.logger;
    this.resolveCredentials = opts.resolveCredentials;
  }

  getPriceUpdateIntervalMs(): number {
    return PRICE_UPDATE_INTERVAL_MS;
  }

  getPriceInfo(provider: string): { price: number; timestamp: number } | undefined {
    return this.priceCache.get(provider);
  }

  /** Default 0.5 when no history available. */
  getReliabilityScore(provider: string): number {
    return this.reliabilityScores.get(provider) ?? 0.5;
  }

  getProviderReliability(provider: string): number {
    return this.reliabilityScores.get(provider) ?? 0.5;
  }

  getProviderPrice(provider: string): number | null {
    return this.priceCache.get(provider)?.price ?? null;
  }

  /** Record a boot success or failure — updates exponential moving average reliability score. */
  recordHealthEvent(provider: string, success: boolean): void {
    const stats = this.providerHealthStats.get(provider) ?? { success: 0, failure: 0, lastUpdate: Date.now() };
    if (success) { stats.success++; } else { stats.failure++; }
    stats.lastUpdate = Date.now();
    this.providerHealthStats.set(provider, stats);

    const total = stats.success + stats.failure;
    if (total > 0) {
      const rawReliability = stats.success / total;
      const currentScore = this.reliabilityScores.get(provider) ?? 0.5;
      const newScore = currentScore * 0.9 + rawReliability * 0.1;
      this.reliabilityScores.set(provider, Math.min(1, Math.max(0, newScore)));
    }
  }

  /** Refresh price cache if stale. No-op if cache is still fresh. */
  async updatePriceCacheIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPriceUpdate < PRICE_UPDATE_INTERVAL_MS) return;

    this.logger.log('[autoscaler] Updating GPU price cache...');
    this.lastPriceUpdate = now;

    const providerIds = ['vast', 'runpod', 'tensordock', 'modal'];
    for (const providerId of providerIds) {
      const client = this.registry.get(providerId);
      if (!client?.listOffers) continue;

      try {
        const credentials = await this._getProviderCredentials(providerId);
        if (!credentials) {
          this.logger.log(`[autoscaler] No credentials for ${providerId}, using fallback pricing`);
          this._setFallbackPrice(providerId, now);
          continue;
        }

        const offers = await client.listOffers({}, credentials);
        if (offers.length > 0) {
          const cheapest = offers.reduce((best, o) => o.pricePerHr < best.pricePerHr ? o : best, offers[0]);
          this.priceCache.set(providerId, { price: cheapest.pricePerHr, timestamp: now });

          const avgReliability = offers
            .filter(o => o.reliability !== undefined)
            .reduce((sum, o, _, arr) => sum + (o.reliability ?? 0) / arr.length, 0);
          if (avgReliability > 0) {
            const tracked = this.reliabilityScores.get(providerId) ?? 0.5;
            this.reliabilityScores.set(providerId, tracked * 0.3 + avgReliability * 0.7);
          }

          this.logger.log(`[autoscaler] ${providerId}: $${cheapest.pricePerHr.toFixed(3)}/hr, ${offers.length} offers available`);
        } else {
          this._setFallbackPrice(providerId, now);
        }
      } catch (err) {
        this.logger.warn(`[autoscaler] Failed to fetch prices for ${providerId}: ${err instanceof Error ? err.message : String(err)}`);
        this._setFallbackPrice(providerId, now);
      }
    }

    this.logger.log(`[autoscaler] Price cache updated with ${this.priceCache.size} providers`);
  }

  private async _getProviderCredentials(providerId: string): Promise<ProviderCredentials | null> {
    if (this.resolveCredentials) {
      const creds = await this.resolveCredentials(providerId);
      if (creds) return creds;
    }
    switch (providerId) {
      case 'vast':
        return process.env.VAST_API_KEY ? { apiKey: process.env.VAST_API_KEY } : null;
      case 'runpod':
        return process.env.RUNPOD_API_KEY ? { apiKey: process.env.RUNPOD_API_KEY } : null;
      case 'tensordock':
        return (process.env.TENSORDOCK_API_TOKEN && process.env.TENSORDOCK_AUTH_ID)
          ? { apiKey: process.env.TENSORDOCK_API_TOKEN, authId: process.env.TENSORDOCK_AUTH_ID }
          : null;
      case 'modal':
        if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) {
          return { apiKey: `${process.env.MODAL_TOKEN_ID}:${process.env.MODAL_TOKEN_SECRET}` };
        }
        return process.env.MODAL_API_KEY ? { apiKey: process.env.MODAL_API_KEY } : null;
      default:
        return null;
    }
  }

  private _setFallbackPrice(providerId: string, timestamp: number): void {
    const fallbackPrices: Record<string, number> = {
      vast: 0.35, runpod: 0.45, tensordock: 0.60, modal: 1.20,
    };
    this.priceCache.set(providerId, { price: fallbackPrices[providerId] ?? 0.50, timestamp });
  }
}
