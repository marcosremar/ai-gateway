// ── BabelCast Gateway — WebSocket Shared State ──────────────────────────────
// WS broadcast state — kept separate from ws-server.ts to avoid circular deps.
// bot-handlers.ts imports from here; ws-server.ts imports from here too.

import type { ServerWebSocket } from 'bun';
import { botState } from './state';

export type BabelCastWS = ServerWebSocket<{ id: string }>;
export const wsClients = new Set<BabelCastWS>();
export let botTranscriptPollTimer: ReturnType<typeof setInterval> | null = null;
export let botTranscriptCursor = 0;  // index of last seen transcript

export function broadcastWs(msg: Record<string, unknown>): void {
  if (wsClients.size === 0) return;
  const json = JSON.stringify(msg);
  const dead: BabelCastWS[] = [];
  for (const ws of wsClients) {
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
export function broadcastProviderStatus(
  gpu: 'ready' | 'offline' | 'booting' | 'error',
  tier: 'gpu' | 'cloud',
  reason: string,
): void {
  // Legacy event (Python app backward compat)
  broadcastWs({ type: 'provider:status', gpu, tier, reason });
  // Richer event with routing + warmth info (new clients + web UI)
  broadcastGpuStatusEvent(gpu, tier, reason);
  console.log(`[ws] provider:status → gpu=${gpu} tier=${tier} (${reason})`);
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
  }).catch(e => { console.warn('[ws] broadcastGpuStatusEvent failed:', e instanceof Error ? e.message : e); });
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
          console.log(`[ws] Transcript broadcast: ${item.text.slice(0, 60)}`);
        }
      }
      botTranscriptCursor += newItems.length;
    } catch {
      // bot pod not reachable or endpoint missing — ignore silently
    }
  }, 1500);
  console.log('[ws] Bot transcript polling started');
}

export function stopBotTranscriptPoll(): void {
  if (botTranscriptPollTimer) {
    clearInterval(botTranscriptPollTimer);
    botTranscriptPollTimer = null;
    botTranscriptCursor = 0;
    console.log('[ws] Bot transcript polling stopped');
  }
}

// ── Dub Subscription Tracking ─────────────────────────────────────────────────
// Tracks which WS clients are subscribed to which target language for dub audio.

const dubTargetClients = new Map<string, Set<BabelCastWS>>();
const dubClientTarget = new Map<string, string>();
const dubClientWs = new Map<string, BabelCastWS>();
/** Clients that opted into binary audio frames (binaryAudio: true in dub:subscribe). */
const dubBinaryClients = new Set<string>();

export function subscribeDub(clientId: string, ws: BabelCastWS, target: string, binaryAudio?: boolean): void {
  unsubscribeDub(clientId); // clean up previous subscription
  dubClientTarget.set(clientId, target);
  dubClientWs.set(clientId, ws);
  if (binaryAudio) dubBinaryClients.add(clientId);
  if (!dubTargetClients.has(target)) dubTargetClients.set(target, new Set());
  dubTargetClients.get(target)!.add(ws);
  console.log(`[ws] dub:subscribe client=${clientId} target=${target} binary=${!!binaryAudio} (${dubTargetClients.get(target)!.size} subscribers)`);
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
 * Pack metadata JSON + raw audio into a single binary WebSocket frame.
 *
 * Frame layout:
 *   [4 bytes: uint32 LE = JSON metadata length]
 *   [N bytes: JSON metadata (without audio field)]
 *   [remaining bytes: raw audio (WAV)]
 */
export function packBinaryDubFrame(metadata: Record<string, unknown>, audio: Buffer): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(metadata));
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

  for (const ws of clients) {
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
      clients.delete(ws);
    }
  }
  // Clean up empty target entries to prevent memory leak
  if (clients.size === 0) dubTargetClients.delete(target);
}
