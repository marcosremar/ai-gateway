/**
 * Cost watcher — emits alerts when daily GPU spend crosses 50% or 80% of
 * the cap. Sticky per threshold per day so alerts don't spam.
 *
 * Why this exists: `docs/insights/2026-04-12-first-pass.md` finding #4
 * showed a $130 spend day with no alarm until the hard cap kicked in.
 * A soft alert at $25 (50% of $50 cap) would have given a chance to
 * intervene before the loop damaged the account.
 *
 * This module is framework-agnostic. The alert channels (Discord/Slack/
 * webhook) are passed in via `AlertRouter`. Tests inject a fake router.
 */

import type { AlertRouter } from './alert-router';
import type { AlertSeverity } from './types';

export interface CostWatcherOptions {
  /** The alert router that delivers to Discord/Slack/webhook channels. */
  router: AlertRouter;
  /** Daily cap in USD. 0 = no cap (alerts disabled). */
  cap: number;
  /** Thresholds as ratios of cap. Default: [0.5, 0.8]. */
  thresholds?: number[];
  /** Clock injection for tests. */
  now?: () => number;
  /** Called whenever an alert is emitted. Observability hook. */
  onEmit?: (e: CostAlertEvent) => void;
}

export interface CostAlertEvent {
  threshold: number;          // 0.5, 0.8, etc.
  spend: number;
  cap: number;
  severity: AlertSeverity;
  ts: number;
}

const DEFAULT_THRESHOLDS = [0.5, 0.8];

export class CostWatcher {
  private readonly router: AlertRouter;
  private readonly cap: number;
  private readonly thresholds: number[];
  private readonly now: () => number;
  private readonly onEmit?: (e: CostAlertEvent) => void;

  /** `${YYYY-MM-DD}:${threshold}` → true once the threshold fires that day. */
  private readonly firedToday = new Set<string>();
  private lastResetDate: string;

  constructor(opts: CostWatcherOptions) {
    this.router = opts.router;
    this.cap = opts.cap;
    this.thresholds = (opts.thresholds ?? DEFAULT_THRESHOLDS).slice().sort((a, b) => a - b);
    this.now = opts.now ?? (() => Date.now());
    this.onEmit = opts.onEmit;
    this.lastResetDate = this._today();
  }

  /**
   * Report a new current-spend value. Fires alerts for every threshold
   * that is newly crossed. Call this after each spend update (monitor
   * loop, manual top-up, etc.).
   *
   * Returns the set of threshold ratios that fired on this call.
   * Empty array = no new alert.
   */
  report(currentSpendUsd: number): number[] {
    if (this.cap <= 0) return [];

    // Day rollover — clear all fired flags so today's thresholds can fire again.
    const today = this._today();
    if (today !== this.lastResetDate) {
      this.firedToday.clear();
      this.lastResetDate = today;
    }

    const ratio = currentSpendUsd / this.cap;
    const fired: number[] = [];

    for (const t of this.thresholds) {
      if (ratio < t) continue;
      const key = `${today}:${t}`;
      if (this.firedToday.has(key)) continue;
      this.firedToday.add(key);
      fired.push(t);

      const severity: AlertSeverity = t >= 0.8 ? 'critical' : 'warning';
      const event: CostAlertEvent = {
        threshold: t,
        spend: currentSpendUsd,
        cap: this.cap,
        severity,
        ts: this.now(),
      };

      // Fire-and-forget: alert router owns retry / fallback channels.
      void this.router.route({
        severity,
        title: `GPU spend ${Math.round(t * 100)}% of daily cap`,
        message: `Current spend: $${currentSpendUsd.toFixed(2)} of $${this.cap.toFixed(2)} cap (${Math.round(ratio * 100)}%)`,
        timestamp: new Date(event.ts),
        metadata: {
          threshold: t,
          spend: currentSpendUsd,
          cap: this.cap,
          ratio,
        },
      });

      this.onEmit?.(event);
    }

    return fired;
  }

  /**
   * #548 — report spend by pulling the current value from a getter instead of
   * the caller passing it.
   *
   * The monitor loop owns the live daily-spend counter (`dailyGpuSpendUsd`) but
   * historically emitted its OWN `budget.*` events with duplicated threshold
   * logic, so `CostWatcher.report()` was never actually fed and its alert-router
   * path never fired. Wiring `setDailyGpuSpendUsd` → this getter means the
   * thresholds live in ONE place (here) and the router channels (Slack/Discord/
   * webhook) actually deliver.
   *
   * Returns the thresholds that fired on this call (empty = none). Reads the
   * getter defensively: a throwing/invalid source never breaks the spend path.
   */
  reportFrom(getSpendUsd: () => number): number[] {
    let spend: number;
    try {
      spend = getSpendUsd();
    } catch {
      return [];
    }
    if (!Number.isFinite(spend) || spend < 0) return [];
    return this.report(spend);
  }

  /** Force-reset the fired-today set. Tests only. */
  _resetFiredToday(): void {
    this.firedToday.clear();
  }

  /** Observability: report which thresholds have fired today. */
  firedThresholds(): number[] {
    const today = this._today();
    return this.thresholds.filter(t => this.firedToday.has(`${today}:${t}`));
  }

  private _today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
}
