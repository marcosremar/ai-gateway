// ── BabelCast Gateway — WebSocket Server ─────────────────────────────────────
// handleWsCommand, startWsServer() — Bun native WS on PORT+1.

import { createLogger } from '../src/logger';
const log = createLogger('ws-server');

import { timingSafeEqual } from 'crypto';
import { botState, deployState, gpuHealthy, gpuModelWarmth, gpuReadinessState, gpuReadyForProduction, isStageWarm, isTtsWarm } from './state';
import {
  shouldPreferGpuTts,
  client, groqDefaults, ollamaDefaults, translationDefaults,
} from './providers';
import { isGpuAvailable } from './state';
import { broadcastWs, wsClients, startBotTranscriptPoll, stopBotTranscriptPoll, subscribeDub, unsubscribeDub, getActiveTargets } from './ws-state';
import type { BabelCastWS } from './ws-state';
import { setBotState, isPrivateUrl } from './bot-handlers';
import { PORT } from './config';
import { StreamingSTTRouter } from '../src/streaming-stt';
import { loadProviderConfig } from './config-persistence';
import { runStreamingPipeline } from './pipeline-runner';
import type { PipelineCallbacks, PipelineResult } from './pipeline-runner';
import { speculativeCache } from './speculative-cache';
import { getLabsFlags } from './labs-settings';
import { buildSystemPrompt, getCloudProviderName, getCloudProfile } from './ai-handlers';
import { langNames } from './http-utils';

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

// Qwen3-ASR endpoint — local MLX, env override, or Modal (default STT)
const MODAL_QWEN3ASR_DEFAULT = 'https://marcosremar--babelcast-qwen3asr-qwen3asr-serve.modal.run';

function getQwen3AsrUrl(): string | null {
  return process.env.MLX_QWEN3_ASR_HOST
    || process.env.QWEN3_ASR_URL
    || process.env.MODAL_QWEN3ASR_URL
    || MODAL_QWEN3ASR_DEFAULT;
}

// Streaming STT router — initialized with defaults, then set up asynchronously after config loads
let sttRouter = new StreamingSTTRouter({
  getGpuUrl: () => deployState.status === 'ready' && deployState.endpoint ? deployState.endpoint : null,
  getQwen3AsrUrl,
  get fireworksApiKey() { return process.env.FIREWORKS_API_KEY ?? ''; },
  providerOrder: ['gpu', 'fireworks', 'qwen3-asr'], // default order, updated after config loads
});

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
const sttSessions = new Map<string, import('../src/streaming-stt').StreamingSTTBackend>();

// Periodic cleanup of stale STT sessions (clients that disconnected ungracefully)
setInterval(() => {
  if (sttSessions.size === 0) return;
  const stale: string[] = [];
  for (const [id] of sttSessions) {
    // If the WS client is gone, the session is stale
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

// Bot audio relay state
let botAudioSource: BabelCastWS | null = null;
let botAudioSampleRate = 48000;
let botAudioChunks = 0;
export function getBotAudioChunks(): number { return botAudioChunks; }

// ── Bot audio → pipeline auto-processing ─────────────────────────────────
// Buffers incoming bot PCM chunks. When enough audio accumulates (VAD-like),
// runs the speech pipeline (STT→LLM→TTS) and broadcasts subtitle:early.

let botAudioBuffer: Buffer[] = [];
let botAudioBufferBytes = 0;
let botAudioProcessing = false;
let botAudioLastProcess = 0;
// Held audio from a previous short/meaningless segment — merged with the next chunk
let botAudioHeldPcm: Buffer | null = null;
let botAudioHeldMergeCount = 0;

// Bot language pair — set from bot:join command, reset on bot:leave
let botSourceLang = 'fr';
let botTargetLang = 'en';

// Config: process every ~3s of audio (16kHz 16-bit mono = 32000 bytes/s → ~96KB)
const BOT_AUDIO_CHUNK_THRESHOLD = 3 * 32000; // 3 seconds at 16kHz 16-bit
const BOT_AUDIO_MIN_INTERVAL_MS = 2000; // don't process more than once every 2s
const BOT_AUDIO_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB cap to prevent OOM
// Segment merge limits
const BOT_AUDIO_MAX_MERGE_COUNT = 3;        // max merges before forcing output
const BOT_AUDIO_MAX_HELD_BYTES = 15 * 32000; // max 15s of held audio

/** Returns true if the transcription is a meaningful phrase (not just stray letters/words). */
function isMeaningfulTranscription(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  return words.length >= 3 || trimmed.length >= 15;
}

/** Force-flush bot audio buffer (called on disconnect or when buffer is too large) */
function flushBotAudioBuffer(): void {
  if (botAudioBufferBytes > 0 && botAudioBufferBytes >= 16000) { // at least 0.5s of audio
    processBotAudioBuffer().catch(e => log.warn('[bot-audio] Flush failed:', e instanceof Error ? e.message : e));
  } else {
    botAudioBuffer = [];
    botAudioBufferBytes = 0;
    // Discard any held audio — no new audio is coming to merge with
    botAudioHeldPcm = null;
    botAudioHeldMergeCount = 0;
  }
}

function getBotSourceTarget(): { source: string; target: string } {
  return { source: botSourceLang, target: botTargetLang };
}

async function processBotAudioBuffer(): Promise<void> {
  if (botAudioProcessing || botAudioBufferBytes < BOT_AUDIO_CHUNK_THRESHOLD) return;
  if (Date.now() - botAudioLastProcess < BOT_AUDIO_MIN_INTERVAL_MS) return;

  botAudioProcessing = true;
  botAudioLastProcess = Date.now();

  // Grab the buffered audio and reset
  const chunks = botAudioBuffer;
  botAudioBuffer = [];
  botAudioBufferBytes = 0;

  try {
    // Convert Int16 PCM to WAV — prepend held audio from previous short segment
    let pcmData: Buffer = Buffer.concat(chunks);
    if (botAudioHeldPcm) {
      log.log(`[bot-audio] Merging held audio (${(botAudioHeldPcm.length / 32000).toFixed(1)}s) with new chunk (${(pcmData.length / 32000).toFixed(1)}s)`);
      pcmData = Buffer.concat([botAudioHeldPcm, pcmData]);
      botAudioHeldPcm = null;
    }
    const sampleRate = botAudioSampleRate || 16000;
    const wavHeader = Buffer.alloc(44);
    const dataSize = pcmData.length;
    const fileSize = dataSize + 36;
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(fileSize, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16); // fmt chunk size
    wavHeader.writeUInt16LE(1, 20);  // PCM
    wavHeader.writeUInt16LE(1, 22);  // mono
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(sampleRate * 2, 28); // byte rate
    wavHeader.writeUInt16LE(2, 32);  // block align
    wavHeader.writeUInt16LE(16, 34); // bits per sample
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(dataSize, 40);
    const wavBuffer = Buffer.concat([wavHeader, pcmData]);

    const { source, target } = getBotSourceTarget();
    log.log(`[bot-audio] Processing ${(pcmData.length / 1024).toFixed(0)}KB audio (${(pcmData.length / 32000).toFixed(1)}s) ${source}→${target}`);

    const callbacks: PipelineCallbacks = {
      onStageStart() {},
      onStageDone() {},
      onAudioChunk() {},
      onComplete(result: PipelineResult) {
        const transcription = result.transcription?.trim();
        if (!transcription) {
          // No speech detected — discard any held audio to avoid infinite merging
          botAudioHeldPcm = null;
          botAudioHeldMergeCount = 0;
          return;
        }

        // If the segment is just stray letters or a word or two, hold the audio
        // and merge with the next chunk so the STT gets more context
        if (
          !isMeaningfulTranscription(transcription) &&
          botAudioHeldMergeCount < BOT_AUDIO_MAX_MERGE_COUNT &&
          pcmData.length < BOT_AUDIO_MAX_HELD_BYTES
        ) {
          botAudioHeldPcm = pcmData;
          botAudioHeldMergeCount++;
          log.log(`[bot-audio] Short segment "${transcription.slice(0, 30)}" — holding audio for merge #${botAudioHeldMergeCount}`);
          return;
        }

        // Meaningful (or forced after max merges) — broadcast and clear held state
        botAudioHeldPcm = null;
        botAudioHeldMergeCount = 0;

        log.log(`[bot-audio] Pipeline: "${transcription.slice(0, 40)}" → "${result.translation?.slice(0, 40)}"`);
        // Broadcast as subtitle:early — this is what the website listens for
        broadcastWs({
          type: 'subtitle:early',
          transcription: result.transcription,
          translation: result.translation || '',
          source,
          target,
        });
        // Also broadcast as transcript
        broadcastWs({
          type: 'transcript',
          text: result.transcription,
          speaker: 'Meeting',
        });
      },
      onError(stage: string, error: Error) {
        log.error(`[bot-audio] Pipeline error at ${stage}: ${error.message}`);
      },
    };

    await runStreamingPipeline(wavBuffer, {
      source, target,
    }, callbacks);
  } catch (err) {
    log.error(`[bot-audio] Pipeline error:`, err instanceof Error ? err.message : err);
  } finally {
    botAudioProcessing = false;
  }
}

// ── PulseAudio capture from Docker container ─────────────────────────────────
// Captures audio directly from PulseAudio's monitor source inside the bot
// container via `docker exec parec`. Much more reliable than Web Audio API.
import { BOT_LOCAL_CONTAINER } from './bot-handlers';
import type { Subprocess } from 'bun';

let parecProc: Subprocess | null = null;
let parecChunks = 0;

// FIX: Reusable capture buffer to avoid GC pressure from Buffer.concat in hot path
const MAX_CAPTURE_BUFFER = 100 * 1024 * 1024; // 100MB max
let captureBuffer = Buffer.alloc(MAX_CAPTURE_BUFFER);
let captureOffset = 0;

export function startParecCapture(): void {
  if (parecProc) return;
  parecChunks = 0;

  const containerName = botState.podId === 'local' ? BOT_LOCAL_CONTAINER : '';
  if (!containerName) {
    log.log('[parec] Skipping parec capture — not a local Docker bot');
    return;
  }

  log.log(`[parec] Starting PulseAudio capture from container ${containerName}...`);
  parecProc = Bun.spawn([
    'docker', 'exec', containerName,
    'parec', '--format=s16le', '--channels=1', '--rate=48000',
    '--device=virtual_speaker.monitor',
  ], { stdout: 'pipe', stderr: 'pipe' });

  // Read stderr for errors
  (async () => {
    // stdout/stderr is ReadableStream when spawned with { stderr: 'pipe' },
    // but Bun types it as `number | ReadableStream` (the number case is for
    // 'inherit'). Narrow explicitly.
    if (!parecProc?.stderr || typeof parecProc.stderr === 'number') return;
    const reader = parecProc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value).trim();
        if (text) log.warn(`[parec] stderr: ${text}`);
      }
    } catch { /* ignore */ }
  })();

  // Read stdout: raw Int16 PCM → relay to WS clients in ~20ms chunks (640 bytes = 320 samples)
  const CHUNK_SIZE = 640; // 320 samples × 2 bytes = 20ms at 16kHz
  let buffer = new Uint8Array(0);

  (async () => {
    if (!parecProc?.stdout || typeof parecProc.stdout === 'number') return;
    const reader = parecProc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append to buffer
        const newBuf = new Uint8Array(buffer.length + value.length);
        newBuf.set(buffer);
        newBuf.set(value, buffer.length);
        buffer = newBuf;

        // Send complete chunks
        while (buffer.length >= CHUNK_SIZE) {
          const chunk = buffer.slice(0, CHUNK_SIZE);
          buffer = buffer.slice(CHUNK_SIZE);

          parecChunks++;
          if (parecChunks === 1 || parecChunks % 500 === 0) {
            log.log(`[parec] Relaying chunk #${parecChunks} (${chunk.length} bytes) to ${wsClients.size} clients`);
          }

          for (const client of wsClients) {
            try { client.send(chunk); } catch { wsClients.delete(client); }
          }

          // Auto-process: buffer parec audio for pipeline processing (same as bot-audio)
          const buf = Buffer.from(chunk);
          botAudioBuffer.push(buf);
          botAudioBufferBytes += buf.length;
          if (botAudioBufferBytes >= BOT_AUDIO_CHUNK_THRESHOLD) {
            processBotAudioBuffer().catch(() => {});
          }
        }
      }
    } catch (err) {
      log.warn(`[parec] Read error: ${err}`);
    }
    log.log(`[parec] Capture ended (${parecChunks} chunks sent)`);
    parecProc = null;
  })();
}

export function stopParecCapture(): void {
  if (parecProc) {
    log.log(`[parec] Stopping PulseAudio capture (${parecChunks} chunks sent)...`);
    const proc = parecProc;
    parecProc = null; // null before kill so reader loop stops trying to read
    parecChunks = 0;
    try { proc.kill(); } catch { /* ignore */ }
    proc.exited.catch(() => {}); // fire-and-forget await — ensures process cleanup
  }
}

/**
 * Build a translation function for speculative cache that uses the same
 * LLM routing as the normal pipeline (cloud providers).
 */
function buildSpeculativeTranslateFn(source: string, target: string, style: string): (text: string) => Promise<string> {
  return async (text: string): Promise<string> => {
    const sourceName = langNames[source] || source;
    const targetName = langNames[target] || target;
    const systemPrompt = buildSystemPrompt(sourceName, targetName, style);
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: text },
    ];
    const cloudProfile = getCloudProfile();
    if (!cloudProfile) throw new Error('No cloud profile available');
    const r = await client.chat(messages, cloudProfile);
    return r.content;
  };
}

export async function handleWsCommand(ws: BabelCastWS, cmd: Record<string, unknown>): Promise<void> {
  const type = cmd.type as string;
  log.log(`[ws] Command from client: ${type}`);

  try {

  if (type === 'bot:join') {
    const meetingUrl = (cmd.meetingUrl as string) ?? '';
    const sourceLang = (cmd.sourceLang as string) ?? 'fr';
    const targetLang = (cmd.targetLang as string) ?? 'en';
    const botName = (cmd.botName as string) ?? 'BabelCast Bot';

    // Store language pair for bot audio pipeline (getBotSourceTarget)
    botSourceLang = (cmd.source as string) || sourceLang;
    botTargetLang = (cmd.target as string) || targetLang;

    if (!meetingUrl) {
      ws.send(JSON.stringify({ type: 'error', message: 'meetingUrl is required' }));
      return;
    }
    // Validate meeting URL format and protocol
    try {
      const parsed = new URL(meetingUrl);
      if (!['https:', 'http:'].includes(parsed.protocol)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid meeting URL: must be http or https' }));
        return;
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid meeting URL format' }));
      return;
    }
    // SSRF protection — block private/internal network URLs
    if (isPrivateUrl(meetingUrl)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Meeting URL must not point to private/internal networks' }));
      return;
    }
    if (botState.status !== 'ready') {
      ws.send(JSON.stringify({ type: 'error', message: `Bot pod not ready (status: ${botState.status})` }));
      return;
    }

    // Directly call the join logic inline (bypassing the HTTP handler reuse
    // — previous fake-IncomingMessage approach was removed as dead code).
    const botEndpoint = botState.endpoint;
    if (!botEndpoint) {
      broadcastWs({ type: 'bot:status', status: 'error', message: 'Bot pod has no endpoint' });
      return;
    }

    const botUuid = crypto.randomUUID();
    // For local Docker: use parec (PulseAudio) capture — much more reliable than Web Audio API.
    // Only set streaming_output for RunPod bots (no parec available remotely).
    const isLocalBot = botState.podId === 'local';
    const streamingOutput = isLocalBot
      ? ''  // parec handles audio capture for local Docker
      : `ws://localhost:${PORT + 1}/ws/bot-audio`;
    const config = {
      meeting_url: meetingUrl,
      bot_name: botName,
      bot_uuid: botUuid,
      streaming_output: streamingOutput,
      streaming_audio_frequency: 48000,
      recording_mode: 'speaker_view',
      remote: null,
      speech_to_text_provider: 'Default',
      automatic_leave: { waiting_room_timeout: 600, noone_joined_timeout: 300, silence_timeout: 600 },
      _source_lang: sourceLang,
      _target_lang: targetLang,
    };

    setBotState({ botId: botUuid, meetingUrl, status: 'joined', message: `Bot joining: ${meetingUrl}` });
    broadcastWs({ type: 'bot:status', status: 'joining', message: `Bot joining meeting...` });

    try {
      const { botPodApiKey } = await import('./state');
      const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (botPodApiKey) authHeaders['Authorization'] = `Bearer ${botPodApiKey}`;
      const joinRes = await fetch(`${botEndpoint}/join`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(config),
        signal: AbortSignal.timeout(30_000),
      });
      const joinBody = await joinRes.json().catch(() => ({}));
      if (joinRes.ok) {
        broadcastWs({ type: 'bot:status', status: 'in_meeting', message: 'Bot joined meeting' });
        // Start PulseAudio capture for local Docker (much more reliable than Web Audio API)
        startParecCapture();
      } else {
        broadcastWs({ type: 'bot:status', status: 'error', message: `Join failed: ${JSON.stringify(joinBody)}` });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('bot:join failed: %s', errMsg);
      broadcastWs({ type: 'bot:status', status: 'error', message: `Join failed: ${errMsg}` });
    }

  } else if (type === 'bot:leave') {
    stopParecCapture();
    stopBotTranscriptPoll();
    // Reset language pair to defaults
    botSourceLang = 'fr';
    botTargetLang = 'en';
    const endpoint = botState.endpoint;
    if (!endpoint) {
      broadcastWs({ type: 'bot:status', status: 'idle', message: 'Bot not active' });
      return;
    }
    try {
      await fetch(`${endpoint}/stop_record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meeting_url: botState.meetingUrl }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* ignore */ }
    setBotState({ status: 'ready', message: 'Bot left meeting', meetingUrl: '', botId: '' });
    broadcastWs({ type: 'bot:status', status: 'idle', message: 'Bot left meeting' });

  } else if (type === 'dub:subscribe' || type === 'dub:switch') {
    const target = String(cmd.target || '');
    if (!target) {
      ws.send(JSON.stringify({ type: 'error', message: 'target is required for dub:subscribe' }));
      return;
    }
    const binaryAudio = cmd.binaryAudio === true;
    subscribeDub(ws.data.id, ws, target, binaryAudio);
    ws.send(JSON.stringify({ type: 'dub:subscribed', target, binaryAudio, activeTargets: getActiveTargets() }));

  } else if (type === 'dub:unsubscribe') {
    unsubscribeDub(ws.data.id);
    ws.send(JSON.stringify({ type: 'dub:unsubscribed' }));

  } else if (type === 'speculation:feed') {
    // Feed a partial ASR result into the speculative translation cache.
    // The client sends: { type: 'speculation:feed', sessionId, text, source, target, style? }
    const labs = getLabsFlags();
    if (!labs.speculativeTranslation) return; // no-op when flag is off

    const sessionId = String(cmd.sessionId || '');
    const text = String(cmd.text || '');
    const source = String(cmd.source || 'fr');
    const target = String(cmd.target || 'en');
    const style = String(cmd.style || 'default');

    if (!sessionId || !text.trim()) return;

    const translateFn = buildSpeculativeTranslateFn(source, target, style);
    try { speculativeCache.speculate(sessionId, text, translateFn); } catch (e) { log.warn('[ws] speculative translate failed:', e instanceof Error ? e.message : e); }

  } else if (type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
  }
  } catch (err) {
    log.error('Command error: %s', err instanceof Error ? err.message : err);
    ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
  }
}

type WsData = {
  id: string;
  type: 'bot' | 'stt' | 'bot-audio' | 'speech' | 'recall-audio';
  language?: string;
  /** Target language for STT sessions — enables auto-speculation when set. */
  speculateTarget?: string;
  /** Silence timeout before flushing accumulated STT text (ms). Default 700. */
  pauseMs?: number;
  speechConfig?: { source: string; target: string; speaker?: string };
};

/** Global WebSocket connection limit — prevents resource exhaustion from unlimited connections. */
const MAX_WS_TOTAL = 200;
let wsConnectionCount = 0;

/**
 * Validate critical configuration at startup and return warnings.
 * Non-fatal: the server still starts, but operators get prominent log lines
 * so they know what's missing.
 */
export function validateStartupConfig(): string[] {
  const warnings: string[] = [];

  // Check at least one GPU provider is configured
  if (!process.env.RUNPOD_API_KEY && !process.env.VAST_API_KEY && !process.env.TENSORDOCK_API_KEY) {
    warnings.push('No GPU provider API keys configured (RUNPOD_API_KEY, VAST_API_KEY, TENSORDOCK_API_KEY)');
  }

  // Check at least one AI provider
  if (!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY) {
    warnings.push('No AI provider API keys configured (GROQ_API_KEY, OPENAI_API_KEY)');
  }

  // Check daily budget is set
  if (!process.env.DAILY_BUDGET_USD) {
    warnings.push('DAILY_BUDGET_USD not set — no spending limit. Set to prevent runaway costs.');
  }

  // Check gateway auth
  if (!process.env.GATEWAY_API_KEY) {
    warnings.push('GATEWAY_API_KEY not set — only localhost connections will be allowed.');
  }

  return warnings;
}

export async function startWsServer(): Promise<number> {
  // Install persistent file logging — captures all console output + GPU events
  try {
    const { installConsoleCapture } = require('./file-logger');
    installConsoleCapture();
  } catch (err) {
    log.warn('[ws-server] Failed to install file logger:', err);
  }

  // ── Startup config validation ─────────────────────────────────────────────
  const configWarnings = validateStartupConfig();
  if (configWarnings.length > 0) {
    log.warn('='.repeat(70));
    log.warn('[startup] Configuration warnings:');
    for (const w of configWarnings) {
      log.warn(`  - ${w}`);
    }
    log.warn('='.repeat(70));
  } else {
    log.log('[startup] Configuration validated — all critical env vars present.');
  }

  /** Constant-time string comparison to prevent timing attacks on auth tokens. */
  function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch { return false; }
  }

  const WS_PORT = PORT + 1;
  Bun.serve<WsData>({
    port: WS_PORT,
    fetch(req, server) {
      const url = new URL(req.url);

      // ── Global WS connection limit — reject before any per-session upgrade ──
      if (wsConnectionCount >= MAX_WS_TOTAL) {
        return new Response('Too many connections', { status: 429 });
      }

      // ── Recall.ai audio endpoint — uses its own secret, checked before gateway auth ──
      if (url.pathname === '/recall/audio') {
        const recallSecret = process.env.RECALL_WS_SECRET;
        if (recallSecret) {
          const token = url.searchParams.get('token') || req.headers.get('authorization')?.replace('Bearer ', '');
          if (!token || !safeCompare(token, recallSecret)) {
            return new Response('Unauthorized', { status: 401 });
          }
        }
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'recall-audio' } });
        if (upgraded) return;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // WebSocket authentication — always check auth.
      // Localhost exemption: if no GATEWAY_API_KEY is set AND connection is from localhost, allow it.
      const expectedToken = process.env.GATEWAY_API_KEY;
      const authToken = url.searchParams.get('token') || req.headers.get('authorization')?.replace('Bearer ', '');
      if (expectedToken) {
        // API key is configured — always require valid token
        if (!authToken || !safeCompare(authToken, expectedToken)) {
          return new Response('Unauthorized', { status: 401 });
        }
      } else {
        // No API key configured — only allow localhost connections
        const remoteAddr = server.requestIP(req)?.address || '';
        const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
        if (!isLocalhost) {
          return new Response('Unauthorized — no GATEWAY_API_KEY configured, only localhost allowed', { status: 401 });
        }
      }

      if (url.pathname === '/v1/speech/ws') {
        const source = url.searchParams.get('source') || 'fr';
        const target = url.searchParams.get('target') || 'en';
        const speaker = url.searchParams.get('speaker') || undefined;
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'speech', speechConfig: { source, target, speaker } } });
        if (upgraded) return;
      } else if (url.pathname === '/v1/stt/stream') {
        const language = url.searchParams.get('language') || undefined;
        const speculateTarget = url.searchParams.get('target') || undefined;
        const pauseMs = Math.max(50, Math.min(30_000, parseInt(url.searchParams.get('pause_ms') || '700', 10) || 700));
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'stt', language, speculateTarget, pauseMs } });
        if (upgraded) return;
      } else if (url.pathname === '/ws/bot-audio') {
        // Bot audio relay — the meeting bot streams raw PCM here
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'bot-audio' } });
        if (upgraded) return;
      } else {
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'bot' } });
        if (upgraded) return;
      }
      return new Response(
        `BabelCast WebSocket gateway. Connect: ws://localhost:${WS_PORT}`,
        { status: 200, headers: { 'Content-Type': 'text/plain' } },
      );
    },
    websocket: {
      maxPayloadLength: 4 * 1024 * 1024, // 4MB — enough for audio chunks
      closeOnBackpressureLimit: true,
      idleTimeout: 120,                   // seconds
      open(ws) {
        wsConnectionCount++;
        if (ws.data.type === 'speech') {
          // ── Speech pipeline session ────────────────────────────────
          ws.send(JSON.stringify({ type: 'connected', message: 'Speech pipeline ready. Send config JSON then binary WAV.' }));
          log.log(`[speech-ws] Client connected id=${ws.data.id}`);
        } else if (ws.data.type === 'stt') {
          // ── Streaming STT session (with auto-fallback) ─────────────
          const language = ws.data.language;
          const excluded = new Set<string>();

          const connectBackend = () => {
            const backend = sttRouter.createBackend(language, excluded);
            if (!backend) {
              ws.send(JSON.stringify({ type: 'error', message: 'No STT backend available (no GPU and no Fireworks key)' }));
              ws.close();
              return;
            }
            const t0 = Date.now();
            backend.onConnected = () => {
              log.log(`[stt-ws] Backend connected: ${backend.provider} id=${ws.data.id}`);
              ws.send(JSON.stringify({ type: 'connected', provider: backend.provider }));
            };
            // Text accumulator: the STT backend emits the FULL running text on each
            // result (all active segments concatenated).  We track the full text and
            // a "flushed" cursor so we only send the NEW (delta) portion to the client.
            //
            // Short-segment grouping: when isFinal fires but the pending text is too
            // short for a useful subtitle (<5 words / <30 chars), we hold it in
            // `shortBuf` and merge it with the next segment before flushing.
            let sttFullText = '';          // latest full text from STT backend (REPLACED each event)
            let sttFlushedLen = 0;         // chars of sttFullText already sent as "text" message
            let sttAccumTimer: ReturnType<typeof setTimeout> | null = null;
            let shortBuf = '';             // held-back short segment waiting to be merged
            const sttContext: string[] = [];  // sliding window of recent transcripts for STT seed
            const STT_CONTEXT_MAX = 5;
            const STT_ACCUM_TIMEOUT_MS = ws.data.pauseMs ?? 700;   // configurable via ?pause_ms=
            const STT_SHORT_TIMEOUT_MS = Math.max(1200, (ws.data.pauseMs ?? 700) * 2);
            const STT_MIN_FLUSH_WORDS = 3;
            const STT_MIN_FLUSH_CHARS = 20;
            const STT_MAX_ACCUM_MS = 5000;  // force flush after 5s even during continuous speech
            let sttAccumStartTime: number | null = null;  // when current accumulation started

            const emitText = (text: string) => {
              if (!text || ws.readyState !== 1) return;
              ws.send(JSON.stringify({ type: 'text', text, provider: backend.provider }));
              // Push to STT context window and seed backend (GPU/Qwen3-ASR only)
              sttContext.push(text);
              while (sttContext.length > STT_CONTEXT_MAX) sttContext.shift();
              (backend as any).sendSeed?.(sttContext.join(' '));
              // Speculative translation
              const labs = getLabsFlags();
              if (labs.speculativeTranslation && ws.data.speculateTarget && text) {
                const srcLang = ws.data.language || 'fr';
                const tgtLang = ws.data.speculateTarget;
                const translateFn = buildSpeculativeTranslateFn(srcLang, tgtLang, 'default');
                try { speculativeCache.speculate(ws.data.id, text, translateFn); } catch (e) { log.warn('[ws] speculative translate failed:', e instanceof Error ? e.message : e); }
              }
            };

            const flushSttAccum = () => {
              if (sttAccumTimer) { clearTimeout(sttAccumTimer); sttAccumTimer = null; }
              const pending = sttFullText.slice(sttFlushedLen).trim();
              if (!pending && !shortBuf) return;
              sttFlushedLen = sttFullText.length;
              // Merge any held-back short segment with the new pending text
              const merged = (shortBuf ? shortBuf + ' ' + pending : pending).trim();
              shortBuf = '';
              sttAccumStartTime = null;  // reset accumulation timer
              emitText(merged);
            };

            backend.onResult = (evt) => {
              if (ws.readyState !== 1) return;
              const newText = evt.text.trim();
              if (!newText) return;

              // Backend emits full running text — REPLACE, never append.
              sttFullText = newText;

              // Pending = text not yet flushed as a stable segment
              const pending = sttFullText.slice(sttFlushedLen).trim();

              // Always relay partial for live-typing preview (pending portion only)
              const partialText = shortBuf ? (shortBuf + ' ' + pending).trim() : (pending || newText);
              ws.send(JSON.stringify({ type: 'partial', text: partialText, provider: evt.provider }));

              if (!pending) return;

              // Track accumulation start — force flush after STT_MAX_ACCUM_MS
              // to prevent long gaps during continuous speech without isFinal
              if (!sttAccumStartTime) sttAccumStartTime = Date.now();
              const accumAge = Date.now() - sttAccumStartTime;
              if (accumAge >= STT_MAX_ACCUM_MS && pending.split(/\s+/).length >= STT_MIN_FLUSH_WORDS) {
                log.log(`[stt-ws] Max accum timeout (${accumAge}ms, ${pending.split(/\s+/).length}w) — forcing flush id=${ws.data.id}`);
                flushSttAccum();
                return;
              }

              if (evt.isFinal) {
                // Check if the combined text (shortBuf + pending) is long enough
                const combined = (shortBuf ? shortBuf + ' ' + pending : pending).trim();
                const wordCount = combined.split(/\s+/).length;
                if (wordCount >= STT_MIN_FLUSH_WORDS || combined.length >= STT_MIN_FLUSH_CHARS) {
                  // Long enough — flush immediately
                  flushSttAccum();
                } else {
                  // Too short — hold back and wait for more text
                  shortBuf = combined;
                  sttFlushedLen = sttFullText.length;
                  // But don't hold forever — flush after STT_SHORT_TIMEOUT_MS
                  if (sttAccumTimer) clearTimeout(sttAccumTimer);
                  sttAccumTimer = setTimeout(flushSttAccum, STT_SHORT_TIMEOUT_MS);
                }
              } else {
                // Reset silence timeout
                if (sttAccumTimer) clearTimeout(sttAccumTimer);
                sttAccumTimer = setTimeout(flushSttAccum, STT_ACCUM_TIMEOUT_MS);
              }
            };
            backend.onDisconnected = (reason) => {
              log.log(`[stt-ws] Backend ${backend.provider} disconnected: ${reason} id=${ws.data.id}`);
              sttSessions.delete(ws.data.id);
              if (ws.readyState !== 1 /* OPEN */) return; // client already gone
              // Always try to reconnect with next available provider (only when ws.readyState === 1).
              // connectBackend() handles the "no provider" case by closing the client WS.
              if (ws.readyState === 1) {
                excluded.add(backend.provider);
                log.log(`[stt-ws] Reconnecting (excluded: ${[...excluded].join(',')}) id=${ws.data.id}`);
                try {
                  connectBackend();
                } catch (e) {
                  log.warn(`[stt-ws] Reconnect failed — closing client WS:`, e instanceof Error ? e.message : e);
                  ws.close(1001, 'STT backend reconnect failed');
                }
              }
            };
            backend.connect();
            sttSessions.set(ws.data.id, backend);
            // Expose accumulation timer via backend so the close handler can clear it
            (backend as any)._sttAccumTimer = () => sttAccumTimer;
            (backend as any)._clearSttAccumTimer = () => { if (sttAccumTimer) { clearTimeout(sttAccumTimer); sttAccumTimer = null; } };
            log.log(`[stt-ws] Client connected id=${ws.data.id} lang=${language || 'auto'} provider=${backend.provider}`);
          };
          connectBackend();
        } else if (ws.data.type === 'bot-audio') {
          // ── Bot audio relay — meeting bot streams raw PCM here ──────
          log.log(`[bot-audio] Bot audio source connected id=${ws.data.id}`);
          botAudioSource = ws as unknown as BabelCastWS;
        } else if (ws.data.type === 'recall-audio') {
          // ── Recall.ai audio receiver — Recall bot connects here ──────
          log.log(`[recall-audio] Recall bot connected id=${ws.data.id}`);
          import('./recall-handlers').then(({ setRecallState }) => {
            setRecallState({ wsConnected: true, status: 'in_meeting', message: 'Recall bot streaming audio' });
          }).catch(() => {});
        } else {
          // ── Bot events session ─────────────────────────────────────
          const MAX_WS_CLIENTS = 500;
          if (wsClients.size >= MAX_WS_CLIENTS) {
            log.warn(`[ws] Connection limit reached (${MAX_WS_CLIENTS}) — rejecting`);
            ws.close(1013, 'Too many connections');
            return;
          }
          wsClients.add(ws as unknown as BabelCastWS);
          ws.send(JSON.stringify({
            type: 'connected',
            botStatus: botState.status,
            message: botState.message,
          }));
          // Push full GPU status immediately on connect — no polling needed on reconnect
          const _gpuStatus = deployState.status === 'ready' && gpuHealthy ? 'ready'
            : deployState.status === 'error' ? 'error'
            : deployState.status !== 'idle' ? 'booting'
            : 'offline';
          const _gpuAvail = isGpuAvailable();
          const _tier = (_gpuStatus === 'ready' && _gpuAvail) ? 'gpu' : 'cloud';
          const _sttGpu = _gpuAvail && isStageWarm('stt');
          const _llmGpu = _gpuAvail && isStageWarm('llm');
          const _ttsGpu = _gpuAvail && shouldPreferGpuTts();
          ws.send(JSON.stringify({
            type: 'gpu:status',
            gpuStatus: _gpuStatus,
            tier: _tier,
            reason: deployState.message || 'Current status',
            endpoint: deployState.endpoint || null,
            gpuType: deployState.gpuType || null,
            modelWarmth: { stt: gpuModelWarmth.stt.warm, llm: gpuModelWarmth.llm.warm, tts: isTtsWarm() },
            pipelineRouting: _gpuAvail ? {
              stt: _sttGpu ? 'gpu' : 'cloud',
              llm: _llmGpu ? 'gpu' : 'cloud',
              tts: _ttsGpu ? 'gpu' : 'cloud',
              mode: (_sttGpu && _llmGpu && _ttsGpu) ? 'atomic-gpu' : (_sttGpu || _llmGpu || _ttsGpu) ? 'hybrid' : 'cloud',
            } : null,
            readiness: {
              phase: gpuReadinessState.condemned ? 'condemned'
                : gpuReadyForProduction ? 'production'
                : gpuReadinessState.shadowPhase ? 'shadow'
                : deployState.status === 'ready' ? 'benchmarking'
                : 'idle',
              shadowRuns: gpuReadinessState.shadowCompletedRuns,
            },
          }));
          // Also send legacy provider:status for Python app backward compat
          ws.send(JSON.stringify({ type: 'provider:status', gpu: _gpuStatus, tier: _tier, reason: deployState.message || 'Current status' }));
          log.log(`[ws] Client connected id=${ws.data.id} (total=${wsClients.size}), sent gpu:status gpu=${_gpuStatus} tier=${_tier}`);
        }
      },
      message(ws, msg) {
        // ── Message size guard — reject oversized payloads ──
        const MAX_WS_MESSAGE_SIZE = 5 * 1024 * 1024; // 5MB
        if (typeof msg !== 'string' && msg.byteLength > MAX_WS_MESSAGE_SIZE) {
          ws.close(1009, 'Message too large');
          return;
        }
        if (typeof msg === 'string' && msg.length > MAX_WS_MESSAGE_SIZE) {
          ws.close(1009, 'Message too large');
          return;
        }

        if (ws.data.type === 'speech') {
          // ── Speech pipeline WS messages ─────────────────────────────
          if (typeof msg === 'string') {
            // JSON config or ping
            try {
              const parsed = JSON.parse(msg) as Record<string, unknown>;
              if (parsed.type === 'config') {
                ws.data.speechConfig = {
                  source: (parsed.source as string) || ws.data.speechConfig?.source || 'fr',
                  target: (parsed.target as string) || ws.data.speechConfig?.target || 'en',
                  speaker: (parsed.speaker as string) || ws.data.speechConfig?.speaker,
                };
                ws.send(JSON.stringify({ type: 'config_ack', ...ws.data.speechConfig }));
              } else if (parsed.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
              }
            } catch { /* ignore parse errors */ }
          } else {
            // Binary message = WAV audio → run pipeline
            const audioBuffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
            if (audioBuffer.length === 0) {
              ws.send(JSON.stringify({ status: 'error', message: 'No audio data' }));
              return;
            }
            const config = ws.data.speechConfig || { source: 'fr', target: 'en' };
            const callbacks: PipelineCallbacks = {
              onStageStart(stage: string) {
                if (ws.readyState !== 1) return;
                ws.send(JSON.stringify({ status: 'processing', stage }));
              },
              onStageDone(stage: string, result) {
                if (ws.readyState !== 1) return;
                const data: Record<string, unknown> = { status: 'processing', stage, latencyMs: result.latencyMs, provider: result.provider };
                if (stage === 'stt' && result.text) data.transcript = result.text;
                if (stage === 'llm' && result.text) data.response = result.text;
                ws.send(JSON.stringify(data));
              },
              onAudioChunk(chunk: Buffer, _isFirst: boolean) {
                if (ws.readyState !== 1) return;
                // Send binary audio frame
                ws.send(chunk);
              },
              onComplete(result: PipelineResult) {
                if (ws.readyState !== 1) return;
                ws.send(JSON.stringify({
                  status: 'complete',
                  transcript: result.transcription,
                  response: result.translation,
                  timing: result.timing,
                }));
              },
              onError(stage: string, error: Error) {
                if (ws.readyState !== 1) return;
                ws.send(JSON.stringify({ status: 'error', stage, message: error.message }));
              },
            };
            runStreamingPipeline(audioBuffer, {
              source: config.source, target: config.target, speaker: config.speaker,
              sessionId: ws.data.id,
            }, callbacks).catch(err => {
              if (ws.readyState !== 1) return;
              ws.send(JSON.stringify({ status: 'error', message: err instanceof Error ? err.message : String(err) }));
            });
          }
        } else if (ws.data.type === 'stt') {
          const backend = sttSessions.get(ws.data.id);
          if (!backend) return;
          if (typeof msg === 'string') {
            // Text message from client: handle control commands
            try {
              const ctrl = JSON.parse(msg);
              if (ctrl.action === 'clear') {
                // clearState is optional on the backend (only some providers support it)
                (backend as { clearState?: () => void }).clearState?.();
              }
            } catch { /* ignore malformed */ }
          } else {
            // Forward binary PCM to upstream backend (msg is Buffer here)
            try {
              backend.sendAudio(msg);
            } catch (sendErr) {
              log.warn('sendAudio failed: %s', sendErr instanceof Error ? sendErr.message : sendErr);
            }
          }
        } else if (ws.data.type === 'recall-audio') {
          // Recall.ai audio: first message is JSON metadata, then binary S16LE 16kHz PCM.
          if (typeof msg === 'string') {
            try {
              const meta = JSON.parse(msg) as Record<string, unknown>;
              log.log(`[recall-audio] Metadata: bot_id=${meta.bot_id} recording_id=${meta.recording_id}`);
            } catch { /* ignore */ }
            return;
          }
          // Binary: raw S16LE 16kHz mono PCM — relay to all Python app clients
          const recallChunk = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
          for (const client of wsClients) {
            try { client.send(recallChunk); } catch { wsClients.delete(client); }
          }
        } else if (ws.data.type === 'bot-audio') {
          // Bot audio: first JSON message is handshake (has protocol_version),
          // subsequent JSON messages are speaker state updates (array of speakers).
          // Binary messages are raw Int16 PCM audio chunks.
          if (typeof msg === 'string') {
            try {
              const parsed = JSON.parse(msg);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.protocol_version) {
                log.log(`[bot-audio] Handshake: sample_rate=${parsed.sample_rate} bot_id=${parsed.bot_id}`);
                botAudioSampleRate = parsed.sample_rate ?? 16000;
              }
              // Speaker state updates (arrays) — ignore, not audio
            } catch { /* ignore */ }
            return;
          }
          // Relay binary audio to all connected Python clients
          botAudioChunks++;
          if (botAudioChunks === 1 || botAudioChunks % 500 === 0) {
            log.log(`[bot-audio] Relaying audio chunk #${botAudioChunks} (${msg.byteLength} bytes) to ${wsClients.size} clients`);
          }
          for (const client of wsClients) {
            try { client.send(msg); } catch { wsClients.delete(client); }
          }
          // Auto-process: buffer audio and run through pipeline when enough accumulates
          const audioChunk = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
          botAudioBuffer.push(audioChunk);
          botAudioBufferBytes += audioChunk.length;
          // Cap buffer to prevent OOM on runaway audio streams
          if (botAudioBufferBytes > BOT_AUDIO_MAX_BUFFER_BYTES) {
            log.warn(`[bot-audio] Buffer exceeded ${BOT_AUDIO_MAX_BUFFER_BYTES / 1024 / 1024}MB — dropping oldest chunks`);
            while (botAudioBufferBytes > BOT_AUDIO_CHUNK_THRESHOLD && botAudioBuffer.length > 1) {
              botAudioBufferBytes -= botAudioBuffer.shift()!.length;
            }
          }
          if (botAudioBufferBytes >= BOT_AUDIO_CHUNK_THRESHOLD) {
            processBotAudioBuffer().catch(e => log.warn('buffer processing failed: %s', e instanceof Error ? e.message : e));
          }
        } else {
          try {
            const raw = typeof msg === 'string' ? msg : (Buffer.isBuffer(msg) ? msg : Buffer.from(msg)).toString();
            const cmd = JSON.parse(raw) as Record<string, unknown>;
            handleWsCommand(ws as unknown as BabelCastWS, cmd).catch(err => log.error('Command error: %s', err instanceof Error ? err.message : err));
          } catch { /* ignore parse errors */ }
        }
      },
      close(ws) {
        wsConnectionCount--;
        // Clean up speculative cache on disconnect
        speculativeCache.clear(ws.data.id);

        if (ws.data.type === 'speech') {
          log.log(`[speech-ws] Client disconnected id=${ws.data.id}`);
        } else if (ws.data.type === 'stt') {
          const backend = sttSessions.get(ws.data.id);
          // Clear the STT accumulation timer (trapped in connectBackend closure)
          (backend as any)?._clearSttAccumTimer?.();
          backend?.close();
          sttSessions.delete(ws.data.id);
          log.log(`[stt-ws] Client disconnected id=${ws.data.id}`);
        } else if (ws.data.type === 'recall-audio') {
          log.log(`[recall-audio] Recall bot disconnected id=${ws.data.id}`);
          import('./recall-handlers').then(({ recallState, setRecallState }) => {
            if (recallState.wsConnected) {
              setRecallState({ wsConnected: false, status: 'ended', message: 'Recall bot disconnected' });
              setTimeout(() => {
                if (recallState.status === 'ended') setRecallState({ status: 'idle', message: '' });
              }, 5_000);
            }
          }).catch(() => {});
        } else if (ws.data.type === 'bot-audio') {
          if (botAudioSource === ws) botAudioSource = null;
          log.log(`[bot-audio] Bot audio source disconnected id=${ws.data.id} (${botAudioChunks} chunks relayed, ${botAudioBufferBytes} bytes buffered)`);
          // Flush remaining audio, then clear (processBotAudioBuffer grabs+clears the buffer atomically)
          if (botAudioBufferBytes >= 16000) {
            processBotAudioBuffer().catch(e => log.warn('final buffer flush failed: %s', e instanceof Error ? e.message : e));
          } else {
            // Not enough audio to process — just discard
            botAudioBuffer = [];
            botAudioBufferBytes = 0;
          }
          botAudioChunks = 0;
          botAudioProcessing = false;
          // Reset held PCM state so a new bot-audio session doesn't inherit stale data
          botAudioHeldPcm = null;
          botAudioHeldMergeCount = 0;
        } else {
          unsubscribeDub(ws.data.id);
          wsClients.delete(ws as unknown as BabelCastWS);
          log.log(`[ws] Client disconnected id=${ws.data.id} (total=${wsClients.size})`);
        }
      },
    },
  });

  // Optional DB connection — ws-server works without it (noopPrisma fallback).
  // Uses require() so Bun doesn't resolve @prisma at parse time.
  if (process.env.DATABASE_URL) {
    try {
      const { initPrisma } = require('./prisma-init');
      initPrisma().catch((e: any) => log.warn('DB init failed: %s', e?.message?.slice(0, 80)));
    } catch {
      log.warn('[ws-server] prisma-init not available — running without DB');
    }
  } else {
    log.warn('[ws-server] DATABASE_URL not set — running without DB');
  }

  // ── HTTP API server on PORT (REST endpoints for GPU handlers) ──────────
  try {
    const gh = require('./gpu-handlers');
    const ch = require('./config-handlers');
    const bh = require('./bot-handlers');
    const mt = require('./metrics');

    const handlers: Record<string, (req: any, res: any) => void> = {
      // GPU
      'POST /v1/gpu/deploy': gh.handleGpuDeploy,
      'GET /v1/gpu/status': gh.handleGpuStatus,
      'POST /v1/gpu/stop': gh.handleGpuStop,
      'POST /v1/gpu/resume': gh.handleGpuResume,
      'POST /v1/gpu/terminate': gh.handleGpuTerminate,
      'GET /v1/gpu/logs': gh.handleGpuLogs,
      'GET /v1/gpu/inspect': gh.handleGpuInspect,
      'GET /v1/gpu/deploy-history': gh.handleGpuDeployHistory,
      'GET /v1/gpu/logs/events': gh.handleGpuEventLogs,
      'GET /v1/gpu/offers': gh.handleGpuOffers,
      'GET /v1/gpu/types': gh.handleGpuTypes,
      'GET /v1/gpu/list': gh.handleGpuList,
      'GET /v1/gpu/catalog': gh.handleGpuCatalog,
      'GET /v1/gpu/my-location': gh.handleGpuMyLocation,
      'GET /v1/gpu/reputation': gh.handleGpuReputation,
      'POST /v1/gpu/preflight': gh.handlePreflightCheck,
      'GET /v1/gpu/compatibility': gh.handleGpuCompatibility,
      'GET /v1/gpu/readiness/status': gh.handleGetGpuReadinessStatus,
      'GET /v1/gpu/readiness/history': gh.handleGetGpuReadinessHistory,
      'POST /v1/gpu/readiness/reset': gh.handlePostResetReadiness,
      // Canary deployment status
      'GET /v1/canary/status': gh.handleCanaryStatus,
      // Performance profiling
      'GET /v1/performance': gh.handlePerformanceStats,
      // SnapGPU snapshot CRUD (proxied to the snapgpu-gateway in the GPU pod)
      'POST /v1/gpu/snapshot': gh.handleSnapshotCreate,
      'GET /v1/gpu/snapshot': gh.handleSnapshotList,
      'POST /v1/gpu/snapshot/restore': gh.handleSnapshotRestore,  // /v1/gpu/snapshot/:id/restore handled via URL parsing
      'DELETE /v1/gpu/snapshot': gh.handleSnapshotDelete,  // /v1/gpu/snapshot/:id handled via URL parsing
      'GET /v1/gpu/sweep': async (_req: any, res: any) => {
        try {
          const { sweepAllProviders } = await import('../src/autoscaler/gpu-sweep');
          const report = await sweepAllProviders();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(report));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      },
      'GET /v1/gpu/lifecycle-logs': async (req: any, res: any) => {
        try {
          const { readRecentLogs } = await import('../src/autoscaler/file-lifecycle-logger');
          const url = new URL(req.url, 'http://localhost');
          const lines = parseInt(url.searchParams.get('lines') || '100', 10);
          const logs = readRecentLogs(Math.min(lines, 1000));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(logs));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      },
      'GET /health': gh.handleHealth,
      // Error summary
      'GET /v1/errors/summary': gh.handleErrorSummary,
      'GET /v1/errors/alerts': gh.handleErrorAlerts,
      'POST /v1/errors/alerts/acknowledge': gh.handleErrorAlerts,
      // Config
      'GET /v1/config/providers': ch.handleGetProviderConfig,
      'POST /v1/config/providers': ch.handlePatchProviderConfig,
      'GET /v1/config/api-keys': ch.handleGetApiKeys,
      'POST /v1/config/api-keys': ch.handleSetApiKeys,
      'POST /v1/config/profiles': ch.handleCreateProfile,
      'DELETE /v1/config/profiles': ch.handleDeleteProfile,
      'POST /v1/config/profiles/activate': ch.handleActivateProfile,
      'GET /v1/config/labs': ch.handleGetLabsFlags,
      'POST /v1/config/labs': ch.handlePatchLabsFlags,
      // Bot
      'POST /v1/bot/deploy': bh.handleBotDeploy,
      'GET /v1/bot/status': bh.handleBotStatus,
      'POST /v1/bot/join': bh.handleBotJoin,
      'POST /v1/bot/leave': bh.handleBotLeave,
      'POST /v1/bot/terminate': bh.handleBotTerminate,
      // Metrics
      'GET /v1/requests/log': mt.handleRequestLog,
      'GET /v1/service-stats': mt.handleServiceStats,
      'GET /metrics': mt.handleMetrics,
      // Latency
      'GET /v1/gpu/latency/settings': gh.handleGetLatencySettings,
      'PATCH /v1/gpu/latency/settings': gh.handlePatchLatencySettings,
      'POST /v1/gpu/latency/run': gh.handleTriggerLatencyRun,
      'PATCH /v1/gpu/latency/hosts': gh.handlePatchLatencyHosts,
      'POST /v1/gpu/latency/probe': gh.handleGpuLatencyProbe,
      // GET /v1/gpu/latency/hosts — return host latency data
      'GET /v1/gpu/latency/hosts': async (_req: any, res: any) => {
        try {
          const { getAllHostLatencies } = require('./latency-db');
          const hosts = await getAllHostLatencies();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ hosts }));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ hosts: [] }));
        }
      },
    };
    // Vast.ai template + serverless routes
    try {
      const vgh = require('./gpu-handlers-vast');
      Object.assign(handlers, {
        // Templates
        'GET /v1/gpu/vast/templates': vgh.handleVastTemplates,
        'POST /v1/gpu/vast/templates': vgh.handleVastTemplateCreate,
        'PUT /v1/gpu/vast/templates': vgh.handleVastTemplateUpdate,
        'DELETE /v1/gpu/vast/templates': vgh.handleVastTemplateDelete,
        'POST /v1/gpu/vast/templates/find-or-create': vgh.handleVastTemplateFindOrCreate,
        // Serverless endpoints
        'GET /v1/gpu/vast/endpoints': vgh.handleVastEndpoints,
        'POST /v1/gpu/vast/endpoints': vgh.handleVastEndpointCreate,
        'DELETE /v1/gpu/vast/endpoints': vgh.handleVastEndpointDelete,
        'POST /v1/gpu/vast/endpoints/logs': vgh.handleVastEndpointLogs,
        'POST /v1/gpu/vast/endpoints/route': vgh.handleVastEndpointRoute,
        // Worker groups
        'GET /v1/gpu/vast/workergroups': vgh.handleVastWorkerGroups,
        'POST /v1/gpu/vast/workergroups': vgh.handleVastWorkerGroupCreate,
        'PUT /v1/gpu/vast/workergroups': vgh.handleVastWorkerGroupUpdate,
        'DELETE /v1/gpu/vast/workergroups': vgh.handleVastWorkerGroupDelete,
      });
    } catch (e: any) {
      log.warn(`[ws-server] Vast.ai handlers not loaded: ${e.message?.slice(0, 80)}`);
    }

    // Playground
    try {
      const pg = require('./playground-handlers');
      Object.assign(handlers, {
        'GET /v1/playground/catalog': pg.handlePlaygroundCatalog,
        'POST /v1/playground/stt': pg.handlePlaygroundStt,
        'POST /v1/playground/llm': pg.handlePlaygroundLlm,
        'POST /v1/playground/tts': pg.handlePlaygroundTts,
        'POST /v1/playground/pipeline': pg.handlePlaygroundPipeline,
      });
    } catch { /* playground handlers are optional — absent module means feature off */ }
    // AI handlers (inference endpoints) + Auto-swap
    try {
      const ai = require('./ai-handlers');
      Object.assign(handlers, {
        // Inference
        'POST /v1/transcribe': ai.handleTranscribe,
        // Note: /v1/audio/transcriptions (OpenAI multipart format) is NOT supported.
        // Use POST /v1/transcribe with raw audio/wav body instead.
        'POST /v1/transcribe/ensemble': ai.handleEnsembleTranscribe,
        'POST /v1/chat/completions': ai.handleChatCompletions,
        'POST /v1/translate': ai.handleTranslate,
        'POST /v1/tts/preview': ai.handleTtsPreview,
        'POST /v1/speech': ai.handlePipeline,
        'POST /v1/detect-language': ai.handleDetectLanguage,
        // Auto-swap
        'GET /v1/auto-swap/status': ai.handleAutoSwapStatus,
        'POST /v1/auto-swap/toggle': ai.handleAutoSwapToggle,
        'POST /v1/auto-swap/benchmark': ai.handleAutoSwapBenchmark,
      });
    } catch { /* ai-handlers module optional — serve.ts proxy can run without them */ }

    // Video generation (wan-i2v GPU)
    try {
      const vh = require('./video-handlers');
      Object.assign(handlers, {
        'POST /v1/video/generate': vh.handleVideoGenerate,
      });
    } catch (e: any) {
      log.warn(`[ws-server] video-handlers not loaded: ${e.message?.slice(0, 80)}`);
    }

    // ── Initialize workload registry ────────────────────────────────────
    try {
      const { workloadRegistry } = require('../src/workloads/registry');
      const { GpuWorkloadDriver } = require('../src/workloads/gpu-driver');
      const { BotWorkloadDriver } = require('../src/workloads/bot-driver');
      const { DbWorkloadDriver } = require('../src/workloads/db-driver');
      workloadRegistry.registerDriver(new GpuWorkloadDriver());
      workloadRegistry.registerDriver(new BotWorkloadDriver());
      workloadRegistry.registerDriver(new DbWorkloadDriver());
      log.log('[ws-server] Workload registry initialized (gpu, bot, db drivers)');
    } catch (e: any) {
      log.warn(`[ws-server] Workload registry not available: ${e.message?.slice(0, 80)}`);
    }

    let routeWorkloadRequest: ((req: any, res: any, pathname: string, method: string) => boolean) | null = null;
    try {
      const wh = require('./workload-handlers');
      routeWorkloadRequest = wh.routeWorkloadRequest;
    } catch { /* workload-handlers optional — routing falls through to 404 if absent */ }

    // ── Docker image builder routes ───────────────────────────────────────
    let dockerRoutes: Record<string, Function> = {};
    let matchDockerDynamic: ((method: string, pathname: string) => [Function, string[]] | null) | null = null;
    try {
      const ib = require('./image-build-handlers');
      dockerRoutes = ib.getDockerRoutes();
      matchDockerDynamic = ib.matchDockerDynamicRoute;
      Object.assign(handlers, dockerRoutes);
    } catch (e: any) {
      log.warn(`[ws-server] image-build-handlers not loaded: ${e.message?.slice(0, 80)}`);
    }

    Bun.serve({
      port: PORT,
      fetch: async (req) => {
        const url = new URL(req.url);
        const method = req.method;

        // CORS preflight
        if (method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: {
            'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          }});
        }

        // Workload routes (dynamic :id segments — checked before flat handlers)
        if (routeWorkloadRequest && url.pathname.startsWith('/v1/workloads')) {
          const bodyBuf = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' ? Buffer.from(await req.arrayBuffer()) : null;
          const listeners: Record<string, Function[]> = {};
          const fakeReq: any = {
            method, url: url.pathname + url.search,
            headers: (() => { const h: Record<string, string> = {}; req.headers.forEach((v, k) => { h[k] = v; }); return h; })(),
            on: (ev: string, cb: Function) => { (listeners[ev] = listeners[ev] || []).push(cb); return fakeReq; },
          };
          queueMicrotask(() => {
            if (bodyBuf && bodyBuf.length) (listeners['data'] || []).forEach(cb => cb(bodyBuf));
            (listeners['end'] || []).forEach(cb => cb());
          });

          return new Promise<Response>((resolve) => {
            let statusCode = 200;
            const resHeaders: Record<string, string> = {};
            const chunks: string[] = [];
            const fakeRes: any = {
              writeHead: (code: number, hdrs?: Record<string, string>) => { statusCode = code; fakeRes.statusCode = code; if (hdrs) Object.assign(resHeaders, hdrs); },
              setHeader: (k: string, v: string) => { resHeaders[k] = v; },
              end: (data?: string) => { if (data) chunks.push(data); resolve(new Response(chunks.join(''), {
                status: statusCode,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.get('origin') || '*', ...resHeaders },
              })); },
              write: (data: string) => { chunks.push(data); },
              getHeader: (k: string) => resHeaders[k],
              statusCode: 200,
            };
            if (!routeWorkloadRequest!(fakeReq, fakeRes, url.pathname, method)) {
              resolve(new Response(JSON.stringify({ error: 'Not found' }), {
                status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
              }));
            }
          });
        }

        // Docker dynamic routes (e.g. /v1/docker/builds/:id)
        if (matchDockerDynamic && url.pathname.startsWith('/v1/docker/')) {
          const match = matchDockerDynamic(method, url.pathname);
          if (match) {
            const [dynHandler, params] = match;
            const bodyBuf2 = method !== 'GET' && method !== 'HEAD' ? Buffer.from(await req.arrayBuffer()) : null;
            const listeners2: Record<string, Function[]> = {};
            const fakeReq2: any = {
              method, url: url.pathname + url.search,
              headers: (() => { const h: Record<string, string> = {}; req.headers.forEach((v, k) => { h[k] = v; }); return h; })(),
              on: (ev: string, cb: Function) => { (listeners2[ev] = listeners2[ev] || []).push(cb); return fakeReq2; },
            };
            queueMicrotask(() => {
              if (bodyBuf2 && bodyBuf2.length) (listeners2['data'] || []).forEach(cb => cb(bodyBuf2));
              (listeners2['end'] || []).forEach(cb => cb());
            });
            return new Promise<Response>((resolve) => {
              let statusCode2 = 200;
              const resHeaders2: Record<string, string> = {};
              const chunks2: string[] = [];
              const fakeRes2: any = {
                writeHead: (code: number, hdrs?: Record<string, string>) => { statusCode2 = code; fakeRes2.statusCode = code; if (hdrs) Object.assign(resHeaders2, hdrs); },
                setHeader: (k: string, v: string) => { resHeaders2[k] = v; },
                end: (data?: string) => { if (data) chunks2.push(data); resolve(new Response(chunks2.join(''), {
                  status: statusCode2,
                  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.get('origin') || '*', ...resHeaders2 },
                })); },
                write: (data: string) => { chunks2.push(data); },
                getHeader: (k: string) => resHeaders2[k],
                statusCode: 200,
              };
              dynHandler(fakeReq2, fakeRes2, ...params);
            });
          }
        }

        const key = `${method} ${url.pathname}`;
        const handler = handlers[key];
        if (!handler) {
          return new Response(JSON.stringify({ error: 'Not found', endpoints: Object.keys(handlers) }), {
            status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }

        // Node→Bun adapter (use arrayBuffer for binary-safe body transfer)
        const bodyBuf = method !== 'GET' && method !== 'HEAD' ? Buffer.from(await req.arrayBuffer()) : null;
        const listeners: Record<string, Function[]> = {};
        const fakeReq: any = {
          method, url: url.pathname + url.search,
          headers: (() => { const h: Record<string, string> = {}; req.headers.forEach((v, k) => { h[k] = v; }); return h; })(),
          on: (ev: string, cb: Function) => { (listeners[ev] = listeners[ev] || []).push(cb); return fakeReq; },
        };
        queueMicrotask(() => {
          if (bodyBuf && bodyBuf.length) (listeners['data'] || []).forEach(cb => cb(bodyBuf));
          (listeners['end'] || []).forEach(cb => cb());
        });

        return new Promise<Response>((resolve) => {
          let statusCode = 200;
          const resHeaders: Record<string, string> = {};
          const chunks: string[] = [];
          const fakeRes: any = {
            writeHead: (code: number, hdrs?: Record<string, string>) => { statusCode = code; fakeRes.statusCode = code; if (hdrs) Object.assign(resHeaders, hdrs); },
            setHeader: (k: string, v: string) => { resHeaders[k] = v; },
            end: (data?: string) => { if (data) chunks.push(data); resolve(new Response(chunks.join(''), {
              status: statusCode,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.get('origin') || '*', ...resHeaders },
            })); },
            write: (data: string) => { chunks.push(data); },
            getHeader: (k: string) => resHeaders[k],
            statusCode: 200,
          };
          handler(fakeReq, fakeRes);
        });
      },
    });
    log.log(`[ws-server] HTTP API on port ${PORT}`);
  } catch (e: any) {
    log.warn(`[ws-server] HTTP API not started: ${e.message?.slice(0, 80)}`);
  }

  // ── Startup tasks ─────────────────────────────────────────────────────────
  // 0. Restore persisted daily spend counter (must run before any budget checks)
  try {
    const { loadPersistedDailySpend } = require('./state');
    loadPersistedDailySpend();
  } catch (e: any) {
    log.warn(`[ws-server] loadPersistedDailySpend failed: ${e.message?.slice(0, 80)}`);
  }

  // 1. Restore persisted config (idle timeout, deploy settings, latency targets)
  try {
    const { applyRuntimeConfig } = require('./config-persistence');
    await applyRuntimeConfig();
  } catch (e: any) {
    log.warn(`[ws-server] applyRuntimeConfig failed: ${e.message?.slice(0, 80)}`);
  }

  // 2. Terminate any stopped pod overdue for auto-destroy (timer lost on restart)
  try {
    const { terminateStaleStoppedPodOnStartup } = require('./gpu-deploy');
    terminateStaleStoppedPodOnStartup().catch((e: any) =>
      log.warn(`[ws-server] terminateStaleStoppedPodOnStartup failed: ${e.message?.slice(0, 80)}`)
    );
  } catch (e: any) {
    log.warn(`[ws-server] terminateStaleStoppedPodOnStartup not loaded: ${e.message?.slice(0, 80)}`);
  }

  // 3. Reconnect to any pod that was healthy before restart
  try {
    const { tryRecoverActiveDeploy } = require('./gpu-deploy');
    tryRecoverActiveDeploy().catch((e: any) =>
      log.warn(`[ws-server] tryRecoverActiveDeploy failed: ${e.message?.slice(0, 80)}`)
    );
  } catch (e: any) {
    log.warn(`[ws-server] tryRecoverActiveDeploy not loaded: ${e.message?.slice(0, 80)}`);
  }

  // 4. Auto-boot GPU if profile has bootOnStartup=true
  try {
    const gh = require('./gpu-handlers');
    if (gh.autoBootFromProfile) {
      gh.autoBootFromProfile().catch((e: any) =>
        log.warn(`[ws-server] autoBootFromProfile failed: ${e.message?.slice(0, 80)}`)
      );
    }
  } catch (e: any) {
    log.warn(`[ws-server] autoBootFromProfile not loaded: ${e.message?.slice(0, 80)}`);
  }

  // Start standby monitor — auto-deploys a warm GPU when session duration or
  // P95 latency thresholds are exceeded (standbyEnabled controls gating inside).
  try {
    const { startStandbyMonitor } = require('./gpu-standby');
    startStandbyMonitor();
  } catch (e: any) {
    log.warn('[ws-server] Standby monitor not started:', e?.message?.slice(0, 80));
  }

  return WS_PORT;
}

// Auto-start when run directly (bun server/ws-server.ts)
if (typeof Bun !== 'undefined' && Bun.main === import.meta.path) {
  startWsServer().then((port) => {
    log.log('Listening on WS port %d, HTTP port %d', port, PORT);
  });
}
