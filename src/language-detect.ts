/**
 * Language detection module — detects whether text is in the source or target language.
 *
 * Uses `franc` (trigram-based, pure JS) for fast language identification.
 * Designed to mirror the Python lingua-based detection but run server-side
 * in the ai-gateway.
 *
 * Opt-in: disabled by default. Enable via `autoDetectLanguage: true` in pipeline config
 * or query param `?detectLanguage=true` on /v1/speech.
 */

import { franc } from 'franc';

// ── ISO 639-3 → ISO 639-1 mapping (franc returns 639-3) ─────────────────────
const ISO3_TO_ISO1: Record<string, string> = {
  fra: 'fr', eng: 'en', spa: 'es', por: 'pt', deu: 'de', ita: 'it',
  jpn: 'ja', zho: 'zh', kor: 'ko', ara: 'ar', rus: 'ru', hin: 'hi',
  nld: 'nl', pol: 'pl', tur: 'tr', swe: 'sv', ron: 'ro', ces: 'cs',
  fin: 'fi', nor: 'no', dan: 'da', hun: 'hu', ell: 'el', heb: 'he',
  tha: 'th', vie: 'vi', ind: 'id', msa: 'ms', ukr: 'uk', bul: 'bg',
  cat: 'ca', hrv: 'hr', slk: 'sk', slv: 'sl', lit: 'lt', lav: 'lv',
  est: 'et', srp: 'sr', bos: 'bs', mkd: 'mk', sqi: 'sq', kat: 'ka',
  hye: 'hy', urd: 'ur', ben: 'bn', tam: 'ta', tel: 'te', mar: 'mr',
  guj: 'gu', kan: 'kn', mal: 'ml', pan: 'pa', mya: 'my', khm: 'km',
  lao: 'lo', amh: 'am', tgl: 'tl', swh: 'sw', afr: 'af', eus: 'eu',
  glg: 'gl', cym: 'cy', gle: 'ga', isl: 'is', lat: 'la',
};

// Supported languages (ISO 639-1 codes) — the set of all languages that
// `franc` can return via the ISO3_TO_ISO1 mapping.
export const SUPPORTED_LANGUAGES = new Set(Object.values(ISO3_TO_ISO1));

// Inverse map (ISO 639-1 → ISO 639-3). Hoisted to module scope — it is pure
// over ISO3_TO_ISO1 and was previously rebuilt on every detection in the hot
// path (dub fanout detects the same text once per target).
const ISO1_TO_ISO3: Record<string, string> = (() => {
  const inv: Record<string, string> = {};
  for (const [k, v] of Object.entries(ISO3_TO_ISO1)) inv[v] = k;
  return inv;
})();

// ── Confidence estimation ────────────────────────────────────────────────────
// franc doesn't return confidence directly, but we can estimate it by comparing
// the probability gap between the top two candidates.

/**
 * Result of a language detection operation.
 */
export interface LanguageDetectResult {
  /** Detected ISO 639-1 language code (e.g. "fr", "en"), or "" if undetermined */
  language: string;
  /** Confidence score 0–1. Higher = more confident. Values below 0.65 are generally unreliable. */
  confidence: number;
}

/** Minimum word count for reliable detection. Short texts are unreliable. */
const MIN_WORDS = 4;

/**
 * Normalize a caller-supplied language code to the bare lower-case ISO 639-1
 * form used as the map key. Callers may pass `en-US` / `EN` / `pt_BR`; without
 * this, `ISO1_TO_ISO3['EN']` misses and detection silently returns
 * `{ language:'', confidence:0 }`. Mirrors the blocklist normalizer in
 * `stt-hallucination-filter.ts`.
 */
export function normalizeLangCode(code: string | undefined | null): string {
  if (!code) return '';
  const m = code.toLowerCase().match(/^[a-z]+/);
  return m ? m[0] : '';
}

// ── Unrestricted-franc result cache (#25) ────────────────────────────────────
// The confidence estimate runs `franc()` a SECOND time with no `only` allow-list.
// That unrestricted pass depends ONLY on the text, so in the dub-fanout path —
// where the same `sttText` is detected once per target language — it is pure
// recomputation. Memoize it with a small bounded LRU keyed by the raw text.
const UNRESTRICTED_CACHE_MAX = 256;
const _unrestrictedCache = new Map<string, string>();

function francUnrestricted(text: string): string {
  const cached = _unrestrictedCache.get(text);
  if (cached !== undefined) {
    // LRU promote: re-insert so the hottest text survives eviction.
    _unrestrictedCache.delete(text);
    _unrestrictedCache.set(text, cached);
    return cached;
  }
  const result = franc(text, { minLength: 10 });
  if (_unrestrictedCache.size >= UNRESTRICTED_CACHE_MAX) {
    // Evict the oldest (first-inserted) entry — Map preserves insertion order.
    const oldest = _unrestrictedCache.keys().next().value;
    if (oldest !== undefined) _unrestrictedCache.delete(oldest);
  }
  _unrestrictedCache.set(text, result);
  return result;
}

/** Test/observability hook: clear the unrestricted-franc memo. */
export function _clearUnrestrictedCache(): void {
  _unrestrictedCache.clear();
}

// ── Confidence tuning constants ──────────────────────────────────────────────
// Previously these were inline magic numbers. Named so operators reading the
// detection logic can see (and tune) exactly how confidence is scored.

/** Restricted and unrestricted franc passes agree → high confidence. */
const CONFIDENCE_AGREE = 0.9;
/** Unrestricted picked the *other* candidate (src/tgt) → medium confidence. */
const CONFIDENCE_OTHER_CANDIDATE = 0.6;
/** Unrestricted picked a completely different language → low confidence. */
const CONFIDENCE_MISMATCH = 0.4;
/** Word-count thresholds that each add a small confidence boost. */
const CONFIDENCE_BOOST_WORDS_1 = 15;
const CONFIDENCE_BOOST_WORDS_2 = 30;
/** Per-band confidence boost added at each word-count threshold. */
const CONFIDENCE_BOOST_STEP = 0.05;

/**
 * Detect the language of a text, restricted to a source and target language.
 *
 * Uses `franc` (trigram-based, pure JS) to classify the text. The detection
 * is restricted to only the two candidate languages to avoid false positives.
 * Confidence is estimated by comparing restricted vs. unrestricted results.
 *
 * Texts shorter than 4 words return `{ language: '', confidence: 0 }` because
 * short texts are unreliable for trigram-based detection.
 *
 * @param text - Text to classify
 * @param source - Expected source language ISO 639-1 code (e.g. "fr")
 * @param target - Expected target language ISO 639-1 code (e.g. "en")
 * @returns Detection result with language code and confidence (0–1)
 *
 * @example
 * ```typescript
 * const result = detectLanguage("Bonjour le monde", "fr", "en");
 * // result: { language: "fr", confidence: 0.9 }
 *
 * const short = detectLanguage("Hi", "fr", "en");
 * // short: { language: "", confidence: 0 }  // too short
 * ```
 */
export function detectLanguage(text: string, source: string, target: string): LanguageDetectResult {
  if (!text || text.trim().split(/\s+/).length < MIN_WORDS) {
    return { language: '', confidence: 0 };
  }

  // Restrict franc to only consider source and target.
  // franc uses ISO 639-3 codes, so we convert via the hoisted inverse map.
  // Normalize the codes first so `en-US`/`EN` don't miss the lookup.
  const src = normalizeLangCode(source);
  const tgt = normalizeLangCode(target);
  const srcIso3 = ISO1_TO_ISO3[src];
  const tgtIso3 = ISO1_TO_ISO3[tgt];

  if (!srcIso3 || !tgtIso3) {
    return { language: '', confidence: 0 };
  }

  // Build allow list — only these two languages
  // franc's `only` parameter restricts to specific ISO 639-3 codes.
  // Guard against franc throwing on pathological input — a detection failure
  // must never propagate and break the pipeline; degrade to "undetermined".
  let detected: string;
  let unrestricted: string;
  try {
    detected = franc(text, { only: [srcIso3, tgtIso3], minLength: 10 });
    // Estimate confidence: run again unrestricted and compare. The unrestricted
    // pass is text-only, so it is memoized (#25) — the dub-fanout path detects
    // the same `sttText` once per target and would otherwise pay this twice each.
    unrestricted = francUnrestricted(text);
  } catch {
    return { language: '', confidence: 0 };
  }

  if (detected === 'und') {
    return { language: '', confidence: 0 };
  }

  const detectedIso1 = ISO3_TO_ISO1[detected] || '';
  if (!detectedIso1) {
    return { language: '', confidence: 0 };
  }

  const unrestrictedIso1 = ISO3_TO_ISO1[unrestricted] || '';

  let confidence: number;
  if (unrestrictedIso1 === detectedIso1) {
    // Both restricted and unrestricted agree — high confidence
    confidence = CONFIDENCE_AGREE;
  } else if (unrestrictedIso1 === src || unrestrictedIso1 === tgt) {
    // Unrestricted picked the other candidate — medium confidence
    confidence = CONFIDENCE_OTHER_CANDIDATE;
  } else {
    // Unrestricted picked a completely different language — low confidence
    // The text might not be in either source or target
    confidence = CONFIDENCE_MISMATCH;
  }

  // Boost confidence for longer texts
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount >= CONFIDENCE_BOOST_WORDS_1) confidence = Math.min(1, confidence + CONFIDENCE_BOOST_STEP);
  if (wordCount >= CONFIDENCE_BOOST_WORDS_2) confidence = Math.min(1, confidence + CONFIDENCE_BOOST_STEP);

  return { language: detectedIso1, confidence };
}

/**
 * Detect language and recommend whether to swap source and target.
 *
 * Useful for speech-to-text pipelines where the speaker may have used the
 * wrong language. If the detected language matches the *target* language
 * (not the source), this function recommends a swap.
 *
 * @param text - Transcribed text to analyze
 * @param source - Expected source language ISO 639-1 code
 * @param target - Expected target language ISO 639-1 code
 * @param minConfidence - Minimum confidence threshold to trust the detection (default: 0.65)
 * @returns Object with detection result and a `shouldSwap` boolean
 *
 * @example
 * ```typescript
 * const { detected, shouldSwap } = detectLanguageWithSwap(
 *   "Hello world, how are you?",
 *   "fr", // expected French
 *   "en"  // expected English
 * );
 * // shouldSwap: true — the speaker used English, not French
 * ```
 */
export function detectLanguageWithSwap(
  text: string,
  source: string,
  target: string,
  minConfidence = 0.65,
): { detected: LanguageDetectResult; shouldSwap: boolean } {
  const detected = detectLanguage(text, source, target);

  // `detected.language` is a normalized ISO 639-1 code; normalize the caller's
  // `target` too so `en-US`/`EN` still trigger a swap.
  const shouldSwap =
    detected.language === normalizeLangCode(target) &&
    detected.confidence >= minConfidence;

  return { detected, shouldSwap };
}
