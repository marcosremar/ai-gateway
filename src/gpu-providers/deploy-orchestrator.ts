/**
 * GPU Deploy Orchestrator — reusable utilities for tiered GPU deployment.
 *
 * Extracted from gateway-server.ts to keep generic GPU orchestration logic
 * in ai-gateway. The gateway-server.ts imports these and wires them to HTTP endpoints.
 */

import fs from 'fs';
import path from 'path';
import type { GpuProviderClient, ProviderCredentials } from './types';

// ── Provider Name & Tier ────────────────────────────────────────────────────

export type ProviderName = 'runpod' | 'vast' | 'tensordock' | 'modal' | 'snapgpu';

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
  snapgpu: 'SnapGPU',
};

// ── Provider Cooldown Tracker ───────────────────────────────────────────────

export interface CooldownInfo {
  until: number;
  remainSec: number;
  failCount: number;
}

export interface CooldownEntry {
  failedAt: number;
  cooldownUntilMs: number;
  failCount: number;
}

export class ProviderCooldownTracker {
  private cooldowns = new Map<string, CooldownEntry>();
  private persistPath: string | null = null;

  /** Maximum cooldown duration — caps exponential backoff and billing cooldowns. */
  static readonly MAX_COOLDOWN_MS = 15 * 60_000; // 15 min hard cap

  /** Auto-blacklist: if a provider has N+ failures in WINDOW_MS, extend cooldown to BLACKLIST_MS. */
  private static readonly AUTO_BLACKLIST_THRESHOLD = 5;
  private static readonly AUTO_BLACKLIST_WINDOW_MS = 60 * 60_000; // 1 hour
  private static readonly AUTO_BLACKLIST_DURATION_MS = 60 * 60_000; // 1 hour blacklist

  /** Rolling failure history per provider — timestamps of recent failures. */
  private failureHistory = new Map<string, number[]>();

  constructor(
    private baseCooldownMs = 60_000,       // 1 min base (was 5 min — too slow for retries)
    private maxCooldownMs = ProviderCooldownTracker.MAX_COOLDOWN_MS,
  ) {}

  /** Load persisted cooldowns from a JSON file. Ignores expired entries. */
  loadFromFile(filePath: string): void {
    this.persistPath = filePath;
    try {
      if (!fs.existsSync(filePath)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, CooldownEntry>;
      const now = Date.now();
      for (const [name, cd] of Object.entries(data)) {
        if (cd.cooldownUntilMs > now) {
          this.cooldowns.set(name, cd);
        }
      }
    } catch { /* ignore corrupt/missing file */ }
  }

  /** Persist current cooldowns to the configured file. */
  private persist(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const obj: Record<string, CooldownEntry> = {};
      for (const [name, cd] of this.cooldowns) {
        obj[name] = cd;
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(obj, null, 2));
    } catch { /* best-effort */ }
  }

  isCoolingDown(name: string): boolean {
    const cd = this.cooldowns.get(name);
    if (!cd) return false;
    if (Date.now() >= cd.cooldownUntilMs) {
      // Keep failCount so next failure escalates, just mark as no longer cooling
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
    const now = Date.now();
    const existing = this.cooldowns.get(name);
    const failCount = (existing?.failCount ?? 0) + 1;

    // Track rolling failure history for auto-blacklist detection
    const history = this.failureHistory.get(name) ?? [];
    history.push(now);
    // Prune entries older than the blacklist window
    const windowStart = now - ProviderCooldownTracker.AUTO_BLACKLIST_WINDOW_MS;
    const recent = history.filter(ts => ts >= windowStart);
    this.failureHistory.set(name, recent);

    // Check auto-blacklist: if N+ failures in the window, extend cooldown significantly
    let cooldownMs: number;
    if (recent.length >= ProviderCooldownTracker.AUTO_BLACKLIST_THRESHOLD) {
      cooldownMs = ProviderCooldownTracker.AUTO_BLACKLIST_DURATION_MS;
      console.warn(
        `[cooldown] Auto-blacklisting provider '${name}' for ${Math.round(cooldownMs / 60_000)}min ` +
        `(${recent.length} failures in the last ${Math.round(ProviderCooldownTracker.AUTO_BLACKLIST_WINDOW_MS / 60_000)}min)`
      );
    } else {
      cooldownMs = Math.min(this.baseCooldownMs * Math.pow(2, failCount - 1), this.maxCooldownMs);
    }

    this.cooldowns.set(name, {
      failedAt: now,
      cooldownUntilMs: now + cooldownMs,
      failCount,
    });
    this.persist();
  }

  /** Record a billing/balance failure — longer cooldown, capped at MAX_COOLDOWN_MS. */
  recordBillingFailure(name: string): void {
    const BILLING_COOLDOWN_MS = Math.min(60 * 60_000, this.maxCooldownMs); // 1h desired, capped
    const existing = this.cooldowns.get(name);
    const failCount = (existing?.failCount ?? 0) + 1;
    this.cooldowns.set(name, {
      failedAt: Date.now(),
      cooldownUntilMs: Date.now() + BILLING_COOLDOWN_MS,
      failCount,
    });
    this.persist();
  }

  recordSuccess(name: string): boolean {
    const had = this.cooldowns.has(name);
    this.cooldowns.delete(name);
    this.failureHistory.delete(name); // Clear rolling failure history on success
    if (had) this.persist();
    return had;
  }

  /** Check if a provider is auto-blacklisted (5+ failures in the last hour). */
  isBlacklisted(name: string): boolean {
    const now = Date.now();
    const history = this.failureHistory.get(name);
    if (!history) return false;
    const windowStart = now - ProviderCooldownTracker.AUTO_BLACKLIST_WINDOW_MS;
    const recent = history.filter(ts => ts >= windowStart);
    return recent.length >= ProviderCooldownTracker.AUTO_BLACKLIST_THRESHOLD;
  }

  /** Get rolling failure count in the blacklist window for a provider. */
  getRecentFailureCount(name: string): number {
    const now = Date.now();
    const history = this.failureHistory.get(name);
    if (!history) return 0;
    const windowStart = now - ProviderCooldownTracker.AUTO_BLACKLIST_WINDOW_MS;
    return history.filter(ts => ts >= windowStart).length;
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

// ── Tier Filtering ──────────────────────────────────────────────────────────

/**
 * Filter tiers to a specific provider (optional).
 * If `forceProvider` is set, returns only that tier.
 * If the forced provider isn't in the list, returns `{ error: '...' }`.
 * Otherwise returns the full tier list unchanged.
 */
export function filterTiers(
  tiers: GpuTier[],
  forceProvider?: ProviderName,
): { tiers: GpuTier[] } | { error: string } {
  if (!forceProvider) return { tiers };
  const forced = tiers.find(t => t.name === forceProvider);
  if (!forced) {
    return { error: `Provider '${forceProvider}' not available. Available: ${tiers.map(t => t.name).join(', ')}` };
  }
  return { tiers: [forced] };
}

// ── Default Storage per Provider ────────────────────────────────────────────
// Keep RunPod storage low to avoid ghost machines — most Secure Cloud hosts
// don't have >100GB local disk. Vast.ai has much more disk availability.
//
// For large models (32B+) that download at runtime (vLLM, TGI, etc.),
// callers MUST set storageGb explicitly in the deploy request:
//   - 7B model: ~50GB (image + model + buffer)
//   - 13B model: ~80GB
//   - 32B model: ~120GB
//   - 70B model: ~200GB
export const DEFAULT_STORAGE_GB: Record<ProviderName, number> = {
  runpod: 20,      // RunPod default is 20GB; 100GB causes ghost machines
  tensordock: 50,
  vast: 100,       // 100GB: covers most pre-baked images + medium models
  modal: 0,
  // Snapgpu inherits the storage of its underlying backend at runtime; this
  // value only matters when the wrapper is used directly without a backend
  // hint, in which case 30GB matches the Vast.ai default.
  snapgpu: 30,
};
