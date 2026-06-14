/**
 * STT Request Batch Opportunity Detector
 *
 * Tracks incoming STT requests and detects when multiple identical-language
 * transcription requests arrive within a short window. This is a detection-only
 * module -- it logs batching opportunities but does not actually batch requests.
 *
 * Future: when a provider supports batch transcription, this detector can
 * trigger actual batching instead of just logging.
 */

interface STTRequestEntry {
  language: string;
  timestamp: number;
}

const BATCH_WINDOW_MS = 200;
const BATCH_THRESHOLD = 3;
/** Hard cap on retained entries per tenant so a burst can't grow unbounded. */
const MAX_WINDOW_ENTRIES = 256;

/**
 * Per-tenant batch detector. Keying by tenant prevents cross-tenant leakage —
 * a single module-global array mixed all users' requests so one tenant's
 * traffic inflated another's batch counts (#387). The recent-request window is
 * also bounded to MAX_WINDOW_ENTRIES per tenant.
 */
export class BatchDetector {
  /** tenant → sliding window of recent STT requests */
  private readonly windows = new Map<string, STTRequestEntry[]>();
  /** tenant → detected batching opportunities */
  private readonly opportunities = new Map<string, number>();

  /**
   * Record an incoming STT request for a tenant and check for batching
   * opportunities. Returns the count of same-language requests in the window.
   */
  record(language: string, tenant = 'default'): number {
    const now = Date.now();
    let window = this.windows.get(tenant);
    if (!window) {
      window = [];
      this.windows.set(tenant, window);
    }

    // Prune entries older than the batch window
    while (window.length > 0 && now - window[0].timestamp > BATCH_WINDOW_MS) {
      window.shift();
    }

    window.push({ language, timestamp: now });

    // Bound the window — a tight burst within BATCH_WINDOW_MS could otherwise
    // accumulate without limit.
    if (window.length > MAX_WINDOW_ENTRIES) {
      window.splice(0, window.length - MAX_WINDOW_ENTRIES);
    }

    const sameLang = window.reduce((n, r) => (r.language === language ? n + 1 : n), 0);

    if (sameLang >= BATCH_THRESHOLD) {
      this.opportunities.set(tenant, (this.opportunities.get(tenant) ?? 0) + 1);
    }

    return sameLang;
  }

  /** Detected batch opportunities for a tenant (or total across all). */
  getOpportunityCount(tenant?: string): number {
    if (tenant) return this.opportunities.get(tenant) ?? 0;
    let total = 0;
    for (const n of this.opportunities.values()) total += n;
    return total;
  }

  /** Reset all tenant state (for testing). */
  reset(): void {
    this.windows.clear();
    this.opportunities.clear();
  }
}

/** Default module-level singleton (backward-compatible function API). */
const defaultDetector = new BatchDetector();

/**
 * Record an incoming STT request and check for batching opportunities.
 * @param language - The language code of the transcription request.
 * @param tenant   - Optional tenant id to isolate windows (#387).
 */
export function recordSttRequest(language: string, tenant = 'default'): void {
  defaultDetector.record(language, tenant);
}

/** Get the total number of detected batch opportunities (for monitoring). */
export function getBatchOpportunityCount(tenant?: string): number {
  return defaultDetector.getOpportunityCount(tenant);
}

/** Reset counters (for testing). */
export function resetBatchDetector(): void {
  defaultDetector.reset();
}
