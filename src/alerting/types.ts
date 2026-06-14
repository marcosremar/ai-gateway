/**
 * Alerting types.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertPayload {
  severity: AlertSeverity;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface AlertChannel {
  readonly name: string;
  send(payload: AlertPayload): Promise<void>;
}

export interface AlertRouterOptions {
  /** Dedup window — identical alerts within this window are suppressed. Default 60_000ms */
  dedupeWindowMs?: number;
  /** Rate limit — max alerts per window. Default { max: 10, windowMs: 60_000 } */
  rateLimit?: { max: number; windowMs: number };
  /** Extra send attempts after the first on channel failure. Default 1. */
  retries?: number;
  /** Backoff between retries in ms. Default 200. Set 0 for immediate (tests). */
  retryDelayMs?: number;
}
