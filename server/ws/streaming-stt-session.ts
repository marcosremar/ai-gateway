// ── Streaming STT session management ─────────────────────────────────────────
// Owns the StreamingSTTRouter instance, active sessions map, and cleanup timer.

import { createLogger } from '../../src/logger';
import { StreamingSTTRouter } from '../../src/streaming-stt';
import type { StreamingSTTBackend } from '../../src/streaming-stt';
import { deployState } from '../state';
import { loadProviderConfig } from '../config-persistence';
import { wsClients } from '../ws-state';

const log = createLogger('ws-stt-session');

// Qwen3-ASR endpoint — local MLX, env override, or Modal (default STT)
const MODAL_QWEN3ASR_DEFAULT = 'https://marcosremar--babelcast-qwen3asr-qwen3asr-serve.modal.run';

function getQwen3AsrUrl(): string | null {
  return process.env.MLX_QWEN3_ASR_HOST
    || process.env.QWEN3_ASR_URL
    || process.env.MODAL_QWEN3ASR_URL
    || MODAL_QWEN3ASR_DEFAULT;
}

// ── Streaming STT router — reads provider order from config, filters for streaming-capable ──
async function buildStreamingProviderOrder(): Promise<string[]> {
  try {
    const config = await loadProviderConfig();
    const sttChain = config.pipelineStt || [];
    // Filter: only providers with sttType === 'streaming' (or gpu/fireworks which are streaming by default)
    const STREAMING_PROVIDERS = new Set(['gpu', 'fireworks', 'qwen3-asr', 'mlx-qwen3-asr']);
    const order = sttChain
      .filter(e => e.sttType === 'streaming' || (!e.sttType && STREAMING_PROVIDERS.has(e.provider)))
      .map(e => e.provider);
    if (order.length > 0) return order;
  } catch (e) { log.warn('[ws] streaming provider order parse failed:', e instanceof Error ? e.message : e); }
  // Default: GPU first (lowest latency), then Qwen3-ASR (best accuracy), then Fireworks
  return ['gpu', 'qwen3-asr', 'fireworks'];
}

// Streaming STT router — initialized with defaults, then set up asynchronously after config loads
let sttRouter = new StreamingSTTRouter({
  getGpuUrl: () => deployState.status === 'ready' && deployState.endpoint ? deployState.endpoint : null,
  getQwen3AsrUrl,
  get fireworksApiKey() { return process.env.FIREWORKS_API_KEY ?? ''; },
  providerOrder: ['gpu', 'fireworks', 'qwen3-asr'], // default order, updated after config loads
});

/** Get the current STT router (for use inside the WS open handler). */
export function getSttRouter(): StreamingSTTRouter { return sttRouter; }

/** Rebuild the streaming STT router from config (call after config changes). */
export async function reloadStreamingSTTRouter(): Promise<void> {
  const order = await buildStreamingProviderOrder();
  sttRouter = new StreamingSTTRouter({
    getGpuUrl: () => deployState.status === 'ready' && deployState.endpoint ? deployState.endpoint : null,
    getQwen3AsrUrl,
    get fireworksApiKey() { return process.env.FIREWORKS_API_KEY ?? ''; },
    providerOrder: order,
  });
  log.log(`[ws] Streaming STT router reloaded: order=[${order.join(',')}]`);
}

// Active STT sessions: client WS id → upstream backend
export const sttSessions = new Map<string, StreamingSTTBackend>();

// Cleanup timer — drops sessions whose client WS is gone
export const sttCleanupTimer: ReturnType<typeof setInterval> = setInterval(() => {
  if (sttSessions.size === 0) return;
  const stale: string[] = [];
  for (const [id] of sttSessions) {
    let found = false;
    for (const ws of wsClients) { if (ws.data.id === id) { found = true; break; } }
    if (!found) stale.push(id);
  }
  for (const id of stale) {
    const backend = sttSessions.get(id);
    if (backend) try { backend.close(); } catch { /* already closed */ }
    sttSessions.delete(id);
  }
  if (stale.length) log.log(`[ws] Cleaned ${stale.length} stale STT session(s)`);
}, 60_000); // check every minute
// Process-lifetime sweep: don't hold the event loop open on an otherwise-idle
// process (zero sessions) just to fire this 60s tick. `.unref()` lets the
// runtime exit when nothing else is pending; the timer still fires while the
// server is alive. Guarded for non-Node timer shapes in tests.
sttCleanupTimer?.unref?.();
