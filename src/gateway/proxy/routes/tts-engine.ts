/**
 * `POST /v1/audio/speech/engine` — which TTS engine the GPU behind a TTS alias keeps loaded.
 *
 * The speech-stack replica loads ONE of Qwen3-TTS / Kokoro / Pocket at a time (docker/speech-stack/tts_engines.py): the
 * others are unloaded to give their RAM / VRAM back. An app sends one TTS alias per session (babelcast: `babelcast-tts`,
 * `babelcast-tts-kokoro`, `babelcast-tts-pocket`); calling this when the session starts makes the replica switch now,
 * instead of on the first line (which the replica answers with a quick 503 while it switches, so that line is spoken by
 * the alias's next link). Without the call the replica still follows the requests, once the engine it has has been idle
 * for its `TTS_SWITCH_IDLE_S` (120 s).
 *
 *   POST /v1/audio/speech/engine {"model": "babelcast-tts-pocket", "force"?: false}   (app key: its own aliases)
 *   200 {"ok": true, "deployment", "engine": "pocket", "selected": true, "replica": {active, switching_to, engines…}}
 *   200 {"ok": true, "selected": false, "reason": "no_engine_choice" | "no_gpu_link"}   nothing to choose there (a replica with one engine)
 *   409 {"error": {"code": "engine_in_use"}, "replica": …}   the replica speaks with another engine in use: `force` switches
 *   503 {"error": {"code": "gpu_not_ready"}} + Retry-After   no ready replica (a cold one is woken as by any request)
 *
 * The engine follows the alias's first `deployment:` link: its upstream model (`deployment:<name>:pocket`) names it the
 * way the replica reads `model` on `/v1/audio/speech` ("kokoro…", "pocket…", else Qwen3-TTS).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { DeploymentController } from '../../../deployments/controller';
import { DeploymentError, type Lease } from '../../../deployments/controller-state';
import { replicaBase } from '../../../deployments/http';
import { replicaTls } from '../../../deployments/replica-tls';
import { outgoingTraceHeaders } from '../../../telemetry/trace-context';
import { noWakeActive, recordNoWakeSkip } from '../no-wake';

export const TTS_ENGINE_PATH = '/v1/audio/speech/engine';
const BODY_MAX = 4 * 1024;
const REPLICA_TIMEOUT_MS = 10_000;

export type TtsEngine = 'qwen' | 'kokoro' | 'pocket';

/** The engine a model names on the speech-stack (same rule as `tts_engines.engine_of`). */
export function ttsEngineOf(model: string): TtsEngine {
  const m = model.toLowerCase();
  return m.includes('kokoro') ? 'kokoro' : m.includes('pocket') ? 'pocket' : 'qwen';
}

export interface TtsEngineDeps {
  controller: Pick<DeploymentController, 'acquire'> | null;
  /** The `deployment:` links of a TTS alias's chain, in order, with the model each sends its replica. */
  linksOf: (model: string) => Array<{ deployment: string; upstreamModel: string }>;
  userOf: (req: IncomingMessage) => string | null;
  isAdmin: (userId: string) => boolean;
  /** The app's own TTS aliases (null: none). */
  aliasesOf: (userId: string) => ReadonlySet<string> | null;
  fetchImpl?: typeof fetch;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | number> = {}): void {
  if (res.headersSent) { res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

const fail = (res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string | number> = {}) =>
  send(res, status, { error: { message, type: status === 403 ? 'permission_error' : status >= 500 ? 'upstream_error' : 'invalid_request_error', code }, ...extra }, headers);

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) { resolve(null); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
      } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

export function createTtsEngineRoute(deps: TtsEngineDeps) {
  const log = deps.log ?? (() => {});
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = deps.userOf(req);
    if (!userId) return fail(res, 401, 'unauthorized', 'missing or invalid API key');
    const body = await readBody(req);
    const model = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!body || !model) return fail(res, 400, 'missing_model', 'body must be {"model": "<the app\'s TTS alias>", "force"?: boolean}');
    if (!deps.isAdmin(userId) && !deps.aliasesOf(userId)?.has(model)) {
      return fail(res, 403, 'permission_error', `model '${model}' is not a TTS alias of app '${userId}'`);
    }
    const link = deps.linksOf(model)[0];
    if (!link || !deps.controller) return send(res, 200, { ok: true, model, selected: false, reason: 'no_gpu_link' });
    const engine = ttsEngineOf(link.upstreamModel);
    const noWake = noWakeActive(link.deployment);
    let lease: Lease;
    try {
      lease = await deps.controller.acquire(link.deployment, noWake ? { waitMs: 0, noWake: true, stage: 'tts' } : { waitMs: 0, stage: 'tts' });
    } catch (err) {
      if (noWake && err instanceof DeploymentError && err.status === 503) recordNoWakeSkip();
      const retry = err instanceof DeploymentError ? err.retryAfterSeconds ?? 30 : 30;
      return fail(res, 503, 'gpu_not_ready', `the GPU of '${model}' is not ready: ${err instanceof Error ? err.message : String(err)}`,
        { deployment: link.deployment, engine }, { 'Retry-After': retry });
    }
    const base = replicaBase(lease.machine, lease.exposed);
    let status = 0;
    let replica: unknown = null;
    try {
      const answer = await (deps.fetchImpl ?? fetch)(`${base}/v1/tts/engine`, {
        method: 'POST',
        ...(replicaTls(base, lease.token)),
        headers: { 'Content-Type': 'application/json', ...outgoingTraceHeaders(), 'X-Aigw-Token': lease.token },
        body: JSON.stringify({ engine, force: body.force === true }),
        signal: AbortSignal.timeout(REPLICA_TIMEOUT_MS),
      });
      status = answer.status;
      replica = await answer.json().catch(() => null);
      lease.done(false);
    } catch (err) {
      lease.done(true);
      return fail(res, 502, 'replica_unreachable', `the GPU replica did not answer: ${err instanceof Error ? err.message : String(err)}`,
        { deployment: link.deployment, engine });
    }
    log('tts engine: selected', { userId, model, deployment: link.deployment, engine, status });
    if (status === 404) return send(res, 200, { ok: true, model, deployment: link.deployment, engine, selected: false, reason: 'no_engine_choice' });
    if (status === 409) {
      return fail(res, 409, 'engine_in_use', `the GPU speaks with another engine in use; {"force": true} switches anyway`,
        { deployment: link.deployment, engine, replica });
    }
    if (status !== 200) return fail(res, 502, 'replica_error', `the GPU replica answered HTTP ${status}`, { deployment: link.deployment, engine, replica });
    return send(res, 200, { ok: true, model, deployment: link.deployment, engine, selected: true, replica });
  };
}
