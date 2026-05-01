/**
 * Request Logger — structured request/response logging with timing.
 *
 * Fixes: #726-732 (test helpers for logging, metrics, tracing)
 *
 * Usage:
 * ```ts
 * import { requestLogger } from './request-logger';
 *
 * // Log a request
 * requestLogger.log({
 *   method: 'POST',
 *   path: '/v1/chat/completions',
 *   requestId: 'abc-123',
 *   userId: 'user-456',
 * });
 *
 * // Log a response
 * requestLogger.logResponse({
 *   requestId: 'abc-123',
 *   statusCode: 200,
 *   durationMs: 234,
 * });
 *
 * // Get recent requests
 * const recent = requestLogger.getRecent(50);
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('request-logger');

export interface RequestEntry {
  requestId: string;
  method: string;
  path: string;
  userId?: string;
  timestamp: string;
  statusCode?: number;
  durationMs?: number;
  providerId?: string;
  model?: string;
  error?: string;
}

class RequestLogger {
  private entries: RequestEntry[] = [];
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Log a request.
   */
  log(entry: Omit<RequestEntry, 'timestamp'>): void {
    const fullEntry: RequestEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(fullEntry);

    // Evict oldest if at capacity
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }

    log.debug(fullEntry, 'Request logged');
  }

  /**
   * Log a response — updates existing request entry.
   */
  logResponse(entry: {
    requestId: string;
    statusCode: number;
    durationMs: number;
    error?: string;
  }): void {
    const existing = this.entries.find((e) => e.requestId === entry.requestId);
    if (existing) {
      existing.statusCode = entry.statusCode;
      existing.durationMs = entry.durationMs;
      if (entry.error) existing.error = entry.error;
    }
  }

  /**
   * Get recent requests.
   */
  getRecent(limit = 50, filter?: { userId?: string; providerId?: string; errorOnly?: boolean }): RequestEntry[] {
    let entries = [...this.entries];

    if (filter?.userId) {
      entries = entries.filter((e) => e.userId === filter.userId);
    }
    if (filter?.providerId) {
      entries = entries.filter((e) => e.providerId === filter.providerId);
    }
    if (filter?.errorOnly) {
      entries = entries.filter((e) => e.error || (e.statusCode ?? 0) >= 400);
    }

    return entries.slice(-limit).reverse();
  }

  /**
   * Get request by ID.
   */
  getById(requestId: string): RequestEntry | undefined {
    return this.entries.find((e) => e.requestId === requestId);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    total: number;
    errorCount: number;
    avgDurationMs: number;
    requestsPerMinute: number;
  } {
    const errors = this.entries.filter((e) => e.error || (e.statusCode ?? 0) >= 400);
    const entriesWithDuration = this.entries.filter((e) => e.durationMs != null);
    const avgDuration =
      entriesWithDuration.length > 0
        ? entriesWithDuration.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / entriesWithDuration.length
        : 0;

    // Calculate requests per minute (based on last minute of entries)
    const oneMinuteAgo = Date.now() - 60_000;
    const recentCount = this.entries.filter((e) => new Date(e.timestamp).getTime() > oneMinuteAgo).length;

    return {
      total: this.entries.length,
      errorCount: errors.length,
      avgDurationMs: Math.round(avgDuration),
      requestsPerMinute: recentCount,
    };
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Current size.
   */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * Global request logger instance.
 */
export const requestLogger = new RequestLogger();
