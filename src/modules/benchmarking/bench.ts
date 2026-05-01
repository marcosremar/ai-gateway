/**
 * GPU benchmark utilities — health probes and SSE TTFA measurement.
 * Framework-agnostic: uses only fetch API and standard Node.js.
 */

// ── Result types ──────────────────────────────────────────────────────────────

export interface ProtoResult {
  ok: boolean;
  ttfa_ms?: number;      // Time-to-First-Audio-Chunk (main metric)
  total_ms: number;      // total wall-clock time for full pipeline
  connect_ms?: number;   // WS / WebRTC: time to establish connection
  stt_ms?: number;
  llm_ms?: number;
  tts_ms?: number;
  transcript?: string;
  response?: string;
  error?: string;
}

export interface HealthResult {
  ok: boolean;
  latency_ms: number;
  data?: Record<string, unknown>;
  error?: string;
}

// ── WAV Generator ─────────────────────────────────────────────────────────────

/**
 * Generate a 440Hz sine-wave test WAV (1s, 16kHz mono PCM16).
 * Self-contained — no external audio dependencies needed.
 */
export function makeTestWav(durationSecs = 1, sampleRate = 16000): Buffer {
  const numSamples = Math.round(sampleRate * durationSecs);
  const buf = Buffer.alloc(44 + numSamples * 2);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + numSamples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(numSamples * 2, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.floor(
      Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 0.3 * 32767,
    );
    buf.writeInt16LE(sample, 44 + i * 2);
  }

  return buf;
}

// ── Health ────────────────────────────────────────────────────────────────────

export async function runHealthCheck(base: string): Promise<HealthResult> {
  const t = Date.now();
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
    const latency_ms = Date.now() - t;
    if (!res.ok) return { ok: false, latency_ms, error: `HTTP ${res.status}` };
    return { ok: true, latency_ms, data: await res.json() as Record<string, unknown> };
  } catch (err: unknown) {
    return { ok: false, latency_ms: Date.now() - t, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────

export async function runSSEBench(base: string, testWav?: Buffer): Promise<ProtoResult> {
  const t0 = Date.now();
  const wav = testWav ?? makeTestWav();
  const audioB64 = wav.toString('base64');

  try {
    const res = await fetch(`${base}/api/stream-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_base64: audioB64 }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok || !res.body) {
      return { ok: false, total_ms: Date.now() - t0, error: `HTTP ${res.status}` };
    }

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ttfa_ms: number | undefined;
    let stt_ms: number | undefined;
    let llm_ms: number | undefined;
    let tts_ms: number | undefined;
    let transcript = '';
    let response = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        if (!block.trim()) continue;
        let event = '';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6).trim();
        }
        if (!data) continue;
        try {
          const p = JSON.parse(data);
          switch (event) {
            case 'transcript':
              transcript = p.transcript ?? '';
              if (p.stt_ms) stt_ms = p.stt_ms;
              break;
            case 'response':
              response = p.response ?? '';
              if (p.llm_ms) llm_ms = p.llm_ms;
              break;
            case 'audio':
              if (ttfa_ms === undefined) ttfa_ms = Date.now() - t0;
              break;
            case 'complete': {
              const timing = p.timing ?? {};
              if (timing.tts_ms && !tts_ms) tts_ms = timing.tts_ms;
              if (timing.stt_ms && !stt_ms) stt_ms = timing.stt_ms;
              if (timing.llm_ms && !llm_ms) llm_ms = timing.llm_ms;
              break;
            }
          }
        } catch { /* ignore malformed SSE data */ }
      }
    }

    return {
      ok: true,
      ttfa_ms,
      total_ms: Date.now() - t0,
      stt_ms,
      llm_ms,
      tts_ms,
      transcript,
      response,
    };
  } catch (err: unknown) {
    return { ok: false, total_ms: Date.now() - t0, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
