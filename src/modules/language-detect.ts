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

  // Restrict franc to only consider source and target
  // franc uses ISO 639-3 codes, so we need to convert
  const iso1ToIso3: Record<string, string> = {};
  for (const [k, v] of Object.entries(ISO3_TO_ISO1)) {
    iso1ToIso3[v] = k;
  }

  const srcIso3 = iso1ToIso3[source];
  const tgtIso3 = iso1ToIso3[target];

  if (!srcIso3 || !tgtIso3) {
    return { language: '', confidence: 0 };
  }

  // Build allow list — only these two languages
  // franc's `only` parameter restricts to specific ISO 639-3 codes
  const detected = franc(text, { only: [srcIso3, tgtIso3], minLength: 10 });

  if (detected === 'und') {
    return { language: '', confidence: 0 };
  }

  const detectedIso1 = ISO3_TO_ISO1[detected] || '';
  if (!detectedIso1) {
    return { language: '', confidence: 0 };
  }

  // Estimate confidence: run again unrestricted and compare
  // If the unrestricted result matches, confidence is higher
  const unrestricted = franc(text, { minLength: 10 });
  const unrestrictedIso1 = ISO3_TO_ISO1[unrestricted] || '';

  let confidence: number;
  if (unrestrictedIso1 === detectedIso1) {
    // Both restricted and unrestricted agree — high confidence
    confidence = 0.9;
  } else if (unrestrictedIso1 === source || unrestrictedIso1 === target) {
    // Unrestricted picked the other candidate — medium confidence
    confidence = 0.6;
  } else {
    // Unrestricted picked a completely different language — low confidence
    // The text might not be in either source or target
    confidence = 0.4;
  }

  // Boost confidence for longer texts
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount >= 15) confidence = Math.min(1, confidence + 0.05);
  if (wordCount >= 30) confidence = Math.min(1, confidence + 0.05);

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

  const shouldSwap =
    detected.language === target &&
    detected.confidence >= minConfidence;

  return { detected, shouldSwap };
}
