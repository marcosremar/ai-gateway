/**
 * Error Summary — tracks deploy errors and provides real-time summaries.
 */

import { DeployError, ErrorSummary, summarizeErrors, ErrorCategory } from '../errors/deploy-errors';
import { createLogger } from '../logger';

const log = createLogger('error-summary');

export interface ErrorAlert {
  /** Alert type */
  type: 'high_error_rate' | 'critical_error_spike' | 'new_error_pattern';
  /** Alert severity */
  severity: 'warning' | 'critical';
  /** What triggered the alert */
  message: string;
  /** Current error rate or count */
  currentValue: number;
  /** Threshold that was exceeded */
  threshold: number;
  /** When the alert was triggered */
  triggeredAt: string;
  /** Whether the alert has been acknowledged */
  acknowledged?: boolean;
}

interface ErrorEntry {
  error: DeployError;
  timestamp: string;
  /** Epoch ms of `timestamp`, cached so alert/summary filters avoid re-parsing
   *  the ISO string on every pass over up to 1000 entries (#586). */
  tsMs: number;
  deployId?: string;
}

class ErrorSummaryTracker {
  private errors: ErrorEntry[] = [];
  private maxEntries = 1000;
  private alerts: ErrorAlert[] = [];
  private lastAlertCheck = Date.now();
  private readonly ALERT_CHECK_INTERVAL_MS = 60_000; // Check every minute
  private readonly HIGH_ERROR_RATE_THRESHOLD = 0.10; // 10% error rate
  private readonly CRITICAL_SPIKE_THRESHOLD = 5; // 5 critical errors in 5 min
  /**
   * #587 — total-operation timestamps (epoch ms) so we can compute a TRUE error
   * RATE (errors ÷ operations) in the 5-min window rather than a raw error count.
   * A bounded ring; only populated when callers wire recordOperation(). Without
   * it, the alert falls back to the absolute-volume threshold.
   */
  private operationTsMs: number[] = [];
  private readonly maxOperations = 5000;
  /** Minimum operations in the window before a RATE-based alert is trusted. */
  private readonly MIN_OPS_FOR_RATE = 20;

  /**
   * #587 — record that an operation occurred (success OR failure). Lets the
   * high-error alert use a real rate. Fire this on every request/deploy attempt.
   */
  recordOperation(): void {
    const now = Date.now();
    this.operationTsMs.push(now);
    if (this.operationTsMs.length > this.maxOperations) this.operationTsMs.shift();
  }

  /** Record a deploy error */
  record(err: unknown, deployId?: string): DeployError | null {
    if (err instanceof DeployError) {
      const now = Date.now();
      const entry: ErrorEntry = { error: err, timestamp: new Date(now).toISOString(), tsMs: now, deployId };
      this.errors.push(entry);
      if (this.errors.length > this.maxEntries) {
        this.errors.shift();
      }

      if (err.severity === 'critical') {
        log.error({ code: err.code, category: err.category, deployId }, err.message);
      }
      return err;
    }
    return null;
  }

  /** Get summary for last N hours */
  getSummary(hours: number = 24): ErrorSummary & { period: string; alerts: ErrorAlert[] } {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    const recent = this.errors
      .filter(e => (e.tsMs ?? Date.parse(e.timestamp)) > cutoff)
      .map(e => e.error);

    const summary = summarizeErrors(recent);
    const alerts = this.checkAlerts();

    return {
      ...summary,
      period: `Last ${hours}h`,
      alerts,
    };
  }

  /** Get errors by category */
  getByCategory(category: ErrorCategory): DeployError[] {
    return this.errors
      .filter(e => e.error.category === category)
      .map(e => e.error);
  }

  /** Get most frequent errors */
  getTopErrors(limit: number = 10): Array<{ code: string; count: number; message: string; category: string }> {
    const summary = this.getSummary(24);
    return summary.topErrors.slice(0, limit).map(e => ({
      code: e.code,
      count: e.count,
      message: e.message,
      category: 'unknown',
    }));
  }

  /**
   * Check for alert conditions and generate alerts.
   */
  private checkAlerts(): ErrorAlert[] {
    const now = Date.now();
    if (now - this.lastAlertCheck < this.ALERT_CHECK_INTERVAL_MS) {
      return this.alerts.filter(a => !a.acknowledged);
    }
    this.lastAlertCheck = now;

    const newAlerts: ErrorAlert[] = [];

    // Check 1: High error rate in last 5 minutes.
    // #587 — When total operations are tracked (recordOperation), compute a TRUE
    // rate (errors ÷ ops) so 50/60 (catastrophic) is distinguished from 50/50000
    // (noise). The previous raw-count threshold couldn't tell them apart. Falls
    // back to the absolute-volume threshold when no operations are recorded.
    const windowStart = now - 5 * 60 * 1000;
    const recentErrors = this.errors.filter(e =>
      (e.tsMs ?? Date.parse(e.timestamp)) > windowStart
    );
    const recentOps = this.operationTsMs.filter(ts => ts > windowStart).length;
    const HIGH_ERROR_VOLUME_5MIN = 50;

    if (recentOps >= this.MIN_OPS_FOR_RATE) {
      const rate = recentErrors.length / recentOps;
      if (rate >= this.HIGH_ERROR_RATE_THRESHOLD) {
        newAlerts.push({
          type: 'high_error_rate',
          severity: rate >= this.HIGH_ERROR_RATE_THRESHOLD * 5 ? 'critical' : 'warning',
          message: `Error rate ${(rate * 100).toFixed(1)}% over last 5 minutes (${recentErrors.length}/${recentOps}, threshold ${(this.HIGH_ERROR_RATE_THRESHOLD * 100).toFixed(0)}%)`,
          currentValue: Math.round(rate * 1000) / 1000,
          threshold: this.HIGH_ERROR_RATE_THRESHOLD,
          triggeredAt: new Date().toISOString(),
        });
      }
    } else if (recentErrors.length >= HIGH_ERROR_VOLUME_5MIN) {
      newAlerts.push({
        type: 'high_error_rate',
        severity: 'warning',
        message: `${recentErrors.length} errors in last 5 minutes (threshold: ${HIGH_ERROR_VOLUME_5MIN}; no op-count for rate)`,
        currentValue: recentErrors.length,
        threshold: HIGH_ERROR_VOLUME_5MIN,
        triggeredAt: new Date().toISOString(),
      });
    }

    // Check 2: Critical error spike (5+ critical errors in 5 min)
    const criticalErrors = this.errors.filter(e =>
      e.error.severity === 'critical' &&
      (e.tsMs ?? Date.parse(e.timestamp)) > now - 5 * 60 * 1000
    );

    if (criticalErrors.length >= this.CRITICAL_SPIKE_THRESHOLD) {
      newAlerts.push({
        type: 'critical_error_spike',
        severity: 'critical',
        message: `${criticalErrors.length} critical errors in last 5 minutes`,
        currentValue: criticalErrors.length,
        threshold: this.CRITICAL_SPIKE_THRESHOLD,
        triggeredAt: new Date().toISOString(),
      });
    }

    // Deduplicate alerts (don't create duplicate alerts for same condition within 1 hour)
    const oneHourAgo = now - 60 * 60 * 1000;
    const recentAlertTypes = new Set(
      this.alerts
        .filter(a => new Date(a.triggeredAt).getTime() > oneHourAgo)
        .map(a => a.type)
    );

    for (const alert of newAlerts) {
      if (!recentAlertTypes.has(alert.type)) {
        this.alerts.push(alert);
        log.error({ alertType: alert.type, message: alert.message }, 'Error alert triggered');
      }
    }

    return this.alerts.filter(a => !a.acknowledged);
  }

  /**
   * Get active alerts.
   */
  getAlerts(): ErrorAlert[] {
    this.checkAlerts();
    return this.alerts.filter(a => !a.acknowledged);
  }

  /** Force the next checkAlerts() to run (bypass the 60s throttle). Tests only. */
  _forceAlertCheck(): void {
    this.lastAlertCheck = 0;
  }

  /**
   * Acknowledge an alert.
   */
  acknowledgeAlert(alertType: ErrorAlert['type']): void {
    for (const alert of this.alerts) {
      if (alert.type === alertType && !alert.acknowledged) {
        alert.acknowledged = true;
      }
    }
  }

  /**
   * Clear all alerts.
   */
  clearAlerts(): void {
    this.alerts = [];
  }

  /** Clear all tracked errors */
  clear(): void {
    this.errors = [];
    this.operationTsMs = [];
  }

  /** Current count */
  get count(): number {
    return this.errors.length;
  }
}

export const errorSummary = new ErrorSummaryTracker();
