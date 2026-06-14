/**
 * STT Hallucination Filter — metadata-based + blocklist filtering for Whisper output.
 *
 * Two complementary layers:
 *   1. Metadata filter: uses no_speech_prob, compression_ratio, avg_logprob from
 *      Whisper verbose_json to reject likely hallucinations at the signal level.
 *   2. Blocklist filter: uses the sachaarbonel/whisper-hallucinations dataset
 *      (7,770 known hallucination phrases across 100 languages) for exact-match filtering.
 *
 * Both layers are configurable via STTHallucinationFilterConfig.
 */

import type { STTResponse, STTSegment } from './providers/types';
import hallucinations from './data/whisper-hallucinations.json';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the STT hallucination filter.
 *
 * Controls both metadata-based signal filtering and blocklist-based
 * phrase filtering. Both layers can be toggled independently.
 */
export interface STTHallucinationFilterConfig {
  /** Maximum no_speech_prob before a segment is considered hallucinated. Default: 0.6 */
  noSpeechProbThreshold: number;
  /** Maximum compression_ratio before a segment is considered repetitive hallucination. Default: 2.4 */
  compressionRatioThreshold: number;
  /** Minimum avg_logprob — below this the model is too uncertain. Default: -0.8 */
  avgLogprobThreshold: number;
  /** Enable metadata-based filtering (requires verbose_json segments). Default: true */
  metadataFilterEnabled: boolean;
  /** Enable blocklist-based filtering. Default: true */
  blocklistFilterEnabled: boolean;
}

/**
 * Default configuration for the hallucination filter.
 *
 * Sensible thresholds based on Whisper's metadata signals. Override individual
 * fields to tune sensitivity for your use case.
 */
export const DEFAULT_HALLUCINATION_FILTER_CONFIG: STTHallucinationFilterConfig = {
  noSpeechProbThreshold: 0.6,
  compressionRatioThreshold: 2.4,
  avgLogprobThreshold: -0.8,
  metadataFilterEnabled: true,
  blocklistFilterEnabled: true,
};

// ---------------------------------------------------------------------------
// Blocklist (loaded once from JSON at module init)
// ---------------------------------------------------------------------------

const blocklistByLang: Map<string, Set<string>> = new Map();

// Build lookup sets from the imported JSON
for (const [lang, phrases] of Object.entries(hallucinations as Record<string, string[]>)) {
  blocklistByLang.set(lang, new Set(phrases));
}

// Language-agnostic set: union of all phrases (for when language is unknown).
// Built lazily on first language-unknown lookup — flattening 7,770 phrases
// across 100 languages into one Set at module load is pure waste when the
// language is (almost) always known on the live path.
let _blocklistAll: Set<string> | null = null;
function getBlocklistAll(): Set<string> {
  if (_blocklistAll) return _blocklistAll;
  const all = new Set<string>();
  for (const phrases of blocklistByLang.values()) {
    for (const p of phrases) all.add(p);
  }
  _blocklistAll = all;
  return all;
}

/**
 * Normalize a language code to the bare ISO 639-1 form used as the blocklist
 * key — callers may pass `en-US` / `EN` / `fr_FR`, which would otherwise miss.
 */
function normalizeLang(language?: string): string | undefined {
  if (!language) return undefined;
  const m = language.toLowerCase().match(/^[a-z]+/);
  return m ? m[0] : undefined;
}

/**
 * Normalize a candidate phrase for blocklist comparison: lower-case, collapse
 * whitespace, and strip leading/trailing punctuation. Whisper hallucinations
 * frequently arrive padded with trailing periods ("Thank you.") that defeat a
 * raw exact-match.
 */
function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?;:…"'`-]+|[\s.,!?;:…"'`-]+$/g, '')
    .trim();
}

/**
 * Collapse a doubled phrase ("thank you. thank you." → "thank you") so the
 * common repeated-hallucination pattern reduces to a single blocklist key.
 */
function dedupeRepeated(normalized: string): string {
  const parts = normalized.split(/[.!?]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.every(p => p === parts[0])) return parts[0];
  return normalized;
}

/** Check if text matches a known hallucination phrase (normalized, repeated-aware). */
function isBlocklisted(text: string, language?: string): boolean {
  const normalized = normalizePhrase(text);
  if (!normalized) return false;
  const deduped = dedupeRepeated(normalized);
  const lang = normalizeLang(language);

  // Check language-specific blocklist first (try both the normalized form and
  // the doubled-collapsed form).
  if (lang) {
    const langSet = blocklistByLang.get(lang);
    if (langSet && (langSet.has(normalized) || langSet.has(deduped))) return true;
  }

  // Fall back to global blocklist.
  const all = getBlocklistAll();
  return all.has(normalized) || all.has(deduped);
}

// ---------------------------------------------------------------------------
// Metadata filter
// ---------------------------------------------------------------------------

/**
 * Result of metadata-based segment filtering.
 *
 * Contains the segments that passed, those that were rejected, and the
 * rejection reasons keyed by segment ID.
 */
export interface SegmentFilterResult {
  /** Segments that passed the metadata filter. */
  kept: STTSegment[];
  /** Segments that were rejected as likely hallucinations. */
  rejected: STTSegment[];
  /** Human-readable rejection reason for each rejected segment, keyed by segment ID. */
  reasons: Map<number, string>;
}

/** Filter segments by Whisper metadata thresholds. */
function filterSegmentsByMetadata(
  segments: STTSegment[],
  config: STTHallucinationFilterConfig,
): SegmentFilterResult {
  const kept: STTSegment[] = [];
  const rejected: STTSegment[] = [];
  // Use array index as key — some Whisper variants restart `seg.id` at 0 per
  // chunk, so a Map keyed by `seg.id` would silently overwrite earlier
  // rejections from a different chunk. Index is monotonically unique.
  const reasons = new Map<number, string>();

  segments.forEach((seg, i) => {
    if (seg.no_speech_prob > config.noSpeechProbThreshold) {
      rejected.push(seg);
      reasons.set(i, `no_speech_prob=${seg.no_speech_prob.toFixed(3)} > ${config.noSpeechProbThreshold}`);
    } else if (seg.compression_ratio > config.compressionRatioThreshold) {
      rejected.push(seg);
      reasons.set(i, `compression_ratio=${seg.compression_ratio.toFixed(2)} > ${config.compressionRatioThreshold}`);
    } else if (seg.avg_logprob < config.avgLogprobThreshold) {
      rejected.push(seg);
      reasons.set(i, `avg_logprob=${seg.avg_logprob.toFixed(3)} < ${config.avgLogprobThreshold}`);
    } else {
      kept.push(seg);
    }
  });

  return { kept, rejected, reasons };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Result returned by `filterHallucinations`.
 *
 * Contains the filtered text along with metadata about what was removed
 * and aggregate metrics from the original STT response.
 */
export interface HallucinationFilterResult {
  /** Filtered text (segments that passed all filters, concatenated). Empty if all rejected. */
  text: string;
  /** Original text before any filtering was applied. */
  originalText: string;
  /** Whether any filtering was applied (i.e., the text changed). */
  filtered: boolean;
  /** Number of segments rejected by the metadata filter. */
  metadataRejected: number;
  /** Whether the entire text was rejected by the blocklist. */
  blocklistRejected: boolean;
  /** Human-readable descriptions of why segments or text were rejected. */
  reasons: string[];
  /** Aggregate metrics from the STT response (for logging/debugging). */
  metrics?: {
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
  };
}

/**
 * Apply hallucination filtering to an STT response.
 *
 * Two complementary filtering layers are applied in sequence:
 * 1. **Metadata filter** — rejects individual segments based on Whisper's
 *    `no_speech_prob`, `compression_ratio`, and `avg_logprob` signals.
 * 2. **Blocklist filter** — rejects the entire text if it matches a known
 *    hallucination phrase from the `sachaarbonel/whisper-hallucinations` dataset.
 *
 * @param response - The STT response to filter (requires `segments` for metadata filtering)
 * @param language - ISO 639-1 language code for blocklist lookup (e.g. "en", "fr")
 * @param config - Filter thresholds and toggle flags (defaults to `DEFAULT_HALLUCINATION_FILTER_CONFIG`)
 * @returns Filtered text with metadata about what was removed
 *
 * @example
 * ```typescript
 * const result = filterHallucinations(sttResponse, 'en');
 * if (result.filtered) {
 *   console.log('Filtered out hallucinations:', result.reasons);
 * }
 * console.log('Clean text:', result.text);
 * ```
 */
export function filterHallucinations(
  response: STTResponse,
  language?: string,
  config: STTHallucinationFilterConfig = DEFAULT_HALLUCINATION_FILTER_CONFIG,
): HallucinationFilterResult {
  const originalText = response.text;
  const reasons: string[] = [];
  let text = originalText;
  let metadataRejected = 0;
  let blocklistRejected = false;

  // Only include fields actually reported by the provider — `?? 0` for
  // missing metrics produced misleading "avg_logprob: 0" entries that
  // looked like real measurements. NaN sentinel makes downstream consumers
  // explicitly handle the missing case.
  const metrics = (response.avg_logprob !== undefined || response.compression_ratio !== undefined || response.no_speech_prob !== undefined)
    ? {
        avg_logprob: response.avg_logprob ?? NaN,
        compression_ratio: response.compression_ratio ?? NaN,
        no_speech_prob: response.no_speech_prob ?? NaN,
      }
    : undefined;

  // Layer 1: Metadata-based segment filtering
  if (config.metadataFilterEnabled && response.segments && response.segments.length > 0) {
    const result = filterSegmentsByMetadata(response.segments, config);
    metadataRejected = result.rejected.length;

    if (result.rejected.length > 0) {
      for (const [segId, reason] of result.reasons) {
        reasons.push(`seg[${segId}]: ${reason}`);
      }

      if (result.kept.length === 0) {
        // All segments rejected — entire response is hallucination
        text = '';
        reasons.push('all segments rejected by metadata filter');
      } else {
        // Reconstruct text from kept segments only. Join on a single space and
        // collapse runs — naive join('') glued words together whenever a
        // provider's segment text wasn't already space-prefixed.
        text = result.kept
          .map(s => s.text.trim())
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
  }

  // Layer 2: Blocklist exact-match filter (on the final text)
  if (config.blocklistFilterEnabled && text) {
    if (isBlocklisted(text, language)) {
      reasons.push(`blocklist match: "${text.slice(0, 60)}"`);
      blocklistRejected = true;
      text = '';
    }
  }

  return {
    text,
    originalText,
    filtered: text !== originalText,
    metadataRejected,
    blocklistRejected,
    reasons,
    metrics,
  };
}
