/**
 * WebSocket rung, relayed by the gateway (`wss://<gateway>/v1/realtime/ws?token=…`): microphone as 16 kHz PCM16 20 ms
 * frames up, 24 kHz PCM16 down into an AudioWorklet ring buffer, JSON events as text frames. Used when WebRTC cannot
 * connect (UDP and TURN blocked); TCP/443 only.
 */
import { DOWNSTREAM_RATE, UPSTREAM_RATE, decodeAudioFrame, encodeAudioFrame } from '../pcm';
import { createPcmCapture, createPcmPlayer, type PcmCapture, type PcmPlayer } from '../audio-io';
import type { ClientMessage, RealtimeTransport, TransportContext } from '../types';

/** Uplink frames are dropped (not queued) above this backlog: late learner audio is worse than a gap. */
const MAX_UPLINK_BUFFER = 64 * 1024;

const STANDBY_PING_MS = 30_000;

export interface WsDeps {
  WebSocket: typeof WebSocket;
  capture: typeof createPcmCapture;
  player: typeof createPcmPlayer;
}

export function createWsTransport(ctx: TransportContext, url: string, deps?: Partial<WsDeps>): RealtimeTransport {
  const WS = deps?.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  const startCapture = deps?.capture ?? createPcmCapture;
  const startPlayer = deps?.player ?? createPcmPlayer;
  let ws: WebSocket | null = null;
  let capture: PcmCapture | null = null;
  let player: PcmPlayer | null = null;
  let connected = false;
  let closing = false;
  let localOpener = false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let skip = 0;

  const startMic = async () => {
    capture = await startCapture(await ctx.mic(), {
      rate: UPSTREAM_RATE,
      onFrame: (frame) => {
        if (!ws || ws.readyState !== 1) return;
        if (ws.bufferedAmount > MAX_UPLINK_BUFFER) { ctx.dropped(1); return; }
        ws.send(encodeAudioFrame(frame));
      },
    });
  };

  const teardown = () => {
    clearInterval(keepAlive);
    capture?.stop();
    capture = null;
    player?.close();
    player = null;
  };

  return {
    type: 'ws',
    clipBased: false,
    async connect(signal) {
      if (!WS) throw new Error('WebSocket is not available');
      // A browser WebSocket cannot set headers: the trace context rides in the query (the gateway reads both).
      const socket = new WS(`${url}${url.includes('?') ? '&' : '?'}traceparent=${encodeURIComponent(ctx.traceparent)}`);
      ws = socket;
      socket.binaryType = 'arraybuffer';
      let readyResolve: (() => void) | null = null;
      const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
      const opened = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`ws not open within ${ctx.timeouts.wsOpenMs} ms`)), ctx.timeouts.wsOpenMs);
        socket.onopen = () => { clearTimeout(t); resolve(); };
        socket.onerror = () => { clearTimeout(t); reject(new Error('ws error before open')); };
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      });
      socket.onmessage = (e: MessageEvent) => {
        if (closing) return;
        if (typeof e.data === 'string') {
          let event: { type?: string } | null = null;
          try { event = JSON.parse(e.data); } catch { return; }
          if (!event || typeof event.type !== 'string') return;
          if (event.type === 'ready') readyResolve?.();
          if (event.type === 'interrupted') { player?.flush(); skip = 0; }
          if (event.type === 'done') { localOpener = false; skip = 0; }
          if (event.type === 'opener' && localOpener) {
            const opener = event as { state?: string; audio_ms?: number };
            if (opener.state === 'start') skip = Math.round(((opener.audio_ms ?? 0) * DOWNSTREAM_RATE) / 1000);
            return;
          }
          ctx.emit(event as never);
          return;
        }
        const frame = decodeAudioFrame(e.data as ArrayBuffer);
        if (!frame || !player) return;
        const dropped = Math.min(skip, frame.length);
        skip -= dropped;
        if (dropped < frame.length) player.pushPcm16(frame.subarray(dropped), DOWNSTREAM_RATE);
      };
      socket.onclose = (e: CloseEvent) => {
        ctx.telemetry.emit('ws.close', { level: e.code === 1000 ? 'info' : 'warn', attrs: { code: e.code, connected, clientClosed: closing } });
        if (closing) return;
        closing = true;
        teardown();
        if (connected) ctx.fail(new Error(`ws closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`));
      };
      await opened;
      if (ctx.descriptor?.cfg) socket.send(JSON.stringify({ type: 'session_config', cfg: ctx.descriptor.cfg }));
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no ready within ${ctx.timeouts.wsReadyMs} ms`)), ctx.timeouts.wsReadyMs)),
      ]);
      if (signal.aborted) throw new Error('aborted');
      player = await startPlayer({ rate: DOWNSTREAM_RATE });
      if (!ctx.standby) await startMic();
      connected = true;
    },
    goLive() {
      clearInterval(keepAlive);
      if (!capture) void startMic().catch((err: Error) => ctx.fail(err));
    },
    goStandby() {
      capture?.stop();
      capture = null;
      clearInterval(keepAlive);
      keepAlive = setInterval(() => { if (ws?.readyState === 1) ws.send('{"type":"ping"}'); }, STANDBY_PING_MS);
    },
    playOpener(samples, rate) {
      localOpener = true;
      player?.pushFloat(samples, rate);
    },
    uplinkBacklog: () => ws?.bufferedAmount ?? 0,
    send(message: ClientMessage) {
      if (message.type === 'interrupt') { player?.flush(); skip = 0; }
      if (ws?.readyState === 1) ws.send(JSON.stringify(message));
    },
    close() {
      closing = true;
      connected = false;
      teardown();
      try { ws?.close(1000, 'client closed'); } catch { /* closed */ }
    },
  };
}
