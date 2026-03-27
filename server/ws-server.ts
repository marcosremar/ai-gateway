// ── BabelCast Gateway — WebSocket Server ─────────────────────────────────────
// handleWsCommand, startWsServer() — Bun native WS on PORT+1.

import { botState, deployState, gpuHealthy, gpuModelWarmth, gpuReadinessState, gpuReadyForProduction, isStageWarm, isTtsWarm } from './state';
import {
  shouldPreferGpuTts,
  client, groqProfile, ollamaProfile, translationProfile,
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
function buildStreamingProviderOrder(): string[] {
  try {
    const config = loadProviderConfig();
    const sttChain = config.pipelineStt || [];
    // Filter: only providers with sttType === 'streaming' (or gpu/fireworks which are streaming by default)
    const STREAMING_PROVIDERS = new Set(['gpu', 'fireworks', 'qwen3-asr', 'mlx-qwen3-asr']);
    const order = sttChain
      .filter(e => e.sttType === 'streaming' || (!e.sttType && STREAMING_PROVIDERS.has(e.provider)))
      .map(e => e.provider);
    if (order.length > 0) return order;
  } catch (e) { console.warn('[ws] streaming provider order parse failed:', e instanceof Error ? e.message : e); }
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

let sttRouter = new StreamingSTTRouter({
  getGpuUrl: () => deployState.status === 'ready' && deployState.endpoint ? deployState.endpoint : null,
  getQwen3AsrUrl,
  get fireworksApiKey() { return process.env.FIREWORKS_API_KEY ?? ''; },
  providerOrder: buildStreamingProviderOrder(),
});

/** Rebuild the streaming STT router from config (call after config changes). */
export function reloadStreamingSTTRouter(): void {
  const order = buildStreamingProviderOrder();
  sttRouter = new StreamingSTTRouter({
    getGpuUrl: () => deployState.status === 'ready' && deployState.endpoint ? deployState.endpoint : null,
    getQwen3AsrUrl,
    get fireworksApiKey() { return process.env.FIREWORKS_API_KEY ?? ''; },
    providerOrder: order,
  });
  console.log(`[ws] Streaming STT router reloaded: order=[${order.join(',')}]`);
}

// Active STT sessions: client WS id → upstream backend
const sttSessions = new Map<string, import('../ai-gateway/src/streaming-stt').StreamingSTTBackend>();

// Bot audio relay state
let botAudioSource: BabelCastWS | null = null;
let botAudioSampleRate = 16000;
let botAudioChunks = 0;

// ── Bot audio → pipeline auto-processing ─────────────────────────────────
// Buffers incoming bot PCM chunks. When enough audio accumulates (VAD-like),
// runs the speech pipeline (STT→LLM→TTS) and broadcasts subtitle:early.

let botAudioBuffer: Buffer[] = [];
let botAudioBufferBytes = 0;
let botAudioProcessing = false;
let botAudioLastProcess = 0;

// Bot language pair — set from bot:join command, reset on bot:leave
let botSourceLang = 'fr';
let botTargetLang = 'en';

// Config: process every ~3s of audio (16kHz 16-bit mono = 32000 bytes/s → ~96KB)
const BOT_AUDIO_CHUNK_THRESHOLD = 3 * 32000; // 3 seconds at 16kHz 16-bit
const BOT_AUDIO_MIN_INTERVAL_MS = 2000; // don't process more than once every 2s
const BOT_AUDIO_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB cap to prevent OOM

/** Force-flush bot audio buffer (called on disconnect or when buffer is too large) */
function flushBotAudioBuffer(): void {
  if (botAudioBufferBytes > 0 && botAudioBufferBytes >= 16000) { // at least 0.5s of audio
    processBotAudioBuffer().catch(e => console.warn('[bot-audio] Flush failed:', e instanceof Error ? e.message : e));
  } else {
    botAudioBuffer = [];
    botAudioBufferBytes = 0;
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
  const totalBytes = botAudioBufferBytes;
  botAudioBuffer = [];
  botAudioBufferBytes = 0;

  try {
    // Convert Int16 PCM to WAV
    const pcmData = Buffer.concat(chunks);
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
    console.log(`[bot-audio] Processing ${(totalBytes / 1024).toFixed(0)}KB audio (${(totalBytes / 32000).toFixed(1)}s) ${source}→${target}`);

    const callbacks: PipelineCallbacks = {
      onStageStart() {},
      onStageDone() {},
      onAudioChunk() {},
      onComplete(result: PipelineResult) {
        if (result.transcription?.trim()) {
          console.log(`[bot-audio] Pipeline: "${result.transcription.slice(0, 40)}" → "${result.translation?.slice(0, 40)}"`);
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
        }
      },
      onError(stage: string, error: Error) {
        console.error(`[bot-audio] Pipeline error at ${stage}: ${error.message}`);
      },
    };

    await runStreamingPipeline(wavBuffer, {
      source, target,
    }, callbacks);
  } catch (err) {
    console.error(`[bot-audio] Pipeline error:`, err instanceof Error ? err.message : err);
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

export function startParecCapture(): void {
  if (parecProc) return;
  parecChunks = 0;

  const containerName = botState.podId === 'local' ? BOT_LOCAL_CONTAINER : '';
  if (!containerName) {
    console.log('[parec] Skipping parec capture — not a local Docker bot');
    return;
  }

  console.log(`[parec] Starting PulseAudio capture from container ${containerName}...`);
  parecProc = Bun.spawn([
    'docker', 'exec', containerName,
    'parec', '--format=s16le', '--channels=1', '--rate=16000',
    '--device=virtual_speaker.monitor',
  ], { stdout: 'pipe', stderr: 'pipe' });

  // Read stderr for errors
  (async () => {
    if (!parecProc?.stderr) return;
    const reader = parecProc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value).trim();
        if (text) console.warn(`[parec] stderr: ${text}`);
      }
    } catch { /* ignore */ }
  })();

  // Read stdout: raw Int16 PCM → relay to WS clients in ~20ms chunks (640 bytes = 320 samples)
  const CHUNK_SIZE = 640; // 320 samples × 2 bytes = 20ms at 16kHz
  let buffer = new Uint8Array(0);

  (async () => {
    if (!parecProc?.stdout) return;
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
            console.log(`[parec] Relaying chunk #${parecChunks} (${chunk.length} bytes) to ${wsClients.size} clients`);
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
      console.warn(`[parec] Read error: ${err}`);
    }
    console.log(`[parec] Capture ended (${parecChunks} chunks sent)`);
    parecProc = null;
  })();
}

export function stopParecCapture(): void {
  if (parecProc) {
    console.log(`[parec] Stopping PulseAudio capture (${parecChunks} chunks sent)...`);
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
  console.log(`[ws] Command from client: ${type}`);

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

    // Reuse existing handleBotJoin logic by faking an HTTP request
    const fakeBody = { meetingUrl, source: sourceLang, target: targetLang, botName };
    const { IncomingMessage, ServerResponse } = await import('http');
    const { Duplex } = await import('stream');

    // Build minimal fake req/res to reuse handleBotJoin
    const fakeReq = Object.assign(new IncomingMessage(new Duplex()), {
      _body: JSON.stringify(fakeBody),
    });
    // Instead of full fake req/res, directly call the join logic inline:
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
      streaming_audio_frequency: 16000,
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
      broadcastWs({ type: 'bot:status', status: 'error', message: `Join failed: ${err}` });
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
    speculativeCache.speculate(sessionId, text, translateFn).catch(e => console.warn('[ws] speculative translate failed:', e instanceof Error ? e.message : e));

  } else if (type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
  }
}

type WsData = {
  id: string;
  type: 'bot' | 'stt' | 'bot-audio' | 'speech';
  language?: string;
  /** Target language for STT sessions — enables auto-speculation when set. */
  speculateTarget?: string;
  /** Silence timeout before flushing accumulated STT text (ms). Default 700. */
  pauseMs?: number;
  speechConfig?: { source: string; target: string; speaker?: string };
};

export function startWsServer() {
  const WS_PORT = PORT + 1;
  Bun.serve<WsData>({
    port: WS_PORT,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket authentication — always check auth.
      // Localhost exemption: if no GATEWAY_API_KEY is set AND connection is from localhost, allow it.
      const expectedToken = process.env.GATEWAY_API_KEY;
      const authToken = url.searchParams.get('token') || req.headers.get('authorization')?.replace('Bearer ', '');
      if (expectedToken) {
        // API key is configured — always require valid token
        if (authToken !== expectedToken) {
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
        const pauseMs = parseInt(url.searchParams.get('pause_ms') || '700', 10);
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
      open(ws) {
        if (ws.data.type === 'speech') {
          // ── Speech pipeline session ────────────────────────────────
          ws.send(JSON.stringify({ type: 'connected', message: 'Speech pipeline ready. Send config JSON then binary WAV.' }));
          console.log(`[speech-ws] Client connected id=${ws.data.id}`);
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
              console.log(`[stt-ws] Backend connected: ${backend.provider} id=${ws.data.id}`);
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

            const emitText = (text: string) => {
              if (!text || ws.readyState !== 1) return;
              ws.send(JSON.stringify({ type: 'text', text, provider: backend.provider }));
              // Push to STT context window and seed backend (GPU/Qwen3-ASR only)
              sttContext.push(text);
              while (sttContext.length > STT_CONTEXT_MAX) sttContext.shift();
              backend.sendSeed(sttContext.join(' '));
              // Speculative translation
              const labs = getLabsFlags();
              if (labs.speculativeTranslation && ws.data.speculateTarget && text) {
                const srcLang = ws.data.language || 'fr';
                const tgtLang = ws.data.speculateTarget;
                const translateFn = buildSpeculativeTranslateFn(srcLang, tgtLang, 'default');
                speculativeCache.speculate(ws.data.id, text, translateFn).catch(e => console.warn('[ws] speculative translate failed:', e instanceof Error ? e.message : e));
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
              console.log(`[stt-ws] Backend ${backend.provider} disconnected: ${reason} id=${ws.data.id}`);
              sttSessions.delete(ws.data.id);
              if (ws.readyState !== 1 /* OPEN */) return; // client already gone
              // Always try to reconnect with next available provider.
              // connectBackend() handles the "no provider" case by closing the client WS.
              excluded.add(backend.provider);
              console.log(`[stt-ws] Reconnecting (excluded: ${[...excluded].join(',')}) id=${ws.data.id}`);
              try {
                connectBackend();
              } catch (e) {
                console.warn(`[stt-ws] Reconnect failed — closing client WS:`, e instanceof Error ? e.message : e);
                ws.close(1001, 'STT backend reconnect failed');
              }
            };
            backend.connect();
            sttSessions.set(ws.data.id, backend);
            console.log(`[stt-ws] Client connected id=${ws.data.id} lang=${language || 'auto'} provider=${backend.provider}`);
          };
          connectBackend();
        } else if (ws.data.type === 'bot-audio') {
          // ── Bot audio relay — meeting bot streams raw PCM here ──────
          console.log(`[bot-audio] Bot audio source connected id=${ws.data.id}`);
          botAudioSource = ws as unknown as BabelCastWS;
        } else {
          // ── Bot events session ─────────────────────────────────────
          const MAX_WS_CLIENTS = 500;
          if (wsClients.size >= MAX_WS_CLIENTS) {
            console.warn(`[ws] Connection limit reached (${MAX_WS_CLIENTS}) — rejecting`);
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
          console.log(`[ws] Client connected id=${ws.data.id} (total=${wsClients.size}), sent gpu:status gpu=${_gpuStatus} tier=${_tier}`);
        }
      },
      message(ws, msg) {
        // ── Message size guard — reject oversized payloads ──
        const MAX_WS_MESSAGE_SIZE = 5 * 1024 * 1024; // 5MB
        if (typeof msg !== 'string' && (msg as ArrayBuffer).byteLength > MAX_WS_MESSAGE_SIZE) {
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
            const audioBuffer = Buffer.from(msg as ArrayBuffer);
            if (audioBuffer.length === 0) {
              ws.send(JSON.stringify({ status: 'error', message: 'No audio data' }));
              return;
            }
            const config = ws.data.speechConfig || { source: 'fr', target: 'en' };
            const callbacks: PipelineCallbacks = {
              onStageStart(stage: string) {
                ws.send(JSON.stringify({ status: 'processing', stage }));
              },
              onStageDone(stage: string, result) {
                const data: Record<string, unknown> = { status: 'processing', stage, latencyMs: result.latencyMs, provider: result.provider };
                if (stage === 'stt' && result.text) data.transcript = result.text;
                if (stage === 'llm' && result.text) data.response = result.text;
                ws.send(JSON.stringify(data));
              },
              onAudioChunk(chunk: Buffer, _isFirst: boolean) {
                // Send binary audio frame
                ws.send(chunk);
              },
              onComplete(result: PipelineResult) {
                ws.send(JSON.stringify({
                  status: 'complete',
                  transcript: result.transcription,
                  response: result.translation,
                  timing: result.timing,
                }));
              },
              onError(stage: string, error: Error) {
                ws.send(JSON.stringify({ status: 'error', stage, message: error.message }));
              },
            };
            runStreamingPipeline(audioBuffer, {
              source: config.source, target: config.target, speaker: config.speaker,
              sessionId: ws.data.id,
            }, callbacks).catch(err => {
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
                backend.clearState?.();
              }
            } catch { /* ignore malformed */ }
          } else {
            // Forward binary PCM to upstream backend
            backend.sendAudio(msg as ArrayBuffer);
          }
        } else if (ws.data.type === 'bot-audio') {
          // Bot audio: first JSON message is handshake (has protocol_version),
          // subsequent JSON messages are speaker state updates (array of speakers).
          // Binary messages are raw Int16 PCM audio chunks.
          if (typeof msg === 'string') {
            try {
              const parsed = JSON.parse(msg);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.protocol_version) {
                console.log(`[bot-audio] Handshake: sample_rate=${parsed.sample_rate} bot_id=${parsed.bot_id}`);
                botAudioSampleRate = parsed.sample_rate ?? 16000;
              }
              // Speaker state updates (arrays) — ignore, not audio
            } catch { /* ignore */ }
            return;
          }
          // Relay binary audio to all connected Python clients
          botAudioChunks++;
          if (botAudioChunks === 1 || botAudioChunks % 500 === 0) {
            console.log(`[bot-audio] Relaying audio chunk #${botAudioChunks} (${(msg as ArrayBuffer).byteLength} bytes) to ${wsClients.size} clients`);
          }
          for (const client of wsClients) {
            try { client.send(msg); } catch { wsClients.delete(client); }
          }
          // Auto-process: buffer audio and run through pipeline when enough accumulates
          const audioChunk = Buffer.from(msg as ArrayBuffer);
          botAudioBuffer.push(audioChunk);
          botAudioBufferBytes += audioChunk.length;
          // Cap buffer to prevent OOM on runaway audio streams
          if (botAudioBufferBytes > BOT_AUDIO_MAX_BUFFER_BYTES) {
            console.warn(`[bot-audio] Buffer exceeded ${BOT_AUDIO_MAX_BUFFER_BYTES / 1024 / 1024}MB — dropping oldest chunks`);
            while (botAudioBufferBytes > BOT_AUDIO_CHUNK_THRESHOLD && botAudioBuffer.length > 1) {
              botAudioBufferBytes -= botAudioBuffer.shift()!.length;
            }
          }
          if (botAudioBufferBytes >= BOT_AUDIO_CHUNK_THRESHOLD) {
            processBotAudioBuffer().catch(e => console.warn('[bot-audio] buffer processing failed:', e instanceof Error ? e.message : e));
          }
        } else {
          try {
            const raw = typeof msg === 'string' ? msg : Buffer.from(msg as ArrayBuffer).toString();
            const cmd = JSON.parse(raw) as Record<string, unknown>;
            handleWsCommand(ws as unknown as BabelCastWS, cmd).catch(err => console.error('[ws] Command error:', err));
          } catch { /* ignore parse errors */ }
        }
      },
      close(ws) {
        // Clean up speculative cache on disconnect
        speculativeCache.clear(ws.data.id);

        if (ws.data.type === 'speech') {
          console.log(`[speech-ws] Client disconnected id=${ws.data.id}`);
        } else if (ws.data.type === 'stt') {
          const backend = sttSessions.get(ws.data.id);
          backend?.close();
          sttSessions.delete(ws.data.id);
          console.log(`[stt-ws] Client disconnected id=${ws.data.id}`);
        } else if (ws.data.type === 'bot-audio') {
          if (botAudioSource === ws) botAudioSource = null;
          console.log(`[bot-audio] Bot audio source disconnected id=${ws.data.id} (${botAudioChunks} chunks relayed, ${botAudioBufferBytes} bytes buffered)`);
          // Flush remaining audio, then clear (processBotAudioBuffer grabs+clears the buffer atomically)
          if (botAudioBufferBytes >= 16000) {
            processBotAudioBuffer().catch(e => console.warn('[bot-audio] final buffer flush failed:', e instanceof Error ? e.message : e));
          } else {
            // Not enough audio to process — just discard
            botAudioBuffer = [];
            botAudioBufferBytes = 0;
          }
          botAudioChunks = 0;
          botAudioProcessing = false;
        } else {
          unsubscribeDub(ws.data.id);
          wsClients.delete(ws as unknown as BabelCastWS);
          console.log(`[ws] Client disconnected id=${ws.data.id} (total=${wsClients.size})`);
        }
      },
    },
  });
  return WS_PORT;
}
