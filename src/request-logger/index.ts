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
  /** Epoch ms of `timestamp`, cached to avoid re-parsing on every stats call. */
  tsMs?: number;
}

class RequestLogger {
  private entries: RequestEntry[] = [];
  private maxSize: number;
  /**
   * requestId → entry index, so logResponse()/getById() are O(1) instead of an
   * O(n) `Array.find` per response on the hot path (#584). Each entry also
   * caches its epoch ms (`tsMs`) so getStats()'s RPM window doesn't re-parse
   * `new Date()` on every entry per call (#585).
   */
  private byId = new Map<string, RequestEntry>();

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Log a request.
   */
  log(entry: Omit<RequestEntry, 'timestamp'>): void {
    const now = Date.now();
    const fullEntry: RequestEntry = {
      ...entry,
      timestamp: new Date(now).toISOString(),
      tsMs: now,
    };

    this.entries.push(fullEntry);
    this.byId.set(fullEntry.requestId, fullEntry);

    // Evict oldest if at capacity
    if (this.entries.length > this.maxSize) {
      const evicted = this.entries.shift();
      // Only drop the index entry if it still points at the evicted object — a
      // requestId could have been reused with a newer entry.
      if (evicted && this.byId.get(evicted.requestId) === evicted) {
        this.byId.delete(evicted.requestId);
      }
    }

    log.debug(fullEntry, 'Request logged');
  }

  /**
   * Log a response — updates existing request entry (O(1) via id index).
   */
  logResponse(entry: {
    requestId: string;
    statusCode: number;
    durationMs: number;
    error?: string;
  }): void {
    const existing = this.byId.get(entry.requestId);
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
    return this.byId.get(requestId);
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

    // Calculate requests per minute (based on last minute of entries). Use the
    // cached `tsMs` epoch (falling back to a one-time parse for legacy entries)
    // instead of `new Date(e.timestamp)` per entry per call (#585).
    const oneMinuteAgo = Date.now() - 60_000;
    const recentCount = this.entries.filter(
      (e) => (e.tsMs ?? Date.parse(e.timestamp)) > oneMinuteAgo,
    ).length;

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
    this.byId.clear();
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
