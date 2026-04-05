/**
 * STT Load Test: multipart audio upload under concurrency.
 *
 * Tests /v1/audio/transcriptions with simultaneous WAV uploads.
 * This is the heaviest endpoint — multipart parsing + binary upload + Groq STT.
 *
 * Run: bunx vitest run __tests__/stt-load.test.ts
 * Set SKIP_LIVE_TESTS=1 to skip.
 */

import { describe, it, expect } from 'vitest';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

function makeWav(durationS = 1.0, sampleRate = 16000): Uint8Array {
  const numSamples = Math.floor(sampleRate * durationS);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const encoder = new TextEncoder();
  let offset = 0;
  for (const b of encoder.encode('RIFF')) view.setUint8(offset++, b);
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  for (const b of encoder.encode('WAVE')) view.setUint8(offset++, b);
  for (const b of encoder.encode('fmt ')) view.setUint8(offset++, b);
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * 2, true); offset += 4;
  view.setUint16(offset, 2, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;
  for (const b of encoder.encode('data')) view.setUint8(offset++, b);
  view.setUint32(offset, dataSize, true);
  return new Uint8Array(buffer);
}

interface TimedResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function timedSttUpload(wav: Uint8Array): Promise<TimedResult> {
  const start = performance.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'en');

    const res = await fetch(`${GATEWAY_URL}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GATEWAY_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    return { ok: res.status === 200, latencyMs: performance.now() - start, status: res.status };
  } catch (err: any) {
    return { ok: false, latencyMs: performance.now() - start, error: err.message?.slice(0, 80) };
  }
}

function logBatch(label: string, results: TimedResult[]) {
  const ok = results.filter(r => r.ok);
  const latencies = ok.map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const failed = results.filter(r => !r.ok);
  console.log(`  ${label}: ${ok.length}/${results.length} OK | p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`);
  if (failed.length) {
    const errors = failed.map(r => `${r.status || 'err'}:${r.error?.slice(0, 40) || '?'}`).slice(0, 3);
    console.log(`    errors: ${errors.join(', ')}`);
  }
}

describe.skipIf(SKIP)('STT Load Test — Live Gateway', { timeout: 300_000 }, () => {
  const wav1s = makeWav(1.0);
  const wav3s = makeWav(3.0);

  it('single STT request works', { timeout: 30_000 }, async () => {
    const result = await timedSttUpload(wav1s);
    console.log(`\n── Single STT: status=${result.status} latency=${result.latencyMs.toFixed(0)}ms ──`);
    expect(result.ok).toBe(true);
  });

  it('10 concurrent STT uploads (1s audio)', { timeout: 60_000 }, async () => {
    console.log('\n── 10 concurrent STT uploads ──');
    const results = await Promise.all(Array.from({ length: 10 }, () => timedSttUpload(wav1s)));
    logBatch('10x 1s WAV', results);
    expect(results.filter(r => r.ok).length).toBeGreaterThan(5);
  });

  it('50 concurrent STT uploads (1s audio)', { timeout: 120_000 }, async () => {
    console.log('\n── 50 concurrent STT uploads ──');
    const results = await Promise.all(Array.from({ length: 50 }, () => timedSttUpload(wav1s)));
    logBatch('50x 1s WAV', results);
    expect(results.filter(r => r.ok).length).toBeGreaterThan(25);
  });

  it('100 concurrent STT uploads (1s audio)', { timeout: 180_000 }, async () => {
    console.log('\n── 100 concurrent STT uploads ──');
    const results = await Promise.all(Array.from({ length: 100 }, () => timedSttUpload(wav1s)));
    logBatch('100x 1s WAV', results);
    expect(results.filter(r => r.ok).length).toBeGreaterThan(50);
  });

  it('20 concurrent STT uploads (3s audio — larger payload)', { timeout: 120_000 }, async () => {
    console.log('\n── 20 concurrent STT uploads (3s audio) ──');
    const results = await Promise.all(Array.from({ length: 20 }, () => timedSttUpload(wav3s)));
    logBatch('20x 3s WAV', results);
    expect(results.filter(r => r.ok).length).toBeGreaterThan(10);
  });

  it('mixed STT + chat concurrent', { timeout: 120_000 }, async () => {
    console.log('\n── 50 mixed: 25 STT + 25 chat ──');
    const chatBody = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'reply OK' }],
      max_tokens: 5,
    });

    const tasks = Array.from({ length: 50 }, (_, i) => {
      if (i % 2 === 0) return timedSttUpload(wav1s);
      const start = performance.now();
      return fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_API_KEY}` },
        body: chatBody,
        signal: AbortSignal.timeout(30_000),
      }).then(r => ({ ok: r.status === 200, latencyMs: performance.now() - start, status: r.status }))
        .catch((err: any) => ({ ok: false, latencyMs: performance.now() - start, error: err.message }));
    });

    const results = await Promise.all(tasks);
    const sttResults = results.filter((_, i) => i % 2 === 0);
    const chatResults = results.filter((_, i) => i % 2 === 1);
    logBatch('25x STT', sttResults);
    logBatch('25x chat', chatResults);
    expect(results.filter(r => r.ok).length).toBeGreaterThan(25);
  });
});
