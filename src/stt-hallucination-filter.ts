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
 *
 * Sources (cited because every threshold below is a measurement decision):
 * - Radford, Kim, Xu, Brockman, McLeavey, Sutskever (2023), "Robust Speech Recognition via Large-Scale Weak
 *   Supervision", ICML 2023 (PMLR 202), arXiv:2212.04356 — no_speech_prob 0.6 with avg_logprob -1.0 mark a silent
 *   window, gzip compression_ratio 2.4 marks a repetition loop (the values of Whisper's own decoder).
 * - Koenecke, Choi, Mei, Schellmann, Sloane (2024), "Careless Whisper: Speech-to-Text Hallucination Harms", ACM FAccT
 *   2024, DOI 10.1145/3630106.3658996 — Whisper invents whole phrases on silence/pauses; ~1% of transcripts.
 * - Blocklist data: sachaarbonel/whisper-hallucinations (community dataset, not peer reviewed).
 * Thresholds and the high-confidence/ambiguous split of the blocklist are DESIGN CHOICES to pilot and pre-register
 * (docs/stt-hallucination-filter.md), not published values.
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
  /**
   * Short/generic blocklist entries ("não", "obrigado", "eu não sei"…) are also things a learner says. They are dropped
   * only when the aggregate no_speech_prob of the answer is at least this (needs metadata). Default: 0.4.
   */
  ambiguousNoSpeechProb: number;
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
  ambiguousNoSpeechProb: 0.4,
};

// ---------------------------------------------------------------------------
// Blocklist (loaded once from JSON at module init)
// ---------------------------------------------------------------------------

const blocklistByLang: Map<string, Set<string>> = new Map();

// Build lookup sets from the imported JSON
for (const [lang, phrases] of Object.entries(hallucinations as Record<string, string[]>)) {
  blocklistByLang.set(lang, new Set(phrases));
}

/** Words that mark video/credit boilerplate: an entry containing one is a hallucination, never a learner's sentence. */
const BOILERPLATE = /amara|legenda|subtitle|sous titres|inscreva|inscrever|abonn|assistir|regarder|regard|watching|subscribe|canal|cha[iî]ne|channel|notific|sininho|instagram|like e|vídeo|video|tipeeee/;

/**
 * Entries judged unsafe to drop on text alone are "ambiguous" (short generic words and sentences a learner may well
 * say). A phrase is high-confidence when it has >= 6 words or carries boilerplate vocabulary, or is in ALWAYS_BLOCK.
 */
const ALWAYS_BLOCK: Record<string, string[]> = {
  // Reported by the owner on silent class clips (2026-10-06: "E aí" invented on 3 of 6 silent clips).
  pt: ['e aí', 'obrigado por assistir', 'obrigada por assistir'],
};

/** Plausible one-word/short learner answers: never dropped by the blocklist alone, in any language. */
const LEARNER_SAFE = new Set([
  'sim', 'não', 'nao', 'oi', 'olá', 'ola', 'obrigado', 'obrigada', 'tchau', 'bom dia', 'boa tarde', 'boa noite', 'por favor',
  'oui', 'non', 'merci', 'bonjour', 'salut', 'au revoir', 's il vous plaît', 'bonsoir',
  'yes', 'no', 'hello', 'hi', 'thanks', 'thank you', 'bye', 'okay', 'ok', 'good morning', 'please',
]);

function isHighConfidence(lang: string, phrase: string): boolean {
  if (ALWAYS_BLOCK[lang]?.includes(phrase)) return true;
  if (LEARNER_SAFE.has(phrase)) return false;
  return phrase.split(' ').length >= 6 || BOILERPLATE.test(phrase);
}

const highConfidenceAll = new Set<string>();
const ambiguousByLang: Map<string, Set<string>> = new Map();
for (const [lang, set] of blocklistByLang) {
  const amb = new Set<string>();
  for (const p of set) { if (isHighConfidence(lang, p)) highConfidenceAll.add(p); else amb.add(p); }
  for (const p of ALWAYS_BLOCK[lang] ?? []) highConfidenceAll.add(p);
  ambiguousByLang.set(lang, amb);
}

const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  portuguese: 'pt', português: 'pt', portugues: 'pt', french: 'fr', français: 'fr', francais: 'fr', english: 'en',
  spanish: 'es', español: 'es', german: 'de', italian: 'it', japanese: 'ja', korean: 'ko', chinese: 'zh', russian: 'ru',
  dutch: 'nl', arabic: 'ar', hindi: 'hi', turkish: 'tr', polish: 'pl', ukrainian: 'uk', swedish: 'sv', indonesian: 'id',
};

/** 'pt', 'pt-BR', 'Portuguese', 'português' → 'pt'; unknown/empty → undefined (all-language high-confidence only). */
export function normalizeLanguage(language?: string | null): string | undefined {
  if (typeof language !== 'string') return undefined;
  const v = language.trim().toLowerCase();
  if (!v) return undefined;
  if (LANGUAGE_NAME_TO_CODE[v]) return LANGUAGE_NAME_TO_CODE[v];
  const code = v.split(/[-_]/)[0];
  return blocklistByLang.has(code) ? code : undefined;
}

/** The dataset form: lowercase, punctuation/hyphen/dot → space ("Amara.org" → "amara org"), apostrophes kept as '. */
export function normalizeForBlocklist(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[’‘`´]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
}

type BlocklistVerdict = 'high' | 'ambiguous' | null;

/**
 * Exact match on the normalized text. High-confidence phrases (any language: Whisper says "Thank you for watching" over
 * Portuguese audio) always match; ambiguous ones only in the request language and never for LEARNER_SAFE words.
 */
function blocklistVerdict(text: string, language?: string): BlocklistVerdict {
  const n = normalizeForBlocklist(text);
  if (!n) return null;
  if (highConfidenceAll.has(n)) return 'high';
  if (language && !LEARNER_SAFE.has(n) && ambiguousByLang.get(language)?.has(n)) return 'ambiguous';
  return null;
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
  /** Segments that survived the metadata filter (all of them when it did not run). */
  keptSegments?: STTSegment[];
  /** Number of segments rejected by the metadata filter. */
  metadataRejected: number;
  /** Whether the entire text was rejected by the blocklist. */
  blocklistRejected: boolean;
  /** Human-readable descriptions of why segments or text were rejected. Never carries transcript text. */
  reasons: string[];
  /** Short machine codes (no transcript text): no_speech_prob, compression_ratio, avg_logprob, blocklist, blocklist_corroborated. */
  reasonCodes: string[];
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
  languageInput?: string,
  config: STTHallucinationFilterConfig = DEFAULT_HALLUCINATION_FILTER_CONFIG,
): HallucinationFilterResult {
  const language = normalizeLanguage(languageInput);
  const originalText = response.text;
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  let text = originalText;
  let metadataRejected = 0;
  let blocklistRejected = false;
  let keptSegments = response.segments;

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
  // A provider that reports one flat set of metrics (no segment list) is judged as a single segment.
  const judged: STTSegment[] | undefined = response.segments?.length ? response.segments
    : metrics && originalText ? [{
      id: 0, start: 0, end: 0, text: originalText,
      no_speech_prob: response.no_speech_prob ?? 0, compression_ratio: response.compression_ratio ?? 0, avg_logprob: response.avg_logprob ?? 0,
    }] : undefined;
  if (config.metadataFilterEnabled && judged && judged.length > 0) {
    const result = filterSegmentsByMetadata(judged, config);
    metadataRejected = result.rejected.length;
    if (judged === response.segments) keptSegments = result.kept;

    if (result.rejected.length > 0) {
      for (const [segId, reason] of result.reasons) {
        reasons.push(`seg[${segId}]: ${reason}`);
        const code = reason.split('=')[0];
        if (!reasonCodes.includes(code)) reasonCodes.push(code);
      }

      if (result.kept.length === 0) {
        // All segments rejected — entire response is hallucination
        text = '';
        reasons.push('all segments rejected by metadata filter');
      } else {
        // Reconstruct text from kept segments only
        text = result.kept.map(s => s.text).join('').trim();
      }
    }
  }

  // Layer 2: Blocklist exact-match filter (on the final text)
  if (config.blocklistFilterEnabled && text) {
    const verdict = blocklistVerdict(text, language);
    // An ambiguous phrase needs the signal's word too: no metadata → kept (a learner may have said it).
    const corroborated = verdict === 'ambiguous' && (response.no_speech_prob ?? 0) >= config.ambiguousNoSpeechProb;
    if (verdict === 'high' || corroborated) {
      reasons.push(`blocklist match (${text.length} chars)`);
      reasonCodes.push(verdict === 'high' ? 'blocklist' : 'blocklist_corroborated');
      blocklistRejected = true;
      text = '';
    }
  }

  return {
    text,
    originalText,
    filtered: text !== originalText,
    keptSegments: text === '' ? [] : keptSegments,
    metadataRejected,
    blocklistRejected,
    reasons,
    reasonCodes,
    metrics,
  };
}
