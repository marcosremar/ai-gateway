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
