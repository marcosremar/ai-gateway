/**
 * Test helpers — shared utilities for integration tests.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Run a command on a remote cluster via SSH and return stdout.
 * @param cluster  SSH target (e.g. "user@host" or alias from ~/.ssh/config)
 * @param cmd      Shell command to execute remotely
 */
export function ssh(cluster: string, cmd: string): string {
  return execSync(`ssh ${cluster} '${cmd.replace(/'/g, "'\\''")}'`, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
}

/**
 * Parse a JSON string, throwing a descriptive error if it fails.
 */
export function parseJSON(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`parseJSON failed. Raw value:\n${raw}`);
  }
}

/** Load .env file into process.env (no dotenv dependency) */
export function loadEnv(): void {
  // Try package-level .env first, then root web/.env
  const paths = [
    join(__dirname, '..', '.env'),
    join(__dirname, '..', '..', '..', '.env'),
  ];
  for (const envPath of paths) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    } catch {
      // File not found — try next path
    }
  }
}

/** Poll until condition is true or timeout */
export async function waitFor(
  fn: () => Promise<boolean>,
  { intervalMs = 5000, timeoutMs = 120_000, label = 'condition' } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    console.log(`  [wait] ${label} — retrying in ${intervalMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for ${label} after ${timeoutMs / 1000}s`);
}

/** Skip test if env var is missing */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`SKIP: ${name} not set`);
  }
  return value;
}

/** Generate a minimal valid WAV buffer (16-bit PCM, 16kHz mono, ~0.5s silence) */
export function makeTestWav(durationSecs = 0.5, sampleRate = 16000): Buffer {
  const numSamples = Math.floor(sampleRate * durationSecs);
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20);  // PCM
  buffer.writeUInt16LE(1, 22);  // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);  // block align
  buffer.writeUInt16LE(16, 34); // bits per sample

  // data chunk — leave as silence (zeros)
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Add a tiny sine wave so STT has something
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.floor(Math.sin(2 * Math.PI * 440 * t) * 3000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }

  return buffer;
}

/** Measure execution time */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

// ─── Inference Test Helpers ──────────────────────────────────────────────────

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface PipelineResult {
  ok: boolean;
  events: SSEEvent[];
  hasTranscript: boolean;
  hasResponse: boolean;
  hasAudio: boolean;
  hasComplete: boolean;
  totalMs?: number;
  responseText?: string;
  error?: string;
}

/** Parse SSE stream into typed events */
async function parseSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SSEEvent[]> {
  const decoder = new TextDecoder();
  const events: SSEEvent[] = [];
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ') && currentEvent) {
        try {
          events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
        } catch { /* partial SSE chunk */ }
      }
    }
  }

  return events;
}

/** Build PipelineResult from SSE events */
function buildPipelineResult(events: SSEEvent[]): PipelineResult {
  const eventTypes = new Set(events.map((e) => e.event));
  const responseEvt = events.find((e) => e.event === 'response');
  const completeEvt = events.find((e) => e.event === 'complete');

  return {
    ok: eventTypes.has('response') && eventTypes.has('complete'),
    events,
    hasTranscript: eventTypes.has('transcript'),
    hasResponse: eventTypes.has('response'),
    hasAudio: eventTypes.has('audio'),
    hasComplete: eventTypes.has('complete'),
    totalMs: completeEvt?.data.total_ms as number | undefined,
    responseText: responseEvt?.data.text as string | undefined,
  };
}

/** GET /health — verify inference server is healthy */
export async function checkHealth(
  endpoint: string,
): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
  try {
    const res = await fetch(`${endpoint}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as Record<string, unknown>;
    return { ok: data.status === 'healthy', data };
  } catch {
    return { ok: false };
  }
}

/** POST /api/text — test text-to-speech pipeline via SSE */
export async function testTextPipeline(
  endpoint: string,
  text = 'Olá, como você está hoje?',
): Promise<PipelineResult> {
  try {
    const formData = new FormData();
    formData.append('text', text);

    const res = await fetch(`${endpoint}/api/text`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false, events: [],
        hasTranscript: false, hasResponse: false, hasAudio: false, hasComplete: false,
        error: `HTTP ${res.status}: ${body.substring(0, 200)}`,
      };
    }

    const events = await parseSSEStream(res.body!.getReader());
    return buildPipelineResult(events);
  } catch (err) {
    return {
      ok: false, events: [],
      hasTranscript: false, hasResponse: false, hasAudio: false, hasComplete: false,
      error: String(err),
    };
  }
}

/** POST /api/stream-audio — test audio-in pipeline via SSE */
export async function testAudioPipeline(endpoint: string): Promise<PipelineResult> {
  try {
    const wav = makeTestWav(1.0, 16000);
    const formData = new FormData();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    formData.append('audio', new Blob([wav as any], { type: 'audio/wav' }), 'test.wav');

    const res = await fetch(`${endpoint}/api/stream-audio`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false, events: [],
        hasTranscript: false, hasResponse: false, hasAudio: false, hasComplete: false,
        error: `HTTP ${res.status}: ${body.substring(0, 200)}`,
      };
    }

    const events = await parseSSEStream(res.body!.getReader());
    return buildPipelineResult(events);
  } catch (err) {
    return {
      ok: false, events: [],
      hasTranscript: false, hasResponse: false, hasAudio: false, hasComplete: false,
      error: String(err),
    };
  }
}
