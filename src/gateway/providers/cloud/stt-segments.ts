/**
 * Whisper `verbose_json` metadata → STTResponse. One reader for every OpenAI-shaped STT provider, so the gateway's
 * hallucination filter (src/stt-hallucination-filter.ts) sees the same fields whichever provider answered.
 *
 * Segment fields: no_speech_prob, avg_logprob, compression_ratio (Radford et al. 2023, ICML, arXiv:2212.04356).
 * Aggregates are weighted by segment duration. A server that sends no segments, or a flat
 * `{no_speech_prob, avg_logprob, compression_ratio}` (the speech-stack replica), still gets the aggregate fields.
 */

import type { STTResponse, STTSegment } from './types';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Whisper's language names (openai/whisper tokenizer.py LANGUAGES, inverted) → ISO-639-1 (yue/haw: no 639-1 code). */
const WHISPER_LANGUAGE_CODES: Record<string, string> = {
  english: 'en', chinese: 'zh', german: 'de', spanish: 'es', russian: 'ru', korean: 'ko', french: 'fr', japanese: 'ja',
  portuguese: 'pt', turkish: 'tr', polish: 'pl', catalan: 'ca', dutch: 'nl', arabic: 'ar', swedish: 'sv', italian: 'it',
  indonesian: 'id', hindi: 'hi', finnish: 'fi', vietnamese: 'vi', hebrew: 'he', ukrainian: 'uk', greek: 'el', malay: 'ms',
  czech: 'cs', romanian: 'ro', danish: 'da', hungarian: 'hu', tamil: 'ta', norwegian: 'no', thai: 'th', urdu: 'ur',
  croatian: 'hr', bulgarian: 'bg', lithuanian: 'lt', latin: 'la', maori: 'mi', malayalam: 'ml', welsh: 'cy', slovak: 'sk',
  telugu: 'te', persian: 'fa', latvian: 'lv', bengali: 'bn', serbian: 'sr', azerbaijani: 'az', slovenian: 'sl',
  kannada: 'kn', estonian: 'et', macedonian: 'mk', breton: 'br', basque: 'eu', icelandic: 'is', armenian: 'hy',
  nepali: 'ne', mongolian: 'mn', bosnian: 'bs', kazakh: 'kk', albanian: 'sq', swahili: 'sw', galician: 'gl',
  marathi: 'mr', punjabi: 'pa', sinhala: 'si', khmer: 'km', shona: 'sn', yoruba: 'yo', somali: 'so', afrikaans: 'af',
  occitan: 'oc', georgian: 'ka', belarusian: 'be', tajik: 'tg', sindhi: 'sd', gujarati: 'gu', amharic: 'am',
  yiddish: 'yi', lao: 'lo', uzbek: 'uz', faroese: 'fo', 'haitian creole': 'ht', pashto: 'ps', turkmen: 'tk',
  nynorsk: 'nn', maltese: 'mt', sanskrit: 'sa', luxembourgish: 'lb', myanmar: 'my', tibetan: 'bo', tagalog: 'tl',
  malagasy: 'mg', assamese: 'as', tatar: 'tt', hawaiian: 'haw', lingala: 'ln', hausa: 'ha', bashkir: 'ba',
  javanese: 'jw', sundanese: 'su', cantonese: 'yue',
  // Whisper aliases
  burmese: 'my', valencian: 'ca', flemish: 'nl', haitian: 'ht', letzeburgesch: 'lb', pushto: 'ps', panjabi: 'pa',
  moldavian: 'ro', moldovan: 'ro', sinhalese: 'si', castilian: 'es', mandarin: 'zh',
};

/**
 * A detected language as ISO-639-1: "fr", "FR", "fr-FR" → "fr"; Whisper names ("french", "French") → "fr".
 * Anything else is kept as sent (trimmed), so an unknown value still reaches the client; empty → undefined.
 */
export function toIsoLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!v) return undefined;
  const lower = v.toLowerCase();
  if (/^[a-z]{2,3}([-_][a-z0-9]+)*$/.test(lower) && !WHISPER_LANGUAGE_CODES[lower]) return lower.split(/[-_]/)[0];
  return WHISPER_LANGUAGE_CODES[lower] ?? v;
}

/**
 * Detected `language` (ISO-639-1) and `duration` (s) of an OpenAI-shaped answer, when the server sent them. The
 * speech-stack replica always does (faster-whisper `info.language`/`info.duration`), whatever `response_format` says.
 */
export function applyWhisperMeta(response: STTResponse, raw: unknown): void {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return;
  const language = toIsoLanguage(obj.language);
  if (language) response.language = language;
  const duration = num(obj.duration);
  if (duration !== undefined && duration >= 0) response.duration = duration;
}

export function applyWhisperSegments(response: STTResponse, raw: unknown): void {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return;
  const segments: STTSegment[] = [];
  if (Array.isArray(obj.segments)) {
    for (const seg of obj.segments as Record<string, unknown>[]) {
      if (typeof seg?.text !== 'string') continue;
      segments.push({
        id: num(seg.id) ?? segments.length,
        start: num(seg.start) ?? 0,
        end: num(seg.end) ?? 0,
        text: seg.text,
        avg_logprob: num(seg.avg_logprob) ?? 0,
        compression_ratio: num(seg.compression_ratio) ?? 0,
        no_speech_prob: num(seg.no_speech_prob) ?? 0,
      });
    }
  }
  if (segments.length > 0) {
    response.segments = segments;
    let totalDur = 0, wLogprob = 0, wCompression = 0, wNoSpeech = 0;
    for (const s of segments) {
      const dur = Math.max(s.end - s.start, 0.01);
      totalDur += dur;
      wLogprob += s.avg_logprob * dur;
      wCompression += s.compression_ratio * dur;
      wNoSpeech += s.no_speech_prob * dur;
    }
    response.avg_logprob = Math.round((wLogprob / totalDur) * 1000) / 1000;
    response.compression_ratio = Math.round((wCompression / totalDur) * 1000) / 1000;
    response.no_speech_prob = Math.round((wNoSpeech / totalDur) * 1000) / 1000;
    return;
  }
  // Flat aggregate form (no segment list).
  const a = num(obj.avg_logprob), c = num(obj.compression_ratio), n = num(obj.no_speech_prob);
  if (a !== undefined) response.avg_logprob = a;
  if (c !== undefined) response.compression_ratio = c;
  if (n !== undefined) response.no_speech_prob = n;
}
