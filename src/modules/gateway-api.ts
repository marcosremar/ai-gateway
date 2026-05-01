/**
 * Gateway — unified facade returned by createGateway().
 *
 * Routes call handleGet/handleAction directly instead of constructing
 * HandlerDeps manually. All internal wiring is hidden.
 */

import type { Autoscaler } from './factory';
import type { GpuProviderRegistry } from './gpu-providers/registry';
import type { HandlerResult } from './handlers/types';
import type { AutoScalerConfig, AutoScaleDecision, GpuTierState } from './types';
import type { GpuTokenPayload } from './auth/gpu-token';
import type { HealthResult, ProtoResult } from './benchmarking/bench';

export interface Gateway {
  // ── Route Handlers ──────────────────────────────────────────────────────────

  /** GET /api/gpu-autoscaler — dashboard card data. */
  handleGet(
    userId: string,
    opts?: { readOwnConfig?: () => Promise<Record<string, unknown> | undefined> },
  ): Promise<HandlerResult>;

  /** POST /api/gpu-autoscaler — all actions (save-config, pool-status, etc.). */
  handleAction(
    userId: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<HandlerResult>;

  /** List Modal apps via Basic auth. */
  handleModalApps(tokenId: string, tokenSecret: string): Promise<HandlerResult>;

  /** Stop a Modal app by appId. */
  handleModalStop(appId: string, tokenId: string, tokenSecret: string): Promise<HandlerResult>;

  // ── Autoscaler convenience ──────────────────────────────────────────────────

  /** Get autoscale decision (auto-loads config). */
  getDecision(userId: string, opts?: { dryRun?: boolean }): Promise<AutoScaleDecision | null>;

  /** Report a session heartbeat. */
  reportSession(userId: string, sessionKey: string): Promise<void>;

  /** Remove a session heartbeat. */
  removeSession(userId: string, sessionKey: string): Promise<void>;

  /** Report observed latency. */
  reportLatency(userId: string, totalMs: number): Promise<void>;

  /** Get latency stats for a user. */
  getLatencyStats(userId: string, maxLatencyMs?: number): Promise<{ p95: number | null; samples: number[]; breaches: number }>;

  /** Get pool status (all tier states). */
  getPoolStatus(userId: string): GpuTierState[];

  /** Get ready GPU endpoints. */
  getReadyEndpoints(userId: string): string[];

  /** Load autoscaler config for a user. */
  loadConfig(userId: string): Promise<AutoScalerConfig | null>;

  /** Schedule background reconcile. */
  scheduleReconcile(userId: string): void;

  /** Schedule background watchdog. */
  scheduleWatchdog(userId: string, config: AutoScalerConfig): void;

  /** Run a full watchdog cycle. */
  runWatchdogCycle(): Promise<void>;

  /** Reset GPU state for a user. */
  resetGpuState(userId: string): void;

  /** Trigger GPU boot on a specific tier. */
  triggerGpuBoot(
    tierConfig: import('./types').GpuTierConfig,
    tierIndex: number,
    userId: string,
  ): Promise<{ ok: boolean; activeGpuType?: string; reason?: string }>;

  /** Force a tier to ready state. */
  forceTierReady(userId: string, tierIndex: number, endpoint: string): void;

  /** Init tier states from DB. */
  initTierStatesFromDb(userId: string, tiers: import('./types').GpuTierConfig[]): Promise<GpuTierState[]>;

  // ── Utilities ───────────────────────────────────────────────────────────────

  /** Sign a short-lived HMAC token for GPU access. Returns undefined if GPU_ACCESS_SECRET is not set. */
  signGpuToken(userId: string): string | undefined;

  /** Verify and decode a GPU access token. */
  verifyGpuToken(token: string): GpuTokenPayload;

  /** Probe a GPU endpoint's /health. */
  runHealthCheck(endpoint: string): Promise<HealthResult>;

  /** Run SSE benchmark against a GPU endpoint. */
  runSSEBench(endpoint: string, testWav?: Buffer): Promise<ProtoResult>;

  // ── Background tickers ──────────────────────────────────────────────────────

  /** Start the watchdog background ticker. Returns a stop function. */
  startWatchdog(intervalMs?: number): () => void;

  /** Start the cost monitor background ticker. Returns a stop function. */
  startCostMonitor(intervalMs?: number): () => void;

  // ── Internals (advanced) ────────────────────────────────────────────────────

  /** The underlying Autoscaler instance. */
  readonly autoscaler: Autoscaler;

  /** The GPU provider registry. */
  readonly registry: GpuProviderRegistry;

  /** Destroy the gateway and stop all background tasks. */
  destroy(): void;
}
