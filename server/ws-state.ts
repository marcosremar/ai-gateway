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
  for (const ws of wsClients) {
    try { ws.send(json); } catch { wsClients.delete(ws); }
  }
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
  broadcastWs({ type: 'provider:status', gpu, tier, reason });
  console.log(`[ws] provider:status → gpu=${gpu} tier=${tier} (${reason})`);
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
