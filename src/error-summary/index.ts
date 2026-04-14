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

  /** Record a deploy error */
  record(err: unknown, deployId?: string): DeployError | null {
    if (err instanceof DeployError) {
      const entry: ErrorEntry = { error: err, timestamp: new Date().toISOString(), deployId };
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
      .filter(e => new Date(e.timestamp).getTime() > cutoff)
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

    // Check 1: High error rate (>10% in last 5 minutes)
    const recentErrors = this.errors.filter(e =>
      new Date(e.timestamp).getTime() > now - 5 * 60 * 1000
    );
    const recentTotal = this.errors.filter(e =>
      new Date(e.timestamp).getTime() > now - 5 * 60 * 1000
    ).length;

    if (recentTotal > 10) { // Need at least 10 operations to calculate rate
      const errorRate = recentErrors.length / recentTotal;
      if (errorRate > this.HIGH_ERROR_RATE_THRESHOLD) {
        newAlerts.push({
          type: 'high_error_rate',
          severity: 'warning',
          message: `Error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(this.HIGH_ERROR_RATE_THRESHOLD * 100).toFixed(0)}% threshold`,
          currentValue: errorRate,
          threshold: this.HIGH_ERROR_RATE_THRESHOLD,
          triggeredAt: new Date().toISOString(),
        });
      }
    }

    // Check 2: Critical error spike (5+ critical errors in 5 min)
    const criticalErrors = this.errors.filter(e =>
      e.error.severity === 'critical' &&
      new Date(e.timestamp).getTime() > now - 5 * 60 * 1000
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
  }

  /** Current count */
  get count(): number {
    return this.errors.length;
  }
}

export const errorSummary = new ErrorSummaryTracker();
