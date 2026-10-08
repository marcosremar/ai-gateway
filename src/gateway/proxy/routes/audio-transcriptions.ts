/**
 * POST /v1/audio/transcriptions — STT
 *
 * Includes an in-memory cache keyed by audio hash + model + language.
 * Identical audio sent twice (common on client retry after timeout)
 * returns the cached transcription instantly without hitting the provider.
 * Cache TTL: 5 minutes, max 200 entries.
 *
 * Hallucination filter (stt-filter.ts): every answer, whichever provider served it, goes through
 * src/stt-hallucination-filter.ts before the client or the cache sees it. A filtered answer is `{"text":""}` with
 * `X-STT-Filtered` (reason codes) and `X-STT-Raw-Length`; it is never cached. Off by env `STT_HALLUCINATION_FILTER=0`
 * or per request by the multipart field `filter_hallucinations=false`. Every 200 carries `X-STT-Filtered` so a client can
 * count: the reason codes, `none` when the answer was kept, `off` when the filter did not run (QA 2026-10-07: the header
 * appeared only on filtered answers, so a client could not tell "kept" from "not filtered by this gateway").
 */


import { budgetCapOf, hedgeCapOf } from '../internal-subrequest';
import { createHash } from 'crypto';
import { createLogger } from '../../../logger';

const log = createLogger('audio-transcriptions');
import type { STTProvider } from '../../providers/cloud/types';
import type { ProxyRequest, ProxyResponse, StageRoutes } from '../types';
import { CooldownTracker } from '../../providers/cloud/fallback';
import type { CircuitBreakerRegistry } from '../../providers/cloud/circuit-breaker';
import { applySttFilter, filterEnabled, requestOptsOut } from './stt-filter';
import {
  errorResponse, isNeutralFailure, normalizeTargets, providerUnavailableResponse, redactSecrets, routeRequest, stageBudgetMs,
} from '../provider-routing';

const sttCooldownTracker = new CooldownTracker();

/** `X-STT-*` of an answer the filter kept (`none`) or did not judge (`off`). */
function sttFilterHeaders(filterOn: boolean, rawLength: number): Record<string, string> {
  return { 'X-STT-Filtered': filterOn ? 'none' : 'off', 'X-STT-Raw-Length': String(rawLength) };
}

// ── STT response cache ──────────────────────────────────────────────────
const STT_CACHE_TTL_MS = 5 * 60_000;
const STT_CACHE_MAX_ENTRIES = 200;
const sttCache = new Map<string, { text: string; expiresAt: number }>();
let cacheWriteInProgress = false;

function sttCacheKey(audioHash: string, model: string, language?: string, responseFormat?: string, filtered = true): string {
  // Include response_format — verbose_json/srt/vtt produce structurally
  // different responses; without it, a hit from a `verbose_json` request
  // could be returned to a `srt`-format request as plain JSON.
  // `filtered`: an answer kept with the filter off (QA) must never be served to a request that has it on.
  return `${audioHash}:${model}:${language ?? '*'}:${responseFormat ?? 'json'}:${filtered ? 'f1' : 'f0'}`;
}

function hashAudio(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function sttCacheGet(key: string): string | null {
  const entry = sttCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { sttCache.delete(key); return null; }
  return entry.text;
}

/** Clear the STT cache. Exported for tests. */
export function _resetSttCache(): void { sttCache.clear(); }

function sttCacheSet(key: string, text: string): void {
  while (sttCache.size >= STT_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    let removedAny = false;
    for (const [k, v] of sttCache) {
      if (v.expiresAt < now) {
        sttCache.delete(k);
        removedAny = true;
        break;
      }
    }
    if (!removedAny) {
      const oldestKey = sttCache.keys().next().value;
      if (oldestKey !== undefined) sttCache.delete(oldestKey);
      else break;
    }
  }
  sttCache.set(key, { text, expiresAt: Date.now() + STT_CACHE_TTL_MS });
}

export async function handleAudioTranscriptions(
  req: ProxyRequest,
  sttProviders: StageRoutes<STTProvider>,
  unavailable?: Record<string, string[]>,
  circuitBreakers?: CircuitBreakerRegistry,
): Promise<ProxyResponse> {
  if (!req.body || typeof req.body !== 'object') {
    return { status: 400, body: { error: { message: 'request body is required', type: 'invalid_request_error' } } };
  }
  const body = req.body as Record<string, unknown>;

  if (!body.model || typeof body.model !== 'string') {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }
  if (req.rawBody.length === 0) {
    return { status: 400, body: { error: { message: 'audio data is required', type: 'invalid_request_error' } } };
  }
  if (req.rawBody.length > 25 * 1024 * 1024) {
    // 413 like the body-size guard of the server (chunked uploads): one status for "too big" whatever the path.
    return { status: 413, body: { error: { message: 'audio file exceeds 25MB limit', type: 'request_too_large' } } };
  }
  const validResponseFormats = ['json', 'text', 'srt', 'verbose_json', 'vtt'];
  if (body.response_format !== undefined && (typeof body.response_format !== 'string' || !validResponseFormats.includes(body.response_format))) {
    return { status: 400, body: { error: { message: `response_format must be one of: ${validResponseFormats.join(', ')}`, type: 'invalid_request_error' } } };
  }

  const model = body.model;
  const targets = normalizeTargets(sttProviders[model]);
  if (targets.length === 0) {
    if (unavailable?.[model]) return providerUnavailableResponse('stt', model, unavailable[model]);
    return { status: 404, body: { error: { message: `STT model "${model}" not found`, type: 'invalid_request_error' } } };
  }

  const filterOn = filterEnabled() && !requestOptsOut(body.filter_hallucinations);
  const language = typeof body.language === 'string' ? body.language : undefined;

  // Check STT cache — identical audio + model + language returns cached result
  const audioHash = hashAudio(req.rawBody);
  const cacheKey = sttCacheKey(
    audioHash,
    body.model,
    typeof body.language === 'string' ? body.language : undefined,
    typeof body.response_format === 'string' ? body.response_format : undefined,
    filterOn,
  );
  const cached = sttCacheGet(cacheKey);
  if (cached !== null) {
    // Served without the chain: still warm a cold primary deployment, so the next (uncached) turn finds it up.
    const primary = targets[0]?.provider as { prewarm?: () => void } | undefined;
    try { primary?.prewarm?.(); } catch { /* best effort */ }
    return {
      status: 200,
      headers: { 'X-Cache': 'HIT', 'X-Gateway-Provider': 'cache', ...sttFilterHeaders(filterOn, cached.length) },
      body: { text: cached },
    };
  }


  try {
    const { result, headers } = await routeRequest(
      targets,
      (t, signal) => t.provider.transcribe({
        signal,
        audio: req.rawBody,
        model: t.model ?? model,
        language,
        wantSegments: filterOn || body.response_format === 'verbose_json',
        prompt: body.prompt as string | undefined,
        responseFormat: (body.response_format as string) as 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | undefined,
      }),
      { stage: 'stt', signal: req.signal, timeoutMs: 15_000, budgetMs: Math.min(stageBudgetMs('stt'), budgetCapOf(req.headers) || Infinity), hedgeCapMs: hedgeCapOf(req.headers), retriesPerProvider: 1, cooldownTracker: sttCooldownTracker, breakers: circuitBreakers, notMounted: unavailable?.[model] },
    );

    const applied = filterOn ? applySttFilter(result, language) : { text: result.text, response: result, filtered: undefined };
    if (applied.filtered) {
      // Codes and lengths only: the transcript is student data and never goes to a log.
      log.log({ model, language: language ?? '-', provider: headers['X-Gateway-Provider'] ?? '-', reasons: applied.filtered.codes, rawLength: applied.filtered.rawLength, keptLength: applied.text.length }, 'STT hallucination filtered');
    }

    // Never cache an empty text (silence, a filtered hallucination, or a provider that answered 200 with nothing): it
    // would be served for 5 min to every retry of the same audio, even after the provider recovered (fault bench
    // 2026-10-06, item 23).
    // Nor an answer a fallback served because the primary FAILED (5xx, timeout…): the client's retry of the same audio
    // must reach the primary again once it is back, not get the fallback model's text for 5 min (fault bench
    // 2026-10-06, item 23). A primary that was only booting (`cold`) or is not configured did not fail: cached.
    const fallbackCode = headers['X-Gateway-Fallback'];
    const servedAfterFailure = !!fallbackCode && fallbackCode !== 'not_configured' && !isNeutralFailure(fallbackCode);
    if (applied.text?.trim() && !applied.filtered && !servedAfterFailure) sttCacheSet(cacheKey, applied.text);

    const filterHeaders: Record<string, string> = applied.filtered
      ? { 'X-STT-Filtered': applied.filtered.codes.join(',').slice(0, 120), 'X-STT-Raw-Length': String(applied.filtered.rawLength) }
      : sttFilterHeaders(filterOn, (result.text ?? '').length);
    // verbose_json asked by the client: the metadata passes through (only the segments the filter kept).
    const verbose = body.response_format === 'verbose_json'
      ? { language: applied.response.language, duration: applied.response.duration, segments: applied.response.segments }
      : {};
    return {
      status: 200,
      headers: { 'X-Cache': 'MISS', ...headers, ...filterHeaders },
      body: { text: applied.text, ...verbose },
    };
  } catch (err) {
    log.error(`STT error for model ${model}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    return errorResponse(err, 'stt', model);
  }
}
