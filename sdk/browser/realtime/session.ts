/**
 * `createRealtimeSession` — one learner ↔ NPC conversation over the best transport this network allows:
 *
 *   WebRTC (direct to the GPU, TURN when UDP is blocked) → WebSocket via the gateway → s2s-stream (one HTTP request per
 *   turn, audio streamed back) → plain POST (the caller's `postTurn`).
 *
 * When a session offers both WebRTC and WS they are started together: the session is usable on whichever is up first
 * (WS, almost always) and moves to WebRTC between turns once it connects. The winner is remembered per network. A
 * session that starts on a clip rung because admission answered `saturated` or `cold` keeps asking in the background
 * and moves to the realtime rung between turns once it is admitted (the same move). A
 * transport that breaks mid-session is replaced by the next rung down, with the
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
import { createPcmPlayer, decodeClip, type DecodedClip, type PcmPlayer } from './audio-io';
import { DOWNSTREAM_RATE, trimLeadingSilence } from './pcm';
import {
  DEFAULT_TIMEOUTS, TRANSPORT_LADDER, type SessionRefusal, type AttemptRecord, type ChatMessage, type ClientMessage, type RealtimeEvent, type RealtimeMetrics,
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

export type SpeakText = (text: string, ctx: { config: Record<string, unknown>; traceparent: string; signal: AbortSignal }) => Promise<Blob | ArrayBuffer>;

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
  speak?: SpeakText;
  createPlayer?: (opts: { rate: number }) => Promise<PcmPlayer>;
  decodeAudio?: (data: ArrayBuffer) => Promise<DecodedClip>;
  /** Client VAD: `end_turn`, barge-in `interrupt`, and the turn clips of the clip rungs. */
  voice?: RealtimeVoiceOptions;
  /** A shared emitter, options of the local one, or false (no telemetry sent). */
  telemetry?: RealtimeTelemetry | LocalTelemetryOptions | false;
  maxFailovers?: number;
  raceTransports?: boolean;
  readmit?: boolean;
  fetchImpl?: typeof fetch;
  /** Replace a rung's transport (tests, custom transports). */
  transports?: Partial<Record<TransportType, TransportFactory>>;
}

export interface RealtimeSession {
  connect(): Promise<TransportType>;
  /** Client VAD said the learner stopped (realtime rungs). */
  sendEndTurn(): void;
  interrupt(): void;
  /** Appends user / assistant messages to the conversation (and tells the edge); a `system` message is dropped: the signed session config owns the prompt. */
  updateHistory(messages: ChatMessage[]): void;
  /** Hands the edge an update the gateway signed for the app (`POST /v1/realtime/updates`); `history` replaces the turns this session replays. */
  applyUpdate(signed: string, history?: ChatMessage[]): void;
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
const HEARD_WITHOUT_TURN_MS = 2_000;
const UPGRADE_SETTLE_MS = 300;
const UPGRADE_POLL_MS = 100;
const DEFAULT_DEADLINE_MS = 2_000;
const MAX_DEADLINE_MS = 2_500;
const OPENER_MARGIN_MS = 100;
const MAX_OPENER_CLIPS = 2;

interface Turn {
  id: string;
  endAt: number;
  speechEnd: number | null;
  firstAudio: boolean;
  soundMs?: number;
  serverSoundMs?: number;
  networkMs?: number | null;
  sound?: boolean;
  localOpener?: boolean;
  provider?: string;
  fallback?: string;
}

interface OpenerClip extends DecodedClip {
  index: number;
  text: string;
}

interface Standby {
  live: boolean;
  audio: MediaStream | null;
}

interface Upgrade {
  rtc: Promise<RealtimeTransport | null>;
  abort: AbortController;
  standby: Standby;
  connected: RealtimeTransport | null;
}

interface Recovery {
  error: Extract<RealtimeEvent, { type: 'error' }>;
  audio: Promise<Blob | ArrayBuffer>;
  abort: AbortController;
  playing: boolean;
}

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
  let turn: Turn | null = null;
  let mic: Promise<MediaStream> | null = null;
  let bridge: VoiceBridge | null = null;
  let voiceStop: (() => void) | null = null;
  let recovery: Recovery | null = null;
  let localPlayer: PcmPlayer | null = null;
  let localPlayerOpening: Promise<PcmPlayer> | null = null;
  const clips: OpenerClip[] = [];
  let lastOpener = -1;
  let serverOpenerOff = false;
  let heardAt: number | null = null;
  let cacheAbort: AbortController | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let playingOpener: { index: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let upgrade: Upgrade | null = null;
  let readmitTimer: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0;
  let quietSince = 0;
  let heardUntil = 0;

  const baseConfig = () => (descriptor ? configFromToken(descriptor.token, descriptor.cfg) : null) ?? opts.config ?? {};
  const config = () => {
    const base = baseConfig();
    const prior = Array.isArray(base.messages) ? base.messages as ChatMessage[] : [];
    const endpoint = opts.voice && base.endpoint_ms === undefined ? { endpoint_ms: opts.voice.endSilenceMs } : {};
    return { ...base, ...endpoint, messages: [...prior, ...appended] };
  };

  const endpointMs = () => opts.voice?.endSilenceMs ?? (Number(baseConfig().endpoint_ms) || 0);
  const deadlineMs = () => {
    const asked = Number(baseConfig().first_audio_deadline_ms);
    return Math.min(MAX_DEADLINE_MS, asked > 0 ? asked : DEFAULT_DEADLINE_MS);
  };

  const openLocalPlayer = () => (localPlayerOpening ??= (opts.createPlayer ?? createPcmPlayer)({ rate: DOWNSTREAM_RATE }).then(
    (p) => { if (closed) p.close(); return (localPlayer = p); },
    (err) => { localPlayerOpening = null; throw err; },
  ));

  const restoreServerOpener = () => {
    if (serverOpenerOff && current && !current.clipBased) current.send({ type: 'config_update', opener: baseConfig().opener ?? null });
    serverOpenerOff = false;
  };

  const startTurn = (speechEnded = false) => {
    clearTimeout(deadlineTimer);
    restoreServerOpener();
    const now = performance.now();
    const started: Turn = { id: newTurnId(), endAt: now, speechEnd: speechEnded ? now - endpointMs() : null, firstAudio: false };
    turn = started;
    if (speechEnded && clips.length) {
      const due = Math.min(deadlineMs(), MAX_DEADLINE_MS - OPENER_MARGIN_MS) - endpointMs();
      deadlineTimer = setTimeout(() => { void playOpener(started); }, Math.max(0, due));
    }
    return started;
  };

  const firstSound = (source: 'reply' | 'opener' | 'client_opener') => {
    if (!turn) return;
    clearTimeout(deadlineTimer);
    const ms = turn.speechEnd === null ? null : Math.round(performance.now() - turn.speechEnd);
    if (source !== 'client_opener' && ms !== null) turn.serverSoundMs ??= ms;
    if (turn.sound) return;
    turn.sound = true;
    if (ms === null) return;
    turn.soundMs = ms;
    telemetry.emit('turn.first_sound', { turnId: turn.id, durMs: turn.soundMs, attrs: { source, transport: current?.type ?? null, uplinkBufferedBytes: current?.uplinkBacklog?.() ?? null } });
  };

  const endOpener = (cut: boolean) => {
    const opener = playingOpener;
    if (!opener) return;
    playingOpener = null;
    clearTimeout(opener.timer);
    if (cut) localPlayer?.flush();
    emit({ type: 'opener', state: 'end', index: opener.index, local: true });
    if (!turn?.firstAudio) emit({ type: 'audio_end' });
  };

  async function playOpener(t: Turn): Promise<void> {
    const transport = current;
    if (turn !== t || t.sound || closed || !transport) return;
    const player = transport.playOpener ? null : await openLocalPlayer().catch(() => null);
    if (turn !== t || t.sound || closed || current !== transport || (!player && !transport.playOpener)) return;
    const clip = clips.find(c => c.index > lastOpener) ?? clips[0]!;
    t.localOpener = true;
    const audioMs = Math.round((clip.samples.length / clip.rate) * 1000);
    if (player) player.pushFloat(clip.samples.slice(), clip.rate);
    else transport.playOpener!(clip.samples.slice(), clip.rate);
    if (!transport.clipBased) { transport.send({ type: 'config_update', opener: null }); serverOpenerOff = true; }
    emit({ type: 'opener', state: 'start', text: clip.text, index: clip.index, audio_ms: audioMs, local: true });
    playingOpener = { index: clip.index, timer: setTimeout(() => endOpener(false), audioMs) };
  }

  async function cacheOpeners(): Promise<void> {
    const authored = (baseConfig().opener as { lines?: unknown } | null | undefined)?.lines;
    if (!opts.speak || !Array.isArray(authored)) return;
    const lines = authored.filter((l): l is string => typeof l === 'string' && !!l.trim()).map(l => l.trim()).slice(0, MAX_OPENER_CLIPS);
    const abort = new AbortController();
    cacheAbort = abort;
    for (const [index, text] of lines.entries()) {
      try {
        const audio = await opts.speak(text, { config: config(), traceparent: telemetry.traceparent, signal: abort.signal });
        const clip = await (opts.decodeAudio ?? decodeClip)(audio instanceof Blob ? await audio.arrayBuffer() : audio);
        if (closed) return;
        clips.push({ index, text, rate: clip.rate, samples: trimLeadingSilence(clip.samples, clip.rate) });
      } catch { if (closed) return; }
    }
    telemetry.emit('rt.opener.cached', { level: clips.length < lines.length ? 'warn' : 'info', attrs: { clips: clips.length, lines: lines.length } });
    if (clips.length && current && !current.playOpener) void openLocalPlayer().catch(() => {});
  }

  /** Events of the transport → history, speaking state, turn telemetry → the page. */
  const emit = (e: RealtimeEvent) => {
    if (closed && e.type !== 'closed') return;
    if (e.type === 'deadline_missed' && turn?.localOpener) return;
    if (playingOpener && !current?.playOpener && (e.type === 'audio_start' || (e.type === 'opener' && e.state === 'start' && !e.local))) endOpener(true);
    if (e.type === 'transcript' && e.final) {
      if (!turn) startTurn();
      if (e.text) heardAt = appended.push({ role: 'user', content: e.text }) - 1;
    }
    if (e.type === 'intercept' && heardAt !== null) appended.splice(heardAt, 1);
    if (e.type === 'reply' && e.text) appended.push({ role: 'assistant', content: e.text });
    if (e.type === 'route' && turn) Object.assign(turn, { provider: e.provider, fallback: e.fallback });
    if (e.type === 'audio_start') {
      npcSpeaking = true;
      firstSound('reply');
      if (turn && !turn.firstAudio) {
        turn.firstAudio = true;
        const fromSpeechMs = turn.speechEnd === null ? null : Math.round(performance.now() - turn.speechEnd);
        telemetry.emit('turn.first_audio', { turnId: turn.id, durMs: performance.now() - turn.endAt, attrs: { transport: current?.type ?? null, fromSpeechMs } });
      }
    }
    if (e.type === 'opener' && e.state === 'start') {
      npcSpeaking = true;
      lastOpener = e.index ?? lastOpener;
      firstSound(e.local ? 'client_opener' : 'opener');
      telemetry.emit('turn.opener', {
        turnId: turn?.id, durMs: turn ? performance.now() - turn.endAt : undefined,
        attrs: { index: e.index ?? null, transport: current?.type ?? null, source: e.local ? 'client' : 'server', fromSpeechMs: turn?.soundMs ?? null },
      });
    }
    if (e.type === 'deadline_missed') telemetry.emit('turn.deadline_missed', { level: 'warn', turnId: turn?.id, attrs: { deadlineMs: e.deadline_ms, transport: current?.type ?? null } });
    if (e.type === 'vad') heardUntil = e.state === 'start' ? Infinity : performance.now() + HEARD_WITHOUT_TURN_MS;
    if (e.type === 'audio_end' || e.type === 'interrupted') { npcSpeaking = false; quietSince = performance.now(); }
    if (e.type === 'metrics') {
      const network = typeof turn?.serverSoundMs === 'number' && typeof e.first_sound_from_speech_ms === 'number' ? turn.serverSoundMs - e.first_sound_from_speech_ms : null;
      if (turn) turn.networkMs = network;
      metrics.lastTurn = {
        ttfa_ms: e.ttfa_ms, stt_ms: e.stt_ms, llm_ttft_ms: e.llm_ttft_ms, tts_ttfb_ms: e.tts_ttfb_ms,
        first_sound_ms: e.first_sound_ms, opener: e.opener, deadline_missed: e.deadline_missed,
        learner_first_sound_ms: turn?.soundMs ?? null, network_delay_ms: network,
      };
    }
    if (e.type === 'done') {
      heardAt = null;
      if (e.served && metrics.lastTurn) metrics.lastTurn.served = e.served;
      clearTimeout(deadlineTimer);
      if (turn?.localOpener) restoreServerOpener();
      if (turn) {
        telemetry.emit('turn.done', { turnId: turn.id, durMs: performance.now() - turn.endAt, attrs: {
          empty: !!e.empty, filtered: !!e.filtered, transport: current?.type ?? null, provider: turn.provider ?? null, fallback: turn.fallback ?? null,
          firstSoundMs: turn.soundMs ?? null, networkDelayMs: turn.networkMs ?? null, clientOpener: !!turn.localOpener,
        } });
      }
      turn = null;
      heardUntil = 0;
      quietSince = performance.now();
    }
    if (e.type === 'transport' && clips.length && !current?.playOpener) void openLocalPlayer().catch(() => {});
    if (e.type === 'error') telemetry.emit('error', { level: 'error', turnId: turn?.id, attrs: { code: e.code, transport: current?.type ?? null } });
    try { opts.onEvent(e); } catch { /* the page's handler */ }
  };

  const cancelRecovery = () => {
    const r = recovery;
    recovery = null;
    r?.abort.abort();
    localPlayer?.flush();
    return r;
  };

  async function recover(r: Recovery): Promise<void> {
    r.playing = true;
    const timer = setTimeout(() => r.abort.abort(), timeouts.turnMs);
    const aborted = new Promise<never>((_, reject) => r.abort.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    try {
      await Promise.race([aborted, (async () => {
        const audio = await r.audio;
        const player = await openLocalPlayer();
        if (recovery !== r) return;
        await player.pushEncoded(audio instanceof Blob ? await audio.arrayBuffer() : audio);
        if (recovery !== r) return;
        if (!npcSpeaking) emit({ type: 'audio_start' });
        telemetry.emit('turn.recovered', { turnId: turn?.id, attrs: { transport: current?.type ?? null } });
        emit({ type: 'recovered' });
        await player.idle();
      })()]);
      if (recovery !== r) return;
      recovery = null;
      emit({ type: 'audio_end' });
      emit({ type: 'done' });
    } catch {
      if (recovery !== r) return;
      cancelRecovery();
      emit(r.error);
      emit({ type: 'done', error: true });
    } finally {
      clearTimeout(timer);
    }
  }

  const fromTransport = (e: RealtimeEvent) => {
    if (e.type === 'error' && e.unspoken && opts.speak && !recovery) {
      const abort = new AbortController();
      const audio = Promise.resolve().then(() => opts.speak!(e.unspoken!, { config: config(), traceparent: telemetry.traceparent, signal: abort.signal }));
      audio.catch(() => {});
      recovery = { error: e, audio, abort, playing: false };
      return;
    }
    if (e.type === 'done' && e.error && recovery && !recovery.playing) { void recover(recovery); return; }
    emit(e);
  };

  const ctx: TransportContext = {
    get descriptor() { return descriptor; },
    timeouts, fetchImpl, telemetry,
    playoutDelayMs: opts.playoutDelayMs,
    get traceparent() { return telemetry.traceparent; },
    mic: () => (mic ??= opts.getMicStream()),
    emit: fromTransport,
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

  async function admit(rungs: TransportType[]): Promise<SessionRefusal | null> {
    const wanted = rungs.filter(isRealtime);
    if (!wanted.length) return null;
    const started = performance.now();
    const answer = await requestSession(opts.sessionEndpoint, { transports: rungs, prefer: wanted[0] }, {
      traceparent: telemetry.traceparent, timeoutMs: timeouts.sessionMs, fetchImpl, init: opts.sessionInit,
    });
    if (isRefusal(answer)) {
      descriptor = null;
      telemetry.emit('rt.session.rejected', { level: 'warn', durMs: performance.now() - started, attrs: { reason: answer.code, status: answer.status, retryAfter: answer.retryAfterSeconds ?? null } });
      return answer;
    }
    descriptor = answer;
    telemetry.bind(answer.sessionId, answer.token, telemetryUrlOf(answer));
    telemetry.emit('rt.session.admitted', { durMs: performance.now() - started, attrs: { transports: answer.transports.length } });
    return null;
  }

  const busy = () => !!turn || npcSpeaking || !!recovery || !!switching || !!bridge?.speaking() || performance.now() < heardUntil;

  const goLive = (transport: RealtimeTransport, standby: Standby) => {
    standby.live = true;
    transport.goLive?.();
    if (standby.audio) ctx.remoteAudio(standby.audio);
  };

  const dropUpgrade = (why: string) => {
    const up = upgrade;
    upgrade = null;
    up?.abort.abort(new Error(why));
    up?.connected?.close();
  };

  const standbyContext = (standby: Standby): TransportContext => Object.assign(Object.create(ctx) as TransportContext, {
    standby: true,
    emit: (e: RealtimeEvent) => { if (standby.live) ctx.emit(e); },
    fail: (err: Error) => { if (standby.live) ctx.fail(err); else if (upgrade?.standby === standby) dropUpgrade(err.message); },
    remoteAudio: (stream: MediaStream | null) => { if (standby.live) ctx.remoteAudio(stream); else standby.audio = stream; },
  });

  function promote(up: Upgrade, reason: 'upgrade' | 'failover', from: TransportType): void {
    const rtc = up.connected!;
    upgrade = null;
    current?.close();
    current = rtc;
    goLive(rtc, up.standby);
    metrics.transport = rtc.type;
    memory.set(network(), rtc.type);
    telemetry.emit('rt.ladder.upgrade', { durMs: performance.now() - startedAt, attrs: { from, to: rtc.type, reason } });
    if (appended.length) rtc.send({ type: 'config_update', messages: [...appended] });
    emit({ type: 'transport', transport: rtc.type, reason, from });
  }

  const upgradeWhenQuiet = (up: Upgrade) => {
    if (upgrade !== up || closed) return;
    if (busy() || performance.now() - quietSince < UPGRADE_SETTLE_MS) { setTimeout(() => upgradeWhenQuiet(up), UPGRADE_POLL_MS); return; }
    promote(up, 'upgrade', current?.type ?? 'ws');
  };

  function watchUpgrade(up: Upgrade): void {
    upgrade = up;
    const bound = setTimeout(() => up.abort.abort(new Error(`webrtc not connected within ${timeouts.upgradeMs} ms of the start on ws`)), timeouts.upgradeMs);
    void up.rtc.then((rtc) => {
      clearTimeout(bound);
      if (upgrade !== up) { rtc?.close(); return; }
      if (!rtc) { upgrade = null; memory.set(network(), 'ws'); return; }
      up.connected = rtc;
      upgradeWhenQuiet(up);
    });
  }

  const canReadmit = (r: SessionRefusal) => opts.readmit !== false && (r.code === 'saturated' || r.code === 'cold');

  async function readmit(rungs: TransportType[], first: SessionRefusal): Promise<void> {
    const giveUp = (reason: string) => telemetry.emit('rt.readmit.gave_up', { level: 'warn', attrs: { reason } });
    const deadline = performance.now() + timeouts.readmitForMs;
    let wait = timeouts.readmitMs;
    for (let refusal: SessionRefusal | null = first; refusal; refusal = await admit(rungs)) {
      if (closed || !current?.clipBased) return;
      if (!canReadmit(refusal)) return giveUp(refusal.code);
      wait = Math.min(timeouts.readmitMaxMs, Math.max(wait, (refusal.retryAfterSeconds ?? 0) * 1000));
      if (performance.now() + wait > deadline) return giveUp('deadline');
      await new Promise<void>((resolve) => { readmitTimer = setTimeout(resolve, wait); });
      wait *= 1.5;
      if (closed || !current?.clipBased) return;
    }
    if (closed || !current?.clipBased) return;
    const standby: Standby = { live: false, audio: null };
    const abort = new AbortController();
    const context = standbyContext(standby);
    const offered = rungs.filter(t => descriptor?.transports.some(o => o.type === t));
    const up: Upgrade = {
      rtc: climbLadder(offered, t => factories[t](context), { timeouts, signal: abort.signal }).then(r => r.transport, () => null),
      abort, standby, connected: null,
    };
    upgrade = up;
    const transport = await up.rtc;
    if (upgrade !== up) { transport?.close(); return; }
    if (!transport) { upgrade = null; return giveUp('no_transport'); }
    up.connected = transport;
    upgradeWhenQuiet(up);
  }

  type Climb = Parameters<typeof climbLadder>[2];

  async function raceStart(usable: TransportType[], climb: Climb): Promise<{ transport: RealtimeTransport; pending?: Upgrade }> {
    const standby: Standby = { live: false, audio: null };
    const aborts = { webrtc: new AbortController(), ws: new AbortController() };
    const attempt = (type: 'webrtc' | 'ws', c: TransportContext) =>
      climbLadder([type], t => factories[t](c), { ...climb, signal: aborts[type].signal }).then(r => r.transport, () => null);
    const rtc = attempt('webrtc', standbyContext(standby));
    const ws = attempt('ws', ctx);
    const first = await Promise.race([rtc.then(t => t ?? ws), ws.then(t => t ?? rtc)]);
    if (!first) return { transport: (await climbLadder(usable.filter(t => !isRealtime(t)), t => factories[t](ctx), climb)).transport };
    if (first.type === 'ws') return { transport: first, pending: { rtc, abort: aborts.webrtc, standby, connected: null } };
    aborts.ws.abort(new Error('webrtc connected first'));
    void ws.then(t => t?.close());
    goLive(first, standby);
    return { transport: first };
  }

  async function establish(rungs: TransportType[], reason: 'connected' | 'failover', from?: TransportType): Promise<void> {
    const started = performance.now();
    const refusal = await admit(rungs);
    if (closed) return;
    // Realtime rungs only with an admitted session that offers them (a refusal sends the client straight down).
    const offered = new Set(descriptor?.transports.map(t => t.type) ?? []);
    const usable = rungs.filter(t => !isRealtime(t) || offered.has(t));
    const racing = reason === 'connected' && opts.raceTransports !== false && usable[0] === 'webrtc' && usable.includes('ws');
    const attempts: AttemptRecord[] = [];
    let last: TransportType | null = from ?? null;
    try {
      const climb: Climb = {
        timeouts,
        onTry: (t) => telemetry.emit('rt.ladder.try', { attrs: { transport: t } }),
        onAttempt: (a) => {
          metrics.attempts.push(a);
          attempts.push(a);
          if (!a.ok) {
            const next = racing && isRealtime(a.type) ? (a.type === 'ws' ? 'webrtc' : 'ws') : usable[usable.indexOf(a.type) + 1] ?? null;
            telemetry.emit('rt.ladder.fallback', { level: 'warn', durMs: a.ms, attrs: { from: a.type, to: next, reason: (a.error ?? 'failed').slice(0, 64) } });
          }
          last = a.type;
        },
      };
      const { transport, pending } = racing
        ? await raceStart(usable, climb).catch((err) => { throw err instanceof LadderExhausted ? new LadderExhausted(attempts) : err; })
        : { transport: (await climbLadder(usable, (t) => factories[t](ctx), climb)).transport, pending: undefined };
      if (closed) { transport.close(); pending?.abort.abort(new Error('session closed')); void pending?.rtc.then(t => t?.close()); return; }
      current = transport;
      startedAt = performance.now();
      metrics.transport = transport.type;
      if (reason === 'connected') metrics.connectMs = Math.round(startedAt - started);
      if (!pending && !refusal) memory.set(network(), transport.type);
      telemetry.emit('rt.ladder.ok', { durMs: startedAt - started, attrs: { transport: transport.type, reason, upgrading: !!pending } });
      if (!transport.clipBased && appended.length) transport.send({ type: 'config_update', messages: [...appended] });
      emit({ type: 'transport', transport: transport.type, reason, ...(from ? { from } : {}) });
      if (pending) watchUpgrade(pending);
      else if (refusal && transport.clipBased && canReadmit(refusal)) void readmit(rungs.filter(isRealtime), refusal);
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
      cancelRecovery();
      endOpener(true);
      npcSpeaking = false;
      if (turn && isRealtime(from)) {
        emit({ type: 'error', code: 'turn_lost', message: `transport ${from} failed during the turn: ${err.message}` });
        emit({ type: 'done', error: true });
      }
      bridge?.reset();
      metrics.failovers++;
      const up = upgrade;
      const rtc = up ? await up.rtc : null;
      if (closed) return;
      if (up && rtc && upgrade === up) {
        if (turn) {
          emit({ type: 'error', code: 'turn_lost', message: `transport ${from} failed during the turn: ${err.message}` });
          emit({ type: 'done', error: true });
        }
        up.connected = rtc;
        promote(up, 'failover', from);
        return;
      }
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
    const listener: SileroListener = await startSileroListener(await v.classifier(), (e) => {
      if (e.kind === 'vadStart') clearTimeout(deadlineTimer);
      bridge?.onEffect(e);
    }, v.tuning);
    listener.connect(stream);
    voiceStop = () => { listener.stop(); turns?.drop(); void audio.close().catch(() => {}); };
  }

  function close(reason = 'closed'): void {
    if (closed) return;
    closed = true;
    clearTimeout(readmitTimer);
    clearTimeout(deadlineTimer);
    if (playingOpener) clearTimeout(playingOpener.timer);
    playingOpener = null;
    cacheAbort?.abort();
    bridge?.reset();
    voiceStop?.();
    cancelRecovery();
    localPlayer?.close();
    dropUpgrade('session closed');
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
      void cacheOpeners();
      if (opts.voice && !closed) await startVoice(opts.voice);
      return current!.type;
    },
    sendEndTurn() {
      if (!current || current.clipBased) return;
      startTurn(true);
      current.send({ type: 'end_turn' } satisfies ClientMessage);
    },
    interrupt() {
      clearTimeout(deadlineTimer);
      endOpener(true);
      const r = cancelRecovery();
      if (r?.playing) { emit({ type: 'interrupted' }); emit({ type: 'done', interrupted: true }); return; }
      if (r) emit(r.error);
      current?.send({ type: 'interrupt' });
    },
    updateHistory(messages) {
      const turns = messages.filter(m => m.role !== 'system');
      appended.push(...turns);
      if (current && !current.clipBased) current.send({ type: 'config_update', messages: turns });
    },
    applyUpdate(signed, history) {
      if (history) appended.splice(0, appended.length, ...history.filter(m => m.role !== 'system'));
      if (current && !current.clipBased) current.send({ type: 'config_update', signed });
    },
    async sendTurn(wav) {
      if (!current?.clipBased || closed) return;
      startTurn(true);
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
