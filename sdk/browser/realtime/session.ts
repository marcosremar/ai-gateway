/**
 * `createRealtimeSession` — one learner ↔ NPC conversation over the best transport this network allows:
 *
 *   WebRTC (direct to the GPU, TURN when UDP is blocked) → WebSocket via the gateway → s2s-stream (one HTTP request per
 *   turn, audio streamed back) → plain POST (the caller's `postTurn`).
 *
 * The winner is remembered per network. A transport that breaks mid-session is replaced by the next rung down, with the
 * conversation kept (the client holds the messages and replays them with `config_update`). The browser never holds the
 * gateway key: the session comes from the app's own backend (`sessionEndpoint`), the audio routes are authenticated by
 * the session token.
 */
import { turnEndAfterVadEndMs, type VoiceActivityTuning, type VoiceFrameClassifier } from '../voice/voice-activity';
import { startSileroListener, type SileroListener } from '../voice/silero-listener';
import { createTurnTaking } from '../voice/turn-taking';
import { clipToWav, createTurnClip } from '../voice/turn-clip';
import { configFromToken, isRefusal, requestSession, telemetryUrlOf, type SessionSource } from './descriptor';
import { LadderExhausted, climbLadder, createWinnerMemory, defaultNetworkKey, defaultStorage, orderWithWinner } from './ladder';
import { createLocalTelemetry, newTurnId, type LocalTelemetryOptions, type RealtimeTelemetry } from './telemetry';
import { createWebRtcTransport } from './transports/webrtc';
import { createWsTransport } from './transports/ws';
import { createPostTransport, createS2SStreamTransport, type PostTurn, type S2SEndpoint } from './transports/clip';
import { createVoiceBridge, type VoiceBridge } from './voice-bridge';
import {
  DEFAULT_TIMEOUTS, TRANSPORT_LADDER, type ChatMessage, type ClientMessage, type RealtimeEvent, type RealtimeMetrics,
  type RealtimeTimeouts, type RealtimeTransport, type SessionDescriptor, type StorageLike, type TransportContext,
  type TransportFactory, type TransportType,
} from './types';

export interface RealtimeVoiceOptions {
  classifier: () => Promise<VoiceFrameClassifier>;
  /** The consumer's numbers (the SDK has no defaults for them, as in `@parle/ai-gateway/voice`). */
  endSilenceMs: number;
  maxSpeechMs: number;
  echoTailMs: number;
  tuning?: VoiceActivityTuning;
}

export interface RealtimeSessionOptions {
  /** The app's backend URL that calls `POST /v1/realtime/sessions` server side (POSTed `{transports, prefer}`), or a function. */
  sessionEndpoint: SessionSource;
  sessionInit?: RequestInit;
  getMicStream: () => Promise<MediaStream>;
  onEvent: (event: RealtimeEvent) => void;
  /** The NPC's audio on WebRTC (null when it ends). Absent: played by an `<audio>` element the SDK creates. */
  onRemoteAudio?: (stream: MediaStream | null) => void;
  playoutDelayMs?: number;
  preferredTransports?: TransportType[];
  timeouts?: Partial<RealtimeTimeouts>;
  /** Where the winner is remembered (default `localStorage`, guarded); null = never remembered. */
  storage?: StorageLike | null;
  networkKey?: () => string;
  /** Session config for the clip rungs when no session could be admitted (the token's `cfg` otherwise). */
  config?: Record<string, unknown>;
  s2s?: S2SEndpoint;
  postTurn?: PostTurn;
  /** Client VAD: `end_turn`, barge-in `interrupt`, and the turn clips of the clip rungs. */
  voice?: RealtimeVoiceOptions;
  /** A shared emitter, options of the local one, or false (no telemetry sent). */
  telemetry?: RealtimeTelemetry | LocalTelemetryOptions | false;
  maxFailovers?: number;
  fetchImpl?: typeof fetch;
  /** Replace a rung's transport (tests, custom transports). */
  transports?: Partial<Record<TransportType, TransportFactory>>;
}

export interface RealtimeSession {
  connect(): Promise<TransportType>;
  /** Client VAD said the learner stopped (realtime rungs). */
  sendEndTurn(): void;
  interrupt(): void;
  /** Appends messages to the conversation (and tells the edge). */
  updateHistory(messages: ChatMessage[]): void;
  /** Clip rungs: one recorded learner turn (16 kHz WAV). Realtime rungs ignore it (their audio is live). */
  sendTurn(wav: Blob): Promise<void>;
  close(): void;
  readonly transport: TransportType | null;
  readonly metrics: RealtimeMetrics;
  readonly traceId: string;
  readonly sessionId: string | null;
  readonly history: ChatMessage[];
}

const isRealtime = (t: TransportType) => t === 'webrtc' || t === 'ws';

function playRemote(stream: MediaStream | null, el: { current: HTMLAudioElement | null }): void {
  if (typeof document === 'undefined') return;
  if (!stream) { if (el.current) { el.current.srcObject = null; el.current.remove(); el.current = null; } return; }
  if (!el.current) { el.current = document.createElement('audio'); el.current.autoplay = true; el.current.style.display = 'none'; document.body.appendChild(el.current); }
  el.current.srcObject = stream;
  void el.current.play().catch(() => {});
}

export function createRealtimeSession(opts: RealtimeSessionOptions): RealtimeSession {
  const timeouts: RealtimeTimeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  const fetchImpl = opts.fetchImpl ?? (((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch);
  const telemetry: RealtimeTelemetry = opts.telemetry && 'emit' in opts.telemetry ? opts.telemetry
    : createLocalTelemetry({ fetchImpl, ...(opts.telemetry === false ? { send: false } : opts.telemetry ?? {}) });
  const memory = createWinnerMemory(opts.storage === undefined ? defaultStorage() : opts.storage);
  const network = () => { try { return opts.networkKey?.() ?? defaultNetworkKey(); } catch { return 'default'; } };
  const metrics: RealtimeMetrics = { transport: null, connectMs: null, attempts: [], failovers: 0, droppedFrames: 0, lastTurn: null };
  const appended: ChatMessage[] = [];
  const audioEl = { current: null as HTMLAudioElement | null };
  let descriptor: SessionDescriptor | null = null;
  let current: RealtimeTransport | null = null;
  let order: TransportType[] = [];
  let closed = false;
  let switching: Promise<void> | null = null;
  let npcSpeaking = false;
  let turn: { id: string; endAt: number; firstAudio: boolean } | null = null;
  let mic: Promise<MediaStream> | null = null;
  let bridge: VoiceBridge | null = null;
  let voiceStop: (() => void) | null = null;

  const baseConfig = () => (descriptor ? configFromToken(descriptor.token) : null) ?? opts.config ?? {};
  const config = () => {
    const base = baseConfig();
    const prior = Array.isArray(base.messages) ? base.messages as ChatMessage[] : [];
    return { ...base, messages: [...prior, ...appended] };
  };

  const startTurn = () => { turn = { id: newTurnId(), endAt: performance.now(), firstAudio: false }; return turn; };

  /** Events of the transport → history, speaking state, turn telemetry → the page. */
  const emit = (e: RealtimeEvent) => {
    if (closed && e.type !== 'closed') return;
    if (e.type === 'transcript' && e.final) {
      if (!turn) startTurn();
      if (e.text) appended.push({ role: 'user', content: e.text });
    }
    if (e.type === 'reply' && e.text) appended.push({ role: 'assistant', content: e.text });
    if (e.type === 'audio_start') {
      npcSpeaking = true;
      if (turn && !turn.firstAudio) {
        turn.firstAudio = true;
        telemetry.emit('turn.first_audio', { turnId: turn.id, durMs: performance.now() - turn.endAt, attrs: { transport: current?.type ?? null } });
      }
    }
    if (e.type === 'audio_end' || e.type === 'interrupted') npcSpeaking = false;
    if (e.type === 'metrics') metrics.lastTurn = { ttfa_ms: e.ttfa_ms, stt_ms: e.stt_ms, llm_ttft_ms: e.llm_ttft_ms, tts_ttfb_ms: e.tts_ttfb_ms };
    if (e.type === 'done') {
      if (turn) telemetry.emit('turn.done', { turnId: turn.id, durMs: performance.now() - turn.endAt, attrs: { empty: !!e.empty, filtered: !!e.filtered, transport: current?.type ?? null } });
      turn = null;
    }
    if (e.type === 'error') telemetry.emit('error', { level: 'error', turnId: turn?.id, attrs: { code: e.code, transport: current?.type ?? null } });
    try { opts.onEvent(e); } catch { /* the page's handler */ }
  };

  const ctx: TransportContext = {
    get descriptor() { return descriptor; },
    timeouts, fetchImpl, telemetry,
    playoutDelayMs: opts.playoutDelayMs,
    get traceparent() { return telemetry.traceparent; },
    mic: () => (mic ??= opts.getMicStream()),
    emit,
    fail: (err) => { const t = current; if (t) void failover(t.type, err); },
    remoteAudio: (stream) => (opts.onRemoteAudio ? opts.onRemoteAudio(stream) : playRemote(stream, audioEl)),
    config,
    dropped: (n) => { metrics.droppedFrames += n; },
  };

  const factories: Record<TransportType, TransportFactory> = {
    webrtc: (c) => { const o = c.descriptor?.transports.find(t => t.type === 'webrtc'); return o && o.type === 'webrtc' ? createWebRtcTransport(c, o) : null; },
    ws: (c) => { const o = c.descriptor?.transports.find(t => t.type === 'ws'); return o && o.type === 'ws' ? createWsTransport(c, o.url) : null; },
    's2s-stream': (c) => (opts.s2s ? createS2SStreamTransport(c, opts.s2s) : null),
    post: (c) => (opts.postTurn ? createPostTransport(c, opts.postTurn) : null),
    ...opts.transports,
  };

  async function admit(rungs: TransportType[]): Promise<void> {
    const wanted = rungs.filter(isRealtime);
    if (!wanted.length) return;
    const started = performance.now();
    const answer = await requestSession(opts.sessionEndpoint, { transports: rungs, prefer: wanted[0] }, {
      traceparent: telemetry.traceparent, timeoutMs: timeouts.sessionMs, fetchImpl, init: opts.sessionInit,
    });
    if (isRefusal(answer)) {
      descriptor = null;
      telemetry.emit('rt.session.rejected', { level: 'warn', durMs: performance.now() - started, attrs: { reason: answer.code, status: answer.status, retryAfter: answer.retryAfterSeconds ?? null } });
      return;
    }
    descriptor = answer;
    telemetry.bind(answer.sessionId, answer.token, telemetryUrlOf(answer));
    telemetry.emit('rt.session.admitted', { durMs: performance.now() - started, attrs: { transports: answer.transports.length } });
  }

  async function establish(rungs: TransportType[], reason: 'connected' | 'failover', from?: TransportType): Promise<void> {
    const started = performance.now();
    if (rungs.some(isRealtime)) await admit(rungs);
    if (closed) return;
    // Realtime rungs only with an admitted session that offers them (a refusal sends the client straight down).
    const offered = new Set(descriptor?.transports.map(t => t.type) ?? []);
    const usable = rungs.filter(t => !isRealtime(t) || offered.has(t));
    let last: TransportType | null = from ?? null;
    try {
      const { transport, attempts } = await climbLadder(usable, (t) => factories[t](ctx), {
        timeouts,
        onTry: (t) => telemetry.emit('rt.ladder.try', { attrs: { transport: t } }),
        onAttempt: (a) => {
          metrics.attempts.push(a);
          if (!a.ok) {
            const next = usable[usable.indexOf(a.type) + 1] ?? null;
            telemetry.emit('rt.ladder.fallback', { level: 'warn', durMs: a.ms, attrs: { from: a.type, to: next, reason: (a.error ?? 'failed').slice(0, 64) } });
          }
          last = a.type;
        },
      });
      void attempts;
      if (closed) { transport.close(); return; }
      current = transport;
      metrics.transport = transport.type;
      if (reason === 'connected') metrics.connectMs = Math.round(performance.now() - started);
      memory.set(network(), transport.type);
      telemetry.emit('rt.ladder.ok', { durMs: performance.now() - started, attrs: { transport: transport.type, reason } });
      if (!transport.clipBased && appended.length) transport.send({ type: 'config_update', messages: [...appended] });
      emit({ type: 'transport', transport: transport.type, reason, ...(from ? { from } : {}) });
    } catch (err) {
      const message = err instanceof LadderExhausted ? err.message : (err as Error).message;
      telemetry.emit('error', { level: 'error', attrs: { code: 'no_transport', last } });
      emit({ type: 'error', code: 'no_transport', message });
      close('no transport');
      throw err;
    }
  }

  async function failover(from: TransportType, err: Error): Promise<void> {
    if (closed) return;
    if (switching) return switching;
    switching = (async () => {
      current?.close();
      current = null;
      npcSpeaking = false;
      bridge?.reset();
      metrics.failovers++;
      const rest = order.slice(order.indexOf(from) + 1);
      telemetry.emit('rt.ladder.fallback', { level: 'warn', attrs: { from, to: rest[0] ?? null, reason: err.message.slice(0, 64), midSession: true } });
      if (metrics.failovers > (opts.maxFailovers ?? 4) || !rest.length) {
        emit({ type: 'error', code: 'no_transport', message: `transport ${from} failed and no rung is left: ${err.message}` });
        close('failover exhausted');
        return;
      }
      await establish(rest, 'failover', from).catch(() => {});
    })().finally(() => { switching = null; });
    return switching;
  }

  async function startVoice(v: RealtimeVoiceOptions): Promise<void> {
    const stream = await ctx.mic();
    const audio = new AudioContext();
    const track = stream.getAudioTracks()[0];
    const turns = track ? createTurnTaking({
      clip: createTurnClip(), track: () => track, toWav: (clip) => clipToWav(clip, audio),
      endSilenceMs: v.endSilenceMs, maxSpeechMs: v.maxSpeechMs, echoTailMs: v.echoTailMs, tuning: v.tuning,
      onVoice: () => {}, onTurn: (wav) => { void session.sendTurn(wav); },
    }) : null;
    turns?.setListening(true);
    bridge = createVoiceBridge({
      endAfterVadEndMs: turnEndAfterVadEndMs(v.endSilenceMs, v.tuning),
      npcSpeaking: () => npcSpeaking,
      clipMode: () => !!current?.clipBased,
      onInterrupt: () => session.interrupt(),
      onEndTurn: () => session.sendEndTurn(),
      onClipEffect: (e) => turns?.onEffect(e),
      onSegment: (ms) => telemetry.emit('vad.segment', { durMs: ms }),
    });
    const listener: SileroListener = await startSileroListener(await v.classifier(), (e) => bridge?.onEffect(e), v.tuning);
    listener.connect(stream);
    voiceStop = () => { listener.stop(); turns?.drop(); void audio.close().catch(() => {}); };
  }

  function close(reason = 'closed'): void {
    if (closed) return;
    closed = true;
    bridge?.reset();
    voiceStop?.();
    current?.close();
    current = null;
    telemetry.emit('rt.session.closed', { attrs: { reason: reason.slice(0, 64), failovers: metrics.failovers } });
    telemetry.close();
    emit({ type: 'closed', reason });
  }

  const session: RealtimeSession = {
    async connect() {
      const base = (opts.preferredTransports ?? [...TRANSPORT_LADDER]).filter((t, i, a) => a.indexOf(t) === i);
      order = orderWithWinner(base, memory.get(network()));
      await establish(order, 'connected');
      if (opts.voice && !closed) await startVoice(opts.voice);
      return current!.type;
    },
    sendEndTurn() {
      if (!current || current.clipBased) return;
      startTurn();
      current.send({ type: 'end_turn' } satisfies ClientMessage);
    },
    interrupt() {
      current?.send({ type: 'interrupt' });
    },
    updateHistory(messages) {
      appended.push(...messages);
      if (current && !current.clipBased) current.send({ type: 'config_update', messages });
    },
    async sendTurn(wav) {
      if (!current?.clipBased || closed) return;
      startTurn();
      try {
        await current.sendTurn!(wav);
      } catch (err) {
        if (closed || (err as Error).message === 'interrupted') return;
        await failover(current?.type ?? order[order.length - 1]!, err as Error);
        const next = current as RealtimeTransport | null;
        if (next?.clipBased && !closed) await next.sendTurn!(wav).catch((e2: Error) => emit({ type: 'error', code: 'turn_failed', message: e2.message }));
      }
    },
    close: () => close('closed by the page'),
    get transport() { return current?.type ?? null; },
    get metrics() { return metrics; },
    get traceId() { return telemetry.traceId; },
    get sessionId() { return descriptor?.sessionId ?? null; },
    get history() { return [...appended]; },
  };
  return session;
}
