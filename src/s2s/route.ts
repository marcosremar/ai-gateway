/**
 * POST /v1/s2s — speech-to-speech in one streamed request, with routing and fallback.
 *
 * Request: multipart `file` (the student's utterance, any container the STT takes) + `config` (JSON, S2SConfig).
 * Response: frames (frames.ts) — binary by default, `?format=ndjson` for debugging/browsers.
 *
 * Routing, in order:
 *  1. primary: the speech-stack deployment (`S2S_DEPLOYMENT`, default `SPEECH_DEPLOYMENT` or `parle-speech`) answers
 *     on its own `/v1/s2s` — STT, LLM and TTS on one GPU, the lowest latency (0.4–0.8 s to first audio measured);
 *  2. no ready replica (cold, paused, absent, refused): the deployment is woken for the next turns and this one is
 *     answered at once by the composed pipeline (composite.ts) over the stage chains, each with its own fallback;
 *  3. hedge: the primary has not sent its transcript after `S2S_HEDGE_MS` (default 2.5 s) → the composed pipeline
 *     starts in parallel; the first one to produce audio wins, the other is aborted;
 *  4. the primary breaks after its transcript but before audio → the composed pipeline resumes at the LLM with that
 *     transcript (no second STT); after audio has started → an in-band `error` (partial) and `done`.
 *  5. nothing could answer before the first byte → a real `503 provider_unavailable` (not a 200 with an error inside).
 *
 * Every answer starts with a `route` event: {provider, fallback?, from?} — who is answering and why.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { DeploymentError, type DeploymentController } from '../deployments/controller';
import { replicaBase } from '../deployments/http';
import { runComposite, type S2SConfig, type StageClient } from './composite';
import { encodeAudio, encodeEvent, FrameDecoder, S2S_CONTENT_TYPE, type S2SEvent, type S2SFormat } from './frames';

type Controller = Pick<DeploymentController, 'acquire' | 'get' | 'wake'>;

export interface S2SRouteOptions {
  controller: Controller | null;
  /** Stage client for the composed fallback, built per request (it forwards the caller's key). */
  stagesFor: (req: IncomingMessage) => StageClient;
  deployment?: string;
  hedgeMs?: number;
  budgetMs?: number;
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export const S2S_HEDGE_MS = 2_500;
export const S2S_BUDGET_MS = 45_000;
const MAX_BODY = 25 * 1024 * 1024;

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error(`body larger than ${limit} bytes`), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Where frames go: nothing is written (status, headers) until the first frame, so an early failure can still be a 503. */
class Sink {
  private started = false;
  closed = false;
  constructor(private readonly res: ServerResponse, private readonly format: S2SFormat) {}
  private start() {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, {
      'Content-Type': S2S_CONTENT_TYPE[this.format], 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
    });
    this.res.flushHeaders?.();
  }
  /** `route` events wait for the first real content: a failure before any content can still be a 503. */
  private prelude: S2SEvent[] = [];
  get hasStarted() { return this.started; }
  /** A lane that lost the race announced itself: forget it (nothing of it was written yet). */
  dropPrelude() { this.prelude = []; }
  event(e: S2SEvent) {
    if (this.closed) return;
    if (!this.started && e.type === 'route') { this.prelude.push(e); return; }
    this.start();
    for (const p of this.prelude.splice(0)) this.res.write(encodeEvent(p, this.format));
    this.res.write(encodeEvent(e, this.format));
  }
  audio(pcm: Uint8Array) {
    if (this.closed) return;
    this.start();
    for (const p of this.prelude.splice(0)) this.res.write(encodeEvent(p, this.format));
    this.res.write(encodeAudio(pcm, this.format));
  }
  end() { if (this.closed) return; this.closed = true; this.start(); this.res.end(); }
}

/** A producer whose output is either written live or held until it wins a race. */
class Lane {
  private held: Array<{ e?: S2SEvent; a?: Uint8Array }> = [];
  aborted = false;
  sawAudio = false;
  constructor(private readonly sink: Sink, public live: boolean, private readonly onFirstAudio?: () => void) {}
  event(e: S2SEvent) { if (this.aborted) return; if (this.live) this.sink.event(e); else this.held.push({ e }); }
  audio(a: Uint8Array) {
    if (this.aborted) return;
    if (!this.sawAudio) { this.sawAudio = true; this.onFirstAudio?.(); }
    if (this.live) this.sink.audio(a); else if (!this.aborted) this.held.push({ a });
  }
  goLive() {
    this.live = true;
    for (const item of this.held.splice(0)) { if (item.e) this.sink.event(item.e); else this.sink.audio(item.a!); }
  }
}

export function createS2SRoute(opts: S2SRouteOptions) {
  const deployment = opts.deployment ?? 'parle-speech';
  const hedgeMs = opts.hedgeMs ?? S2S_HEDGE_MS;
  const budgetMs = opts.budgetMs ?? S2S_BUDGET_MS;
  const log = opts.log ?? (() => {});
  const f = opts.fetchImpl ?? fetch;

  return async function handleS2S(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = performance.now();
    const format: S2SFormat = new URL(req.url ?? '/', 'http://x').searchParams.get('format') === 'ndjson' ? 'ndjson' : 'binary';

    let audio: Uint8Array;
    let contentType: string;
    let config: S2SConfig;
    let rawConfig: string;
    try {
      const body = await readBody(req, opts.maxBodyBytes ?? MAX_BODY);
      const form = await new Request('http://local/', {
        method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: new Uint8Array(body),
      }).formData();
      const file = form.get('file');
      if (!(file instanceof Blob)) return sendJson(res, 400, { error: { message: 'multipart field "file" (audio) is required', type: 'invalid_request' } });
      audio = new Uint8Array(await file.arrayBuffer());
      contentType = file.type || 'application/octet-stream';
      rawConfig = String(form.get('config') ?? '{}');
      config = JSON.parse(rawConfig) as S2SConfig;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return sendJson(res, status, { error: { message: `bad s2s request: ${(err as Error).message}`, type: 'invalid_request' } });
    }

    const sink = new Sink(res, format);
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(new Error(`s2s budget of ${budgetMs} ms exceeded`)), budgetMs);
    req.on('close', () => { if (!res.writableEnded) budget.abort(new Error('client went away')); });
    const elapsed = () => Math.round(performance.now() - t0);
    const outcome: Record<string, unknown> = {};

    const composite = (lane: Lane, signal: AbortSignal, transcript?: { text: string }) => runComposite({
      stages: opts.stagesFor(req), audio, contentType, config, signal, transcript,
      emitEvent: e => lane.event(e), emitAudio: a => lane.audio(a),
    });

    try {
      // ── 1. primary: a ready replica of the speech-stack deployment ──
      let lease: Awaited<ReturnType<Controller['acquire']>> | null = null;
      let skip: string | null = null;
      if (!opts.controller || !opts.controller.get(deployment)) skip = 'not_found';
      else {
        try {
          lease = await opts.controller.acquire(deployment, { waitMs: 0 });
        } catch (err) {
          if (!(err instanceof DeploymentError)) throw err;
          skip = err.status === 409 ? 'paused' : err.status === 404 ? 'not_found' : 'cold';
          if (skip === 'cold') { try { opts.controller.wake(deployment); } catch { /* vanished */ } }
        }
      }

      if (!lease) {
        const lane = new Lane(sink, true);
        lane.event({ type: 'route', provider: 'composite', fallback: skip, from: `deployment:${deployment}` });
        Object.assign(outcome, { provider: 'composite', fallback: skip });
        await composite(lane, budget.signal);
        return;
      }

      // ── 2. primary streams; hedged by the composed pipeline when its transcript is late ──
      const primarySignal = new AbortController();
      let winner: 'primary' | 'hedge' | null = null;
      let hedge: { lane: Lane; signal: AbortController; run: Promise<unknown> } | null = null;
      const decide = (who: 'primary' | 'hedge') => {
        if (winner) return;
        winner = who;
        if (!hedge) return;
        if (who === 'primary') { hedge.lane.aborted = true; hedge.signal.abort(new Error('lost the hedge')); primaryLane.goLive(); }
        else { primaryLane.aborted = true; primarySignal.abort(new Error('lost the hedge')); sink.dropPrelude(); hedge.lane.goLive(); }
      };
      const primaryLane = new Lane(sink, true, () => decide('primary'));
      primaryLane.event({ type: 'route', provider: `deployment:${deployment}` });
      let heard: string | null = null;
      let primaryError: string | null = null;

      const hedgeTimer = setTimeout(() => {
        if (heard !== null || winner || budget.signal.aborted) return;
        primaryLane.live = false; // nothing was written yet: the transcript is the primary's first event
        const signal = new AbortController();
        const lane = new Lane(sink, false, () => decide('hedge'));
        lane.event({ type: 'route', provider: 'composite', fallback: 'slow', from: `deployment:${deployment}` });
        const run = composite(lane, AbortSignal.any([signal.signal, budget.signal])).catch((err) => {
          if (!lane.aborted) log('s2s: hedge failed', { error: String(err) });
          if (winner === 'hedge') throw err;
        });
        hedge = { lane, signal, run };
        outcome.hedged = true;
      }, hedgeMs);

      try {
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(audio)], { type: contentType }), 'turn');
        form.set('config', rawConfig);
        const upstream = await f(`${replicaBase(lease.machine)}/v1/s2s`, {
          method: 'POST', body: form, headers: { 'X-Aigw-Token': lease.token },
          signal: AbortSignal.any([primarySignal.signal, budget.signal]),
        });
        if (!upstream.ok || !upstream.body) throw new Error(`replica answered HTTP ${upstream.status}`);
        const decoder = new FrameDecoder();
        const reader = upstream.body.getReader();
        let sawDone = false;
        read: for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const frame of decoder.push(value)) {
            if (frame.kind === 'audio') { primaryLane.audio(frame.pcm); continue; }
            const e = frame.event;
            if (e.type === 'error') { primaryError = String(e.message ?? 'error'); break read; }
            if (e.type === 'transcript') heard = String(e.text ?? '');
            if (e.type === 'done') sawDone = true;
            primaryLane.event(e);
          }
        }
        if (!sawDone && !primaryError) primaryError = 'replica stream ended without done';
        if (sawDone && !hedge) decide('primary');
        lease.done(Boolean(primaryError));
      } catch (err) {
        if (winner === 'hedge') lease.done(false);
        else { primaryError = (err as Error).message; lease.done(true); }
      } finally {
        clearTimeout(hedgeTimer);
      }

      const runningHedge = hedge as { lane: Lane; run: Promise<unknown> } | null;
      if (winner === 'primary' && !primaryError) { outcome.provider = `deployment:${deployment}`; return; }
      if (winner === 'hedge' || (runningHedge && !primaryLane.sawAudio)) {
        // The hedge won, or the primary ended (done or broken) without audio while the hedge runs: it takes over.
        decide('hedge');
        await runningHedge!.run;
        Object.assign(outcome, { provider: 'composite', fallback: primaryError ? 'error' : 'slow' });
        return;
      }
      if (!primaryError) { outcome.provider = `deployment:${deployment}`; return; }

      // ── 3. the primary broke and no hedge is running ──
      log('s2s: primary failed', { deployment, error: primaryError, heard: heard !== null, sawAudio: primaryLane.sawAudio });
      if (primaryLane.sawAudio) {
        sink.event({ type: 'error', stage: 'primary', message: primaryError.slice(0, 300), partial: true, at_ms: elapsed() });
        sink.event({ type: 'done', partial: true, transcript: heard, total_ms: elapsed() });
        Object.assign(outcome, { provider: `deployment:${deployment}`, partial: true });
        return;
      }
      const lane = new Lane(sink, true);
      lane.event({ type: 'route', provider: 'composite', fallback: heard !== null ? 'resumed' : 'error', from: `deployment:${deployment}` });
      Object.assign(outcome, { provider: 'composite', fallback: heard !== null ? 'resumed' : 'error' });
      await composite(lane, budget.signal, heard !== null ? { text: heard } : undefined);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      Object.assign(outcome, { error: message.slice(0, 200) });
      if (!sink.hasStarted) {
        sink.closed = true;
        return sendJson(res, (err as { status?: number }).status === 400 ? 400 : 503, {
          error: { message: `No provider could answer speech-to-speech: ${message}`.slice(0, 500), type: 'provider_unavailable', code: 'provider_unavailable' },
        });
      }
      sink.event({ type: 'error', message: message.slice(0, 300), at_ms: elapsed() });
    } finally {
      clearTimeout(budgetTimer);
      log('s2s', { ...outcome, ms: elapsed() });
      sink.end();
    }
  };
}
