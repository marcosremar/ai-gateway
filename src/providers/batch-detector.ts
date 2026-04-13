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

/** Sliding window of recent STT requests */
const recentSttRequests: STTRequestEntry[] = [];

/** Total number of detected batching opportunities (for monitoring) */
let batchOpportunities = 0;

/**
 * Record an incoming STT request and check for batching opportunities.
 * Call this at the start of every STT transcription request.
 *
 * @param language - The language code of the transcription request (e.g. 'fr', 'en')
 */
export function recordSttRequest(language: string): void {
  const now = Date.now();

  // Prune entries older than the batch window
  while (recentSttRequests.length > 0 && now - recentSttRequests[0].timestamp > BATCH_WINDOW_MS) {
    recentSttRequests.shift();
  }

  recentSttRequests.push({ language, timestamp: now });

  // Count how many requests share this language within the window
  const sameLang = recentSttRequests.filter((r) => r.language === language);

  if (sameLang.length >= BATCH_THRESHOLD) {
    batchOpportunities++;
    console.log(
      `[batch] ${sameLang.length} STT requests for language=${language} within ${BATCH_WINDOW_MS}ms — batching opportunity`,
    );
  }
}

/** Get the total number of detected batch opportunities (for monitoring/health endpoints) */
export function getBatchOpportunityCount(): number {
  return batchOpportunities;
}

/** Reset counters (for testing) */
export function resetBatchDetector(): void {
  recentSttRequests.length = 0;
  batchOpportunities = 0;
}
