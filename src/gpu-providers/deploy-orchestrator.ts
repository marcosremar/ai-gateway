/**
 * GPU Deploy Orchestrator — reusable utilities for tiered GPU deployment.
 *
 * Extracted from gateway-server.ts to keep generic GPU orchestration logic
 * in ai-gateway. The gateway-server.ts imports these and wires them to HTTP endpoints.
 */

import type { GpuProviderClient, ProviderCredentials } from './types';

// ── Provider Name & Tier ────────────────────────────────────────────────────

export type ProviderName = 'runpod' | 'vast' | 'tensordock' | 'modal';

export interface GpuTier {
  client: GpuProviderClient;
  name: ProviderName;
  label: string;
  apiKey: string;
  authId?: string;
}

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  runpod: 'RunPod',
  vast: 'Vast.ai',
  tensordock: 'TensorDock',
  modal: 'Modal',
};

// ── Provider Cooldown Tracker ───────────────────────────────────────────────

export interface CooldownInfo {
  until: number;
  remainSec: number;
  failCount: number;
}

export class ProviderCooldownTracker {
  private cooldowns = new Map<string, { failedAt: number; cooldownUntilMs: number; failCount: number }>();

  constructor(
    private baseCooldownMs = 5 * 60_000,
    private maxCooldownMs = 15 * 60_000,
  ) {}

  isCoolingDown(name: string): boolean {
    const cd = this.cooldowns.get(name);
    if (!cd) return false;
    if (Date.now() >= cd.cooldownUntilMs) {
      this.cooldowns.delete(name);
      return false;
    }
    return true;
  }

  getRemainingSeconds(name: string): number {
    const cd = this.cooldowns.get(name);
    if (!cd) return 0;
    return Math.max(0, Math.round((cd.cooldownUntilMs - Date.now()) / 1000));
  }

  getFailCount(name: string): number {
    return this.cooldowns.get(name)?.failCount ?? 0;
  }

  recordFailure(name: string): void {
    const existing = this.cooldowns.get(name);
    const failCount = (existing?.failCount ?? 0) + 1;
    const cooldownMs = Math.min(this.baseCooldownMs * Math.pow(2, failCount - 1), this.maxCooldownMs);
    this.cooldowns.set(name, {
      failedAt: Date.now(),
      cooldownUntilMs: Date.now() + cooldownMs,
      failCount,
    });
  }

  recordSuccess(name: string): boolean {
    const had = this.cooldowns.has(name);
    this.cooldowns.delete(name);
    return had;
  }

  /** Get all active cooldowns for status reporting. */
  getActiveCooldowns(): Record<string, CooldownInfo> {
    const result: Record<string, CooldownInfo> = {};
    for (const [name, cd] of this.cooldowns) {
      if (Date.now() < cd.cooldownUntilMs) {
        result[name] = {
          until: cd.cooldownUntilMs,
          remainSec: Math.round((cd.cooldownUntilMs - Date.now()) / 1000),
          failCount: cd.failCount,
        };
      }
    }
    return result;
  }

  /** Select the least-cooled-down provider when all are in cooldown. */
  pickEarliestExpiry(names: string[]): string | null {
    let earliest: string | null = null;
    let earliestMs = Infinity;
    for (const name of names) {
      const cd = this.cooldowns.get(name);
      if (cd && cd.cooldownUntilMs < earliestMs) {
        earliestMs = cd.cooldownUntilMs;
        earliest = name;
      }
    }
    return earliest;
  }
}

// ── Generic Instance Cleanup ────────────────────────────────────────────────

/**
 * List all instances from a provider and delete those matching the active status filter.
 * Used to clean up orphaned instances across all providers.
 */
export async function cleanupProviderInstances(
  client: GpuProviderClient,
  credentials: ProviderCredentials,
  activeStatuses: string[],
  label: string,
  log: (msg: string) => void = console.log,
  warn: (msg: string) => void = console.warn,
): Promise<void> {
  try {
    const instances = await client.listInstances(credentials);
    const statusSet = new Set(activeStatuses.map(s => s.toLowerCase()));
    const active = instances.filter(i =>
      statusSet.has(i.status?.toLowerCase() ?? '')
    );
    if (active.length === 0) return;
    log(`[gpu] Cleaning up ${active.length} ${label} instance(s)...`);
    await Promise.allSettled(
      active.map(async (inst) => {
        try {
          await client.deleteInstance(inst.instanceId, credentials);
          log(`[gpu] Terminated ${label} instance ${inst.instanceId}`);
        } catch (err) {
          warn(`[gpu] Failed to terminate ${label} instance ${inst.instanceId}: ${err}`);
        }
      })
    );
  } catch (err) {
    warn(`[gpu] Failed to list ${label} instances for cleanup: ${err}`);
  }
}

// ── Default Storage per Provider ────────────────────────────────────────────

export const DEFAULT_STORAGE_GB: Record<ProviderName, number> = {
  runpod: 50,
  tensordock: 100,
  vast: 0,
  modal: 0,
};
