/**
 * Client-side health of the gateway ITSELF, used only to decide the direct fallback (the gateway owns the provider
 * breakers). After `threshold` consecutive gateway-unreachable failures the gateway is skipped for `cooldownMs`; once
 * the cooldown is over, the next call starts a background `GET /health` probe (and still goes direct): the breaker
 * closes as soon as the gateway answers, or opens for another cooldown.
 */

import type { GatewayRoute, GatewayState, RouteChange } from './gateway-types';

interface GatewayBreakerOptions {
  threshold: number;
  cooldownMs: number;
  now: () => number;
  /** Resolves true when the gateway answered its health check. */
  probe: () => Promise<boolean>;
  onRouteChange?: (change: RouteChange) => void;
}

/** `recheck` probes at most this often (a failed probe stands for that long). */
const RECHECK_MIN_GAP_MS = 1_000;

export class GatewayBreaker {
  private failures = 0;
  private openUntil: number | null = null;
  private probing: Promise<void> | null = null;
  private lastError: string | null = null;
  private route: GatewayRoute = 'gateway';
  private lastProbeFailedAt = -Infinity;

  constructor(private readonly opts: GatewayBreakerOptions) {}

  /** True while the gateway should not be called (open, or its probe still running). */
  skipGateway(): boolean {
    if (this.openUntil === null) return false;
    if (this.probing) return true;
    if (this.opts.now() < this.openUntil) return true;
    this.probing = this.runProbe();
    return true;
  }

  /**
   * Probes the gateway NOW, whatever the cooldown (joining a probe in flight); true once it answered (breaker closed).
   * For calls the direct route cannot serve: skipping the gateway would only fail them, so they check it first.
   */
  async recheck(): Promise<boolean> {
    if (this.openUntil === null) return true;
    // A probe that failed just now answers for the next second: a hung gateway (probe = 3 s timeout) must not make every
    // call wait for its own probe.
    if (!this.probing && this.opts.now() - this.lastProbeFailedAt < RECHECK_MIN_GAP_MS) return false;
    this.probing ??= this.runProbe();
    await this.probing;
    return this.openUntil === null;
  }

  /** The in-flight probe, if any (tests, and callers that want to wait for recovery). */
  get probe(): Promise<void> | null { return this.probing; }

  success(): void {
    this.failures = 0;
    this.openUntil = null;
    this.lastError = null;
  }

  failure(reason: string): void {
    this.failures++;
    this.lastError = reason;
    if (this.failures >= this.opts.threshold) this.openUntil = this.opts.now() + this.opts.cooldownMs;
  }

  /** Records which route a direct-capable call used; reports a change. */
  used(route: GatewayRoute, reason: string): void {
    if (route === this.route) return;
    this.route = route;
    try { this.opts.onRouteChange?.({ route, reason }); } catch { /* the app's callback must not break the call */ }
  }

  state(planLoaded: boolean): GatewayState {
    return {
      breaker: this.probing ? 'probing' : this.openUntil !== null ? 'open' : 'closed',
      route: this.route,
      consecutiveFailures: this.failures,
      openUntil: this.openUntil,
      lastError: this.lastError,
      planLoaded,
    };
  }

  private async runProbe(): Promise<void> {
    let ok = false;
    try { ok = await this.opts.probe(); } catch { ok = false; }
    this.probing = null;
    if (ok) this.success();
    else {
      this.openUntil = this.opts.now() + this.opts.cooldownMs;
      this.lastProbeFailedAt = this.opts.now();
    }
  }
}
