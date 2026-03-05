/**
 * Decision Builder — pure function that assembles the route decision.
 *
 * Extracted from engine.ts Steps 4+5 (collect ready/booting tiers, build decision).
 */

import type {
  GpuTierConfig,
  GpuTierState,
  ReadyTierState,
  BootingTierState,
  GpuBootState,
  AutoScaleDecision,
  AutoScalerConfig,
} from '../types';
import type { GpuProviderRegistry } from '../gpu-providers/registry';

/** djb2 hash — much better distribution than simple charCode sum */
export function hashUserId(userId: string, max: number): number {
  let h = 5381;
  for (let i = 0; i < userId.length; i++) h = ((h << 5) + h) ^ userId.charCodeAt(i);
  return (h >>> 0) % max;
}

/**
 * Build the final AutoScaleDecision from current tier states.
 * Pure function — no side effects.
 */
export function buildDecision(
  tierStates: GpuTierState[],
  tiers: GpuTierConfig[],
  activeSessions: number,
  config: AutoScalerConfig,
  p95: number | null,
  latencyTriggered: boolean,
  registry: GpuProviderRegistry,
  userId: string,
): AutoScaleDecision {
  const maxLatencyMs = config.maxLatencyMs ?? 1500;
  const totalTiers = tiers.length;

  const readyTiers = tierStates.filter((ts): ts is ReadyTierState => ts.state === 'ready');
  const bootingTiersList = tierStates.filter((ts): ts is BootingTierState => ts.state === 'booting');
  const activeTiersCount = readyTiers.length;
  const bootingTiersCount = bootingTiersList.length;
  const highestState: GpuBootState =
    readyTiers.length > 0 ? 'ready' : bootingTiersList.length > 0 ? 'booting' : 'idle';

  if (readyTiers.length > 0) {
    const affinityIdx =
      readyTiers.length > 1
        ? hashUserId(userId, readyTiers.length)
        : 0;
    const primaryTier = readyTiers[affinityIdx];
    const primaryEndpoint = primaryTier.endpoint;
    return {
      route: 's2s',
      endpoint: primaryEndpoint,
      allEndpoints: readyTiers.map((ts) => ts.endpoint),
      reason: `S2S GPU ativa — ${activeSessions} sessões, ${readyTiers.length} tier(s) prontos${p95 ? `, p95=${p95}ms` : ''}`,
      activeSessions,
      threshold: config.threshold,
      maxLatencyMs,
      p95LatencyMs: p95,
      gpuState: 'ready',
      gpuEndpoint: primaryEndpoint,
      bootedAt: primaryTier.bootedAt,
      trigger: primaryTier.trigger,
      enabled: true,
      activeTiers: activeTiersCount,
      bootingTiers: bootingTiersCount,
      totalTiers,
    };
  }

  if (bootingTiersList.length > 0) {
    const firstBooting = bootingTiersList[0];
    const firstBootingConfig = tiers[firstBooting.tierIndex];
    const bootElapsedSecs = Math.round((Date.now() - firstBooting.bootTriggeredAt) / 1000);
    const avgBootSecs = firstBootingConfig
      ? (registry.get(firstBootingConfig.provider)?.bootTimeSecs ?? 120)
      : 120;
    const estimatedReadySecs = Math.max(0, avgBootSecs - bootElapsedSecs);
    return {
      route: 'llm',
      reason: `S2S GPU iniciando... ${activeSessions}/${config.threshold} sessões${latencyTriggered ? ` | p95=${p95}ms > ${maxLatencyMs}ms` : ''} (${bootingTiersCount} tier(s) em boot) — usando LLM`,
      activeSessions,
      threshold: config.threshold,
      maxLatencyMs,
      p95LatencyMs: p95,
      gpuState: 'booting',
      gpuEndpoint: firstBooting.endpoint || undefined,
      bootedAt: firstBooting.bootTriggeredAt,
      trigger: firstBooting.trigger,
      enabled: true,
      activeTiers: 0,
      bootingTiers: bootingTiersCount,
      totalTiers,
      estimatedReadySecs,
    };
  }

  return {
    route: 'llm',
    reason: `${activeSessions}/${config.threshold} sessões${p95 ? `, p95=${p95}ms` : ''} — LLM`,
    activeSessions,
    threshold: config.threshold,
    maxLatencyMs,
    p95LatencyMs: p95,
    gpuState: highestState,
    enabled: true,
    activeTiers: 0,
    bootingTiers: 0,
    totalTiers,
  };
}
