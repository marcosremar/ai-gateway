/**
 * Hallucination filter of the STT route: policy (env, per-request opt-out), the gateway's thresholds and the counters.
 * The filter itself is src/stt-hallucination-filter.ts; see docs/stt-hallucination-filter.md for sources and the pilot.
 *
 * Privacy: transcript text never reaches a log line, a header or a counter here: reason codes and lengths only.
 */

import { DEFAULT_HALLUCINATION_FILTER_CONFIG, filterHallucinations, type STTHallucinationFilterConfig } from '../../../stt-hallucination-filter';
import type { STTResponse } from '../../providers/cloud/types';

/**
 * The gateway's thresholds. DESIGN CHOICE to pilot and pre-register (not a published value): Radford et al. 2023 (ICML,
 * arXiv:2212.04356) treat avg_logprob < -1.0 as a failed decode, so the gateway uses -1.0 (the library default -0.8 was
 * too eager for accented A1 speech, whose real words score lower). Each one can be moved by env without a deploy.
 */
export const GATEWAY_FILTER_DEFAULTS: STTHallucinationFilterConfig = {
  ...DEFAULT_HALLUCINATION_FILTER_CONFIG,
  avgLogprobThreshold: -1.0,
};

const OFF = new Set(['0', 'false', 'off', 'no']);

export function filterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OFF.has((env.STT_HALLUCINATION_FILTER ?? '').trim().toLowerCase());
}

/** Per-request opt-out for QA: multipart field `filter_hallucinations=false|0|off`. */
export function requestOptsOut(field: unknown): boolean {
  return typeof field === 'string' && OFF.has(field.trim().toLowerCase());
}

function envNumber(v: string | undefined, fallback: number): number {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function filterConfig(env: NodeJS.ProcessEnv = process.env): STTHallucinationFilterConfig {
  const d = GATEWAY_FILTER_DEFAULTS;
  return {
    ...d,
    noSpeechProbThreshold: envNumber(env.STT_FILTER_NO_SPEECH_PROB, d.noSpeechProbThreshold),
    compressionRatioThreshold: envNumber(env.STT_FILTER_COMPRESSION_RATIO, d.compressionRatioThreshold),
    avgLogprobThreshold: envNumber(env.STT_FILTER_AVG_LOGPROB, d.avgLogprobThreshold),
    ambiguousNoSpeechProb: envNumber(env.STT_FILTER_AMBIGUOUS_NO_SPEECH_PROB, d.ambiguousNoSpeechProb),
  };
}

// ── counters (/health → sttFilter) ─────────────────────────────────────────
const stats = { since: new Date().toISOString(), answered: 0, filtered: 0, partial: 0, withMetadata: 0, byReason: {} as Record<string, number> };

export function sttFilterStats() {
  return { ...stats, byReason: { ...stats.byReason }, filteredRate: stats.answered ? Math.round((stats.filtered / stats.answered) * 1e4) / 1e4 : 0 };
}
export function _resetSttFilterStats(): void {
  Object.assign(stats, { since: new Date().toISOString(), answered: 0, filtered: 0, partial: 0, withMetadata: 0, byReason: {} });
}

export interface AppliedFilter {
  text: string;
  response: STTResponse;
  /** Present when something was removed: reason codes (no text) and the raw length. */
  filtered?: { codes: string[]; rawLength: number; emptied: boolean };
}

/** Runs the filter on a provider answer and updates the counters. The returned text is what the client may see. */
export function applySttFilter(result: STTResponse, language: string | undefined, config = filterConfig()): AppliedFilter {
  stats.answered++;
  if (result.segments?.length || result.no_speech_prob !== undefined) stats.withMetadata++;
  const out = filterHallucinations(result, language, config);
  if (!out.filtered) return { text: result.text, response: result };
  const emptied = out.text === '';
  if (emptied) stats.filtered++; else stats.partial++;
  for (const c of out.reasonCodes) stats.byReason[c] = (stats.byReason[c] ?? 0) + 1;
  return {
    text: out.text,
    response: { ...result, text: out.text, segments: out.keptSegments },
    filtered: { codes: out.reasonCodes, rawLength: out.originalText.length, emptied },
  };
}
