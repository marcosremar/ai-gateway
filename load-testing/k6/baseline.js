/**
 * Baseline load test — establishes reference p50/p95/p99 for each
 * OpenAI-compatible endpoint against the deployed gateway.
 *
 * What this does:
 *   - 50 VUs ramping up over 30s, holding for 90s, ramping down for 30s
 *   - Each VU round-robins through 4 endpoints (chat, STT, TTS, images)
 *   - Reports per-endpoint trend metrics so you can see which stage
 *     breached its SLO vs which one held
 *
 * Run:
 *   GATEWAY_URL=https://parle-ai-gateway.fly.dev \
 *   GATEWAY_API_KEY=<your-key> \
 *   k6 run load-testing/k6/baseline.js
 *
 * The numbers recorded become the baseline line in docs/ops/baseline.md.
 * Re-run after any significant proxy/infra change to detect regression.
 *
 * NOTE: this test DOES hit real provider APIs (Groq for chat/STT/TTS,
 * fal.ai for images). It will consume token/compute credits. Run it
 * intentionally, during off-peak, with an alert window for spend.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { GATEWAY_URL, GATEWAY_API_KEY, headers } from './config.js';

// Per-endpoint latency trends so the summary breaks down clearly
const chatLatency = new Trend('endpoint_chat_ms', true);
const sttLatency = new Trend('endpoint_stt_ms', true);
const ttsLatency = new Trend('endpoint_tts_ms', true);
const imgLatency = new Trend('endpoint_image_ms', true);

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // ramp up
    { duration: '90s', target: 50 },   // hold
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    // Aligned with docs/slo.md — if a p95 here breaches, the SLO is breached.
    'endpoint_chat_ms':  ['p(95)<2000'],
    'endpoint_stt_ms':   ['p(95)<1500'],
    'endpoint_tts_ms':   ['p(95)<2500'],
    'endpoint_image_ms': ['p(95)<10000'],  // images are slower; looser
    'http_req_failed':   ['rate<0.02'],    // <2% error rate across the run
  },
};

// 1-second silence WAV, 16kHz mono PCM. Embedded as base64 to avoid file I/O.
// k6 has no wave library, so we precompute this.
const SILENCE_WAV_B64 =
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
function silenceWav() {
  // k6's encoding lib decodes base64 to ArrayBuffer
  const enc = require('k6/encoding');
  return enc.b64decode(SILENCE_WAV_B64);
}

export default function () {
  // ── 1. Chat completions ───────────────────────────────────────────────
  const chatRes = http.post(
    `${GATEWAY_URL}/v1/chat/completions`,
    JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'Say: OK' }],
      max_tokens: 5,
    }),
    { headers, timeout: '10s', tags: { endpoint: 'chat' } },
  );
  chatLatency.add(chatRes.timings.duration);
  check(chatRes, {
    'chat: 200': (r) => r.status === 200,
    'chat: has content': (r) => {
      try { return JSON.parse(r.body).choices[0].message.content.length > 0; }
      catch { return false; }
    },
  });

  sleep(0.3);

  // ── 2. Audio transcriptions (STT) ─────────────────────────────────────
  // k6 multipart via FormData
  const sttRes = http.post(
    `${GATEWAY_URL}/v1/audio/transcriptions`,
    {
      file: http.file(silenceWav(), 'silence.wav', 'audio/wav'),
      model: 'whisper-large-v3-turbo',
    },
    { headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` }, timeout: '10s', tags: { endpoint: 'stt' } },
  );
  sttLatency.add(sttRes.timings.duration);
  check(sttRes, {
    'stt: 200': (r) => r.status === 200,
  });

  sleep(0.3);

  // ── 3. Text-to-speech ─────────────────────────────────────────────────
  const ttsRes = http.post(
    `${GATEWAY_URL}/v1/audio/speech`,
    JSON.stringify({
      model: 'canopylabs/orpheus-v1-english',
      input: 'Hello',
      voice: 'autumn',
    }),
    { headers, timeout: '15s', tags: { endpoint: 'tts' } },
  );
  ttsLatency.add(ttsRes.timings.duration);
  check(ttsRes, {
    'tts: 200': (r) => r.status === 200,
    'tts: body >1KB': (r) => r.body.length > 1000,
  });

  sleep(0.3);

  // ── 4. Image generation (fal.ai) ──────────────────────────────────────
  const imgRes = http.post(
    `${GATEWAY_URL}/v1/images/generate`,
    JSON.stringify({
      prompt: 'a small red dot on a white background',
      model: 'fal-ai/flux/schnell',
    }),
    { headers, timeout: '30s', tags: { endpoint: 'image' } },
  );
  imgLatency.add(imgRes.timings.duration);
  check(imgRes, {
    'image: 200': (r) => r.status === 200,
  });

  sleep(0.5);
}
