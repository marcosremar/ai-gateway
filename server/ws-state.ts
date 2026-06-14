// ── BabelCast Gateway — WebSocket Shared State ──────────────────────────────
// WS broadcast state — kept separate from ws-server.ts to avoid circular deps.
// bot-handlers.ts imports from here; ws-server.ts imports from here too.

import type { ServerWebSocket } from 'bun';
import { botState } from './state';
import { createLogger } from '../src/logger';

const log = createLogger('ws-state');

export type BabelCastWS = ServerWebSocket<{ id: string }>;
export const wsClients = new Set<BabelCastWS>();
export let botTranscriptPollTimer: ReturnType<typeof setInterval> | null = null;
export let botTranscriptCursor = 0;  // index of last seen transcript

/**
 * Per-connection buffered-bytes ceiling for broadcasts. Bun is configured with
 * `closeOnBackpressureLimit: true`, so a single slow subscriber whose send
 * buffer keeps growing will eventually be force-closed — and until then it
 * forces Bun to buffer the broadcast for everyone. We skip clients already over
 * this threshold so one stalled socket can't stall (or trip backpressure-close
 * on) healthy ones. 1 MB ≈ several seconds of mixed audio / many status frames.
 */
export const WS_BROADCAST_BACKPRESSURE_BYTES = 1 * 1024 * 1024;

/** Count of broadcast frames skipped because the client was over its buffer ceiling. */
export let wsBroadcastDropped = 0;
/** Reset the dropped-frame counter (used by tests / metrics rollover). */
export function resetWsBroadcastDropped(): void { wsBroadcastDropped = 0; }

/** True when the socket's buffered bytes are at/over the broadcast ceiling. */
export function isBackpressured(ws: { getBufferedAmount?: () => number }, limit = WS_BROADCAST_BACKPRESSURE_BYTES): boolean {
  const buffered = ws.getBufferedAmount?.() ?? 0;
  return buffered >= limit;
}

export function broadcastWs(msg: Record<string, unknown>): void {
  if (wsClients.size === 0) return;
  const json = JSON.stringify(msg);
  const dead: BabelCastWS[] = [];
  for (const ws of wsClients) {
    // Skip clients whose send buffer is already saturated — sending more would
    // grow the per-socket buffer and risk a backpressure-close. A dropped
    // status/transcript frame is recoverable; a dropped connection is not.
    if (isBackpressured(ws)) { wsBroadcastDropped++; continue; }
    try { ws.send(json); } catch { dead.push(ws); }
  }
  for (const ws of dead) wsClients.delete(ws);
}

/**
 * Push provider status to all connected Python clients.
 * Called whenever GPU health or active tier changes — no polling needed.
 *
 * type: "provider:status"
 * gpu:  "ready" | "offline" | "booting" | "error"
 * tier: "gpu" | "cloud"
 * reason: human-readable explanation
 */
/**
 * Whether to also emit the legacy `provider:status` frame alongside `gpu:status`
 * (#493). Every status change currently sends BOTH events, doubling broadcast
 * volume purely for old-Python-app backward compat. New deployments that no
 * longer run the legacy client can set `AIGW_DISABLE_LEGACY_PROVIDER_STATUS=1`
 * to halve status-broadcast traffic. Defaults to ON (emit) for compatibility.
 * Pure (reads only env) so it's unit-testable.
 */
export function shouldEmitLegacyProviderStatus(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = (env.AIGW_DISABLE_LEGACY_PROVIDER_STATUS ?? '').toLowerCase();
  return !(flag === '1' || flag === 'true' || flag === 'yes');
}

export function broadcastProviderStatus(
  gpu: 'ready' | 'offline' | 'booting' | 'error',
  tier: 'gpu' | 'cloud',
  reason: string,
): void {
  // Legacy event (Python app backward compat) — gated so newer fleets can drop
  // the duplicate frame and halve status broadcast volume (#493).
  if (shouldEmitLegacyProviderStatus()) {
    broadcastWs({ type: 'provider:status', gpu, tier, reason });
  }
  // Richer event with routing + warmth info (new clients + web UI)
  broadcastGpuStatusEvent(gpu, tier, reason);
  log.log(`provider:status → gpu=${gpu} tier=${tier} (${reason})`);
}

/**
 * Push a gpu:status event with routing, warmth, and readiness state.
 * Uses dynamic import to avoid circular deps (state/providers → ws-state).
 */
export function broadcastGpuStatusEvent(
  gpuStatus: 'ready' | 'offline' | 'booting' | 'error',
  tier: 'gpu' | 'cloud',
  reason: string,
): void {
  Promise.all([
    import('./state'),
    import('./providers'),
  ]).then(([state, prov]) => {
    const { gpuModelWarmth, gpuReadinessState, gpuReadyForProduction, deployState, isStageWarm, isTtsWarm, isGpuAvailable } = state;
    const { shouldPreferGpuTts } = prov;
    const gpuAvail = isGpuAvailable();
    const sttGpu = gpuAvail && isStageWarm('stt');
    const llmGpu = gpuAvail && isStageWarm('llm');
    const ttsGpu = gpuAvail && shouldPreferGpuTts();
    broadcastWs({
      type: 'gpu:status',
      gpuStatus, tier, reason,
      endpoint: deployState.endpoint || null,
      gpuType: deployState.gpuType || null,
      modelWarmth: { stt: gpuModelWarmth.stt.warm, llm: gpuModelWarmth.llm.warm, tts: isTtsWarm() },
      pipelineRouting: gpuAvail ? {
        stt: sttGpu ? 'gpu' : 'cloud',
        llm: llmGpu ? 'gpu' : 'cloud',
        tts: ttsGpu ? 'gpu' : 'cloud',
        mode: (sttGpu && llmGpu && ttsGpu) ? 'atomic-gpu' : (sttGpu || llmGpu || ttsGpu) ? 'hybrid' : 'cloud',
      } : null,
      readiness: {
        phase: gpuReadinessState.condemned ? 'condemned'
          : gpuReadyForProduction ? 'production'
          : gpuReadinessState.shadowPhase ? 'shadow'
          : deployState.status === 'ready' ? 'benchmarking'
          : 'idle',
        shadowRuns: gpuReadinessState.shadowCompletedRuns,
      },
    });
  }).catch(e => { log.warn('broadcastGpuStatusEvent failed:', e instanceof Error ? e.message : e); });
}

export function startBotTranscriptPoll(): void {
  if (botTranscriptPollTimer) return;
  botTranscriptCursor = 0;
  botTranscriptPollTimer = setInterval(async () => {
    const endpoint = botState.endpoint;
    if (!endpoint) return;
    try {
      const { botPodApiKey } = await import('./state');
      const headers: Record<string, string> = {};
      if (botPodApiKey) headers['Authorization'] = `Bearer ${botPodApiKey}`;
      const resp = await fetch(`${endpoint}/transcripts`, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return;
      const data = await resp.json() as { transcripts?: Array<{ text: string; speaker?: string }> };
      const items = data.transcripts ?? [];
      const newItems = items.slice(botTranscriptCursor);
      for (const item of newItems) {
        if (item.text?.trim()) {
          broadcastWs({ type: 'transcript', text: item.text.trim(), speaker: item.speaker ?? '' });
          log.log(`Transcript broadcast: ${item.text.slice(0, 60)}`);
        }
      }
      botTranscriptCursor += newItems.length;
    } catch {
      // bot pod not reachable or endpoint missing — ignore silently
    }
  }, 1500);
  // Don't keep the process alive solely for this poll loop; if everything else
  // has shut down, an orphaned 1.5s poll against a dead pod shouldn't block exit.
  botTranscriptPollTimer?.unref?.();
  log.log('Bot transcript polling started');
}

export function stopBotTranscriptPoll(): void {
  if (botTranscriptPollTimer) {
    clearInterval(botTranscriptPollTimer);
    botTranscriptPollTimer = null;
    botTranscriptCursor = 0;
    log.log('[ws] Bot transcript polling stopped');
  }
}

// ── Dub Subscription Tracking ─────────────────────────────────────────────────
// Tracks which WS clients are subscribed to which target language for dub audio.

const dubTargetClients = new Map<string, Set<BabelCastWS>>();
const dubClientTarget = new Map<string, string>();
const dubClientWs = new Map<string, BabelCastWS>();
/** Clients that opted into binary audio frames (binaryAudio: true in dub:subscribe). */
const dubBinaryClients = new Set<string>();

/**
 * Validate a dub `target` value before it becomes a Map key (#483).
 * `dubTargetClients` is keyed by arbitrary `target` strings; a client
 * subscribing to thousands of bogus targets would grow the Map unboundedly.
 * A valid target is a short language code (BCP-47-ish: 2–8 chars, letters /
 * digits / `-`), e.g. `en`, `pt`, `zh-Hant`. We don't hard-restrict to the
 * `langNames` set so new locales work without a code change, but we cap the
 * length and charset so the key space stays bounded.
 */
const DUB_TARGET_RE = /^[A-Za-z0-9-]{2,8}$/;
export function isValidDubTarget(target: unknown): target is string {
  return typeof target === 'string' && DUB_TARGET_RE.test(target);
}

export function subscribeDub(clientId: string, ws: BabelCastWS, target: string, binaryAudio?: boolean): void {
  unsubscribeDub(clientId); // clean up previous subscription
  dubClientTarget.set(clientId, target);
  dubClientWs.set(clientId, ws);
  if (binaryAudio) dubBinaryClients.add(clientId);
  if (!dubTargetClients.has(target)) dubTargetClients.set(target, new Set());
  dubTargetClients.get(target)!.add(ws);
  log.log(`dub:subscribe client=${clientId} target=${target} binary=${!!binaryAudio} (${dubTargetClients.get(target)!.size} subscribers)`);
}

export function unsubscribeDub(clientId: string): void {
  const target = dubClientTarget.get(clientId);
  const ws = dubClientWs.get(clientId);
  if (target && ws) {
    dubTargetClients.get(target)?.delete(ws);
    if (dubTargetClients.get(target)?.size === 0) dubTargetClients.delete(target);
  }
  dubClientTarget.delete(clientId);
  dubClientWs.delete(clientId);
  dubBinaryClients.delete(clientId);
}

export function getActiveTargets(): string[] {
  return [...dubTargetClients.keys()].filter(t => (dubTargetClients.get(t)?.size ?? 0) > 0);
}

/**
 * Build a `transcript:reconnect` hint frame carrying the server-global transcript
 * cursor (#491). `botTranscriptCursor` is process-global, so a client that
 * drops and reconnects has no way to know how many transcript items it already
 * saw and may miss or duplicate them. Sending the current cursor lets the client
 * request a delta (or skip what it has). Pure builder so it's unit-testable and
 * reusable by both the connect snapshot and an explicit reconnect handler.
 */
export function buildTranscriptReconnectHint(cursor = botTranscriptCursor): {
  type: 'transcript:reconnect';
  cursor: number;
} {
  return { type: 'transcript:reconnect', cursor: Math.max(0, Math.floor(cursor) || 0) };
}

/**
 * Pack metadata JSON + raw audio into a single binary WebSocket frame.
 *
 * Frame layout:
 *   [4 bytes: uint32 LE = JSON metadata length]
 *   [N bytes: JSON metadata (without audio field)]
 *   [remaining bytes: raw audio (WAV)]
 */
/**
 * Max bytes the JSON metadata of a binary dub frame may occupy (#438). The
 * frame is `Buffer.allocUnsafe(4 + json + audio)`, which returns uninitialised
 * memory equal to its size; trusting an arbitrarily large `metadata` object
 * would let a caller allocate that much uninitialised RAM. Real dub metadata is
 * a handful of small fields, so 64 KB is generous.
 */
export const MAX_DUB_FRAME_META_BYTES = 64 * 1024;

export function packBinaryDubFrame(metadata: Record<string, unknown>, audio: Buffer): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(metadata));
  if (jsonBuf.length > MAX_DUB_FRAME_META_BYTES) {
    throw new RangeError(`dub frame metadata too large: ${jsonBuf.length} > ${MAX_DUB_FRAME_META_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + jsonBuf.length + audio.length);
  frame.writeUInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(frame, 4);
  audio.copy(frame, 4 + jsonBuf.length);
  return frame;
}

/**
 * Broadcast dub audio to all clients subscribed to the given target language.
 *
 * - Binary clients (opted in via binaryAudio: true) receive a single binary
 *   frame with metadata JSON + raw audio packed together.
 * - Non-binary clients receive the original JSON with base64-encoded audio.
 *
 * @param audioBuffer - Raw audio buffer (WAV). When provided, binary clients
 *   get the efficient binary frame instead of base64. If omitted, all clients
 *   receive JSON (backwards compatible).
 */
export function broadcastDubAudio(target: string, msg: Record<string, unknown>, audioBuffer?: Buffer): void {
  const clients = dubTargetClients.get(target);
  if (!clients || clients.size === 0) return;

  // Lazily build JSON and binary frame only when needed
  let jsonStr: string | null = null;
  let binaryFrame: Buffer | null = null;

  // Collect dead/saturated sockets and delete after iterating. Deleting from
  // the live Set while iterating it can skip the next element (#433).
  const dead: BabelCastWS[] = [];
  for (const ws of clients) {
    // Drop late audio frames for saturated subscribers rather than buffering
    // unbounded PCM (dropping late real-time audio is correct + far cheaper).
    if (isBackpressured(ws)) { wsBroadcastDropped++; continue; }
    // Look up the client ID from the WS data to check binary opt-in
    const clientId = (ws.data as { id: string }).id;
    const isBinary = audioBuffer && dubBinaryClients.has(clientId);

    try {
      if (isBinary) {
        // Build binary frame lazily (strip audio field from metadata)
        if (!binaryFrame) {
          const { audio: _audio, ...metadata } = msg;
          binaryFrame = packBinaryDubFrame(metadata, audioBuffer);
        }
        ws.send(binaryFrame);
      } else {
        // Build JSON lazily
        if (!jsonStr) jsonStr = JSON.stringify(msg);
        ws.send(jsonStr);
      }
    } catch {
      dead.push(ws);
    }
  }
  for (const ws of dead) clients.delete(ws);
  // Clean up empty target entries to prevent memory leak
  if (clients.size === 0) dubTargetClients.delete(target);
}
