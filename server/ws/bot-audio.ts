// ── Bot audio buffer, VAD-like processing, PulseAudio capture ─────────────────
// Buffers incoming bot PCM chunks. When enough audio accumulates (VAD-like),
// runs the speech pipeline (STT→LLM→TTS) and broadcasts subtitle:early.

import { createLogger } from '../../src/logger';
import type { Subprocess } from 'bun';
import { botState } from '../state';
import { broadcastWs, wsClients, isBackpressured } from '../ws-state';
import type { BabelCastWS } from '../ws-state';
import { runStreamingPipeline } from '../pipeline-runner';
import type { PipelineCallbacks, PipelineResult } from '../pipeline-runner';
import { BOT_LOCAL_CONTAINER } from '../bot-handlers';
import { buildSystemPrompt, getCloudProfile } from '../ai-handlers';
import { client } from '../providers';
import { langNames } from '../http-utils';
import { safeCatch } from '../../src/safe-catch';

const log = createLogger('ws-bot-audio');

// ── Exported state (imported by ws-server and bot-handlers) ──────────────────
export let botAudioSource: BabelCastWS | null = null;
export function setBotAudioSource(ws: BabelCastWS | null): void { botAudioSource = ws; }

/**
 * Claim the single global bot-audio source slot for `ws`.
 *
 * The bot-audio buffer/relay is process-global, so a second concurrent
 * `/ws/bot-audio` connection would silently hijack the stream — and the first
 * one's `close` (`if (botAudioSource === ws) setBotAudioSource(null)`) would no
 * longer match, leaving stale state. Rather than clobber, reject the newcomer
 * unless the incumbent socket is already gone (readyState !== OPEN), in which
 * case we take over (handles a half-open socket whose `close` never fired).
 *
 * @returns true if the slot was claimed, false if an active source already holds it.
 */
export function trySetBotAudioSource(ws: BabelCastWS): boolean {
  const current = botAudioSource;
  if (current && current !== ws) {
    // OPEN === 1 in the WS readyState enum; treat anything else as not-live.
    const incumbentLive = (current as { readyState?: number }).readyState === 1;
    if (incumbentLive) return false;
  }
  botAudioSource = ws;
  return true;
}

export let botAudioSampleRate = 48000;
export function setBotAudioSampleRate(rate: number): void { botAudioSampleRate = rate; }

/**
 * Default sample rate to assume when a bot-audio source streams binary PCM
 * without first sending the `{protocol_version, sample_rate}` handshake (#444).
 * Recall/meeting bots negotiate 48 kHz, so guessing 16 kHz here would mislabel
 * the WAV header and corrupt STT; default explicitly to 48 kHz instead.
 */
export const BOT_AUDIO_DEFAULT_SAMPLE_RATE = 48000;

/**
 * Parse a bot-audio control message. Returns the negotiated sample rate when
 * the JSON is a valid handshake (has `protocol_version`), else null. Pure —
 * lets the server validate/handshake-gate before touching module state (#444).
 */
export function parseBotAudioHandshake(raw: string): { sampleRate: number } | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.protocol_version) {
      const rate = typeof parsed.sample_rate === 'number' && parsed.sample_rate > 0
        ? parsed.sample_rate
        : BOT_AUDIO_DEFAULT_SAMPLE_RATE;
      return { sampleRate: rate };
    }
  } catch { /* not JSON */ }
  return null;
}

let botAudioChunks = 0;
export function getBotAudioChunks(): number { return botAudioChunks; }
export function incBotAudioChunks(): number { return ++botAudioChunks; }
export function resetBotAudioChunks(): void { botAudioChunks = 0; }

let botAudioBuffer: Buffer[] = [];
let botAudioBufferBytes = 0;
let botAudioProcessing = false;
let botAudioLastProcess = 0;
// Held audio from a previous short/meaningless segment — merged with the next chunk
let botAudioHeldPcm: Buffer | null = null;
let botAudioHeldMergeCount = 0;

export function getBotAudioBufferBytes(): number { return botAudioBufferBytes; }

// Bot language pair — set from bot:join command, reset on bot:leave
let botSourceLang = 'fr';
let botTargetLang = 'en';
export function setBotLangPair(source: string, target: string): void {
  botSourceLang = source;
  botTargetLang = target;
}
export function resetBotLangPair(): void {
  botSourceLang = 'fr';
  botTargetLang = 'en';
}
export function getBotSourceTarget(): { source: string; target: string } {
  return { source: botSourceLang, target: botTargetLang };
}

// Config: process every ~3s of audio (16kHz 16-bit mono = 32000 bytes/s → ~96KB)
export const BOT_AUDIO_CHUNK_THRESHOLD = 3 * 32000; // 3 seconds at 16kHz 16-bit
const BOT_AUDIO_MIN_INTERVAL_MS = 2000; // don't process more than once every 2s
export const BOT_AUDIO_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB cap to prevent OOM
// Segment merge limits
const BOT_AUDIO_MAX_MERGE_COUNT = 3;        // max merges before forcing output
const BOT_AUDIO_MAX_HELD_BYTES = 15 * 32000; // max 15s of held audio

/** Append a binary audio chunk to the bot audio buffer. */
export function appendBotAudioChunk(chunk: Buffer): void {
  botAudioBuffer.push(chunk);
  botAudioBufferBytes += chunk.length;
  if (botAudioBufferBytes > BOT_AUDIO_MAX_BUFFER_BYTES) {
    log.warn(`[bot-audio] Buffer exceeded ${BOT_AUDIO_MAX_BUFFER_BYTES / 1024 / 1024}MB — dropping oldest chunks`);
    // Drop oldest by byte budget while preserving the latest audio (#447);
    // shifting until under a count threshold could discard the newest speech
    // when chunks are large.
    const trimmed = trimChunksToByteBudget(botAudioBuffer, BOT_AUDIO_CHUNK_THRESHOLD);
    botAudioBuffer = trimmed.chunks;
    botAudioBufferBytes = trimmed.bytes;
  }
}

/** True when the buffer has reached the processing threshold. */
export function shouldProcessBotAudio(): boolean {
  return botAudioBufferBytes >= BOT_AUDIO_CHUNK_THRESHOLD;
}

/** Clear the bot audio buffer state entirely. */
export function clearBotAudioBuffer(): void {
  botAudioBuffer = [];
  botAudioBufferBytes = 0;
  botAudioHeldPcm = null;
  botAudioHeldMergeCount = 0;
}

/** Reset processing flag (used on disconnect). */
export function resetBotAudioProcessing(): void {
  botAudioProcessing = false;
}

/** Returns true if the transcription is a meaningful phrase (not just stray letters/words). */
function isMeaningfulTranscription(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  return words.length >= 3 || trimmed.length >= 15;
}

/**
 * Build a canonical 44-byte WAV header for 16-bit mono PCM at the negotiated
 * sample rate (#442 cache the field layout in one place, #443 use the
 * handshake-negotiated rate and derive byte-rate from it instead of assuming
 * 16 kHz / 32000 B/s). byteRate = sampleRate * channels * bytesPerSample
 * = sampleRate * 1 * 2; blockAlign = 2.
 */
export function buildWavHeader(sampleRate: number, dataSize: number): Buffer {
  const rate = sampleRate > 0 ? sampleRate : 16000;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(dataSize + 36, 4);     // fileSize
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);               // fmt chunk size
  h.writeUInt16LE(1, 20);                // PCM
  h.writeUInt16LE(1, 22);                // mono
  h.writeUInt32LE(rate, 24);             // sample rate
  h.writeUInt32LE(rate * 2, 28);         // byte rate = rate * channels(1) * bytes(2)
  h.writeUInt16LE(2, 32);                // block align
  h.writeUInt16LE(16, 34);               // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataSize, 40);
  return h;
}

/**
 * Trim a list of PCM chunks down to at most `maxBytes`, preserving the most
 * recent audio (#447). The old overflow path shifted from the front until the
 * total fell under a count-ish threshold, which on large chunks could discard
 * the *latest* speech. Here we always keep the trailing bytes (newest first
 * from the end) and drop the oldest, returning the kept chunks + their byte
 * total. Pure — no module state.
 */
export function trimChunksToByteBudget(chunks: Buffer[], maxBytes: number): { chunks: Buffer[]; bytes: number } {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total <= maxBytes) return { chunks, bytes: total };
  // Walk from the newest chunk backwards, keeping until we'd exceed the budget.
  const kept: Buffer[] = [];
  let keptBytes = 0;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i];
    if (keptBytes + c.length > maxBytes) break;
    kept.push(c);
    keptBytes += c.length;
  }
  kept.reverse(); // restore chronological order
  return { chunks: kept, bytes: keptBytes };
}

/** Force-flush bot audio buffer (called on disconnect or when buffer is too large) */
export function flushBotAudioBuffer(): void {
  if (botAudioBufferBytes > 0 && botAudioBufferBytes >= 16000) { // at least 0.5s of audio
    processBotAudioBuffer().catch(e => log.warn('[bot-audio] Flush failed:', e instanceof Error ? e.message : e));
  } else {
    clearBotAudioBuffer();
  }
}

export async function processBotAudioBuffer(): Promise<void> {
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
    // Use the handshake-negotiated sample rate (#443). byte-rate is derived
    // from it inside buildWavHeader so a 48 kHz stream isn't mislabeled 16 kHz.
    const sampleRate = botAudioSampleRate || 16000;
    const wavHeader = buildWavHeader(sampleRate, pcmData.length);
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

let parecProc: Subprocess | null = null;
let parecChunks = 0;

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
            // Real-time PCM: drop frames for saturated viewers rather than
            // accumulating megabytes of late audio (wastes RAM + risks
            // backpressure-close). A dropped 20ms frame is a non-event.
            if (isBackpressured(client)) continue;
            try { client.send(chunk); } catch { wsClients.delete(client); }
          }

          // Auto-process: buffer parec audio for pipeline processing (same as bot-audio)
          const buf = Buffer.from(chunk);
          appendBotAudioChunk(buf);
          if (shouldProcessBotAudio()) {
            processBotAudioBuffer().catch(safeCatch('bot-audio-process'));
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
    proc.exited.catch(safeCatch('parec-proc-exit')); // fire-and-forget await — ensures process cleanup
  }
}

/**
 * Build a translation function for speculative cache that uses the same
 * LLM routing as the normal pipeline (cloud providers).
 */
export function buildSpeculativeTranslateFn(source: string, target: string, style: string): (text: string) => Promise<string> {
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
