import type { GpuTierConfig, GpuTierState, IdleTierState } from '../../types';
import type { GpuProviderRegistry } from '../providers/gpu/registry';
import type { Logger } from '../../deps';
import type { ProviderMonitor } from './provider-monitor';

export interface TierSelectorOptions {
  registry: GpuProviderRegistry;
  logger: Logger;
}

/**
 * Selects the best GPU tier for booting based on price, reliability, and performance.
 * ProviderMonitor is passed per-call (not stored) to avoid circular references.
 */
export class TierSelector {
  private readonly registry: GpuProviderRegistry;
  private readonly logger: Logger;

  constructor(opts: TierSelectorOptions) {
    this.registry = opts.registry;
    this.logger = opts.logger;
  }

  /**
   * Find the best tier for booting, with async price cache update.
   * @returns Index of the best tier, or -1 if no suitable tier found
   */
  async findBestTierForBoot(
    tiers: GpuTierConfig[],
    tierStates: GpuTierState[],
    userId: string,
    monitor: ProviderMonitor,
  ): Promise<number> {
    await monitor.updatePriceCacheIfNeeded();
    return this.selectBestTierSync(tiers, tierStates, userId, monitor);
  }

  /**
   * Synchronous tier selection — assumes price cache is already fresh.
   * @returns Index of the best tier, or -1 if no suitable tier found
   */
  selectBestTierSync(
    tiers: GpuTierConfig[],
    tierStates: GpuTierState[],
    userId: string,
    monitor: ProviderMonitor,
  ): number {
    let bestScore = -1;
    let bestIndex = -1;

    for (let i = 0; i < tiers.length; i++) {
      const tierConfig = tiers[i];
      const tierState = tierStates[i];

      if (!this.isTierEligibleForBoot(tierConfig, tierState)) continue;

      const score = this.calculateTierScore(tierConfig, tierState, userId, monitor);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  /** Check if a tier is eligible for booting (not manually stopped, not unhealthy, not in cooldown). */
  isTierEligibleForBoot(tierConfig: GpuTierConfig, tierState: GpuTierState): boolean {
    if (tierState.state === 'idle') {
      const idleState = tierState as IdleTierState;
      if (idleState.manualStop) return false;
      if (idleState.unhealthy) return false;
      if (idleState.cooldownUntil && Date.now() < idleState.cooldownUntil) return false;
    }
    return tierState.state === 'idle';
  }

  /**
   * Calculate a score for a tier based on price, reliability, and performance factors.
   * Higher score = better tier.
   */
  calculateTierScore(
    tierConfig: GpuTierConfig,
    tierState: GpuTierState,
    userId: string,
    monitor: ProviderMonitor,
  ): number {
    let score = 0;
    const provider = tierConfig.provider;

    // Price factor (0-40 points): lower price = higher score
    const priceInfo = monitor.getPriceInfo(provider);
    if (priceInfo && Date.now() - priceInfo.timestamp < monitor.getPriceUpdateIntervalMs()) {
      const normalizedPrice = Math.min(5, Math.max(0, priceInfo.price));
      score += ((5 - normalizedPrice) / 5) * 40;
    } else {
      score += 20; // neutral when no price data
    }

    // Reliability factor (0-30 points): based on historical success rates
    score += monitor.getReliabilityScore(provider) * 30;

    // Performance factor (0-20 points): based on boot time
    const providerClient = this.registry.get(provider);
    if (providerClient) {
      const bootTimeSecs = providerClient.bootTimeSecs ?? 300;
      score += Math.max(0, (600 - bootTimeSecs) / 600) * 20;
    } else {
      score += 10; // neutral when provider unknown
    }

    // Spot instance bonus (0-10 points): stateless workloads on spot-friendly providers
    if (tierConfig.storageGb === 0 && ['vast', 'runpod'].includes(provider)) {
      score += 5;
    }

    return score;
  }
}
