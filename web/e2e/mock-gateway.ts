/**
 * Mock gateway server for Playwright e2e tests.
 * Simulates all BabelCast gateway endpoints with realistic data.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';

const PORT = 4099;

// ── Mutable state (tests can change via POST /mock/state) ──

let gpuStatus = 'idle';
let botStatus = 'idle';
let deployCount = 0;
let pendingTimers: ReturnType<typeof setTimeout>[] = [];
let providerConfig: Record<string, unknown> = {
  profiles: [],
  activeProfileId: null,
  pipelineStt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
  pipelineLlm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
  pipelineTts: [{ provider: 'gpu', model: 'qwen3-tts' }],
  updatedAt: 0,
};

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = (req.url || '/').split('?')[0];

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── Health ──
  if (method === 'GET' && url === '/health') {
    return json(res, {
      status: 'ok',
      uptime_sec: 3661,
      gpu: gpuStatus,
      providers: { groq: true, openai: false, deepgram: true },
      components: {
        stt: { status: 'ok', provider: 'groq' },
        llm: { status: 'ok', provider: 'groq' },
        tts: { status: gpuStatus === 'ready' ? 'ready' : 'unavailable', provider: 'gpu' },
        gpu: { status: gpuStatus, healthy: gpuStatus === 'ready' },
      },
      latency: { p50_ms: 142, p95_ms: 380, p99_ms: 620, samples: 256 },
      budget: { dailySpendUsd: 1.23, dailyLimitUsd: 10.0, exceeded: false },
      providerMetrics: {
        groq: { avgLatencyMs: 95, requests: 180, errorRate: 0.02 },
        gpu: { avgLatencyMs: 210, requests: 45, errorRate: 0.0 },
      },
      pendingDbWrites: 0,
    });
  }

  // ── Metrics ──
  if (method === 'GET' && url === '/metrics') {
    return json(res, {
      requestsTotal: 225,
      requestsByStage: { stt: 90, llm: 80, tts: 55 },
      requestsByProvider: { gpu: 45, groq: 150, cache: 30 },
      errorsTotal: 3,
      dbLogFailures: 0,
      latencyP50Ms: 142,
      latencyP95Ms: 380,
      latencyP99Ms: 620,
      gpuStatus,
      uptimeSec: 3661,
    });
  }

  // ── Request Log ──
  if (method === 'GET' && url === '/v1/requests/log') {
    return json(res, {
      entries: [
        { id: 1, timestamp: Date.now() - 60000, stage: 'stt', provider: 'groq', model: 'whisper-large-v3', latencyMs: 120, success: true, error: null, inputSize: 32000, outputPreview: 'Bonjour le monde' },
        { id: 2, timestamp: Date.now() - 50000, stage: 'llm', provider: 'groq', model: 'llama-3.3-70b', latencyMs: 95, success: true, error: null, inputSize: null, outputPreview: 'Hello world' },
        { id: 3, timestamp: Date.now() - 45000, stage: 'tts', provider: 'gpu', model: 'qwen3-tts', latencyMs: 210, success: true, error: null, inputSize: null, outputPreview: null },
        { id: 4, timestamp: Date.now() - 30000, stage: 'pipeline', provider: 'groq', model: null, latencyMs: 425, success: true, error: null, inputSize: 48000, outputPreview: 'Good morning everyone' },
        { id: 5, timestamp: Date.now() - 10000, stage: 'stt', provider: 'gpu', model: 'faster-whisper', latencyMs: 85, success: false, error: 'GPU timeout', inputSize: 16000, outputPreview: null },
      ],
      stats: {
        totalRequests: 225,
        gpuRequests: 45,
        cloudRequests: 180,
        avgLatencyMs: 187,
        gpuPercent: 20,
        errors: 3,
        byStage: { stt: 90, llm: 80, tts: 55 },
      },
    });
  }

  // ── GPU Status ──
  if (method === 'GET' && url === '/v1/gpu/status') {
    const base = {
      status: gpuStatus,
      message: gpuStatus === 'idle' ? 'No GPU deployed' : gpuStatus === 'ready' ? 'GPU ready' : `GPU ${gpuStatus}...`,
      podId: gpuStatus === 'idle' ? null : 'pod-abc123',
      endpoint: gpuStatus === 'ready' ? 'https://pod-abc123-8000.proxy.runpod.net' : null,
      provider: gpuStatus === 'idle' ? null : 'vast',
      gpuType: gpuStatus === 'idle' ? null : 'NVIDIA RTX A6000',
      dockerImage: gpuStatus === 'idle' ? null : 'marcosremar/babelcast-mistral:latest',
      costPerHr: gpuStatus === 'idle' ? null : 0.42,
      elapsedSec: gpuStatus === 'idle' ? 0 : 185,
      gpuHealthy: gpuStatus === 'ready',
      activeTier: gpuStatus === 'ready' ? 'gpu' : 'cloud',
      idleSec: 0,
      idleTimeoutSec: 900,
      alert: null,
      hasRemoteLogs: gpuStatus !== 'idle',
      deployDurationMs: gpuStatus === 'ready' ? 62000 : null,
      pipelineRouting: {
        stt: gpuStatus === 'ready' ? 'gpu' : 'cloud',
        llm: gpuStatus === 'ready' ? 'gpu' : 'cloud',
        tts: gpuStatus === 'ready' ? 'gpu' : 'cloud',
        mode: gpuStatus === 'ready' ? 'atomic-gpu' : 'cloud',
      },
      modelWarmth: { stt: { requests: 12, avgLatencyMs: 85 }, llm: { requests: 10, avgLatencyMs: 95 }, tts: { requests: 8, avgLatencyMs: 210 } },
    };
    return json(res, base);
  }

  // ── GPU List ──
  if (method === 'GET' && url === '/v1/gpu/list') {
    const instances = gpuStatus === 'idle' ? [] : [{
      instanceId: 'pod-abc123',
      provider: 'vast',
      gpuType: 'NVIDIA RTX A6000',
      status: gpuStatus,
      isActive: gpuStatus === 'ready',
      costPerHr: 0.42,
      elapsedSec: 185,
    }];
    return json(res, { instances });
  }

  // ── GPU Deploy ──
  if (method === 'POST' && url === '/v1/gpu/deploy') {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    if (!parsed.dockerImage) {
      return json(res, { error: 'Missing dockerImage' }, 400);
    }
    gpuStatus = 'creating';
    deployCount++;
    // Simulate async boot
    pendingTimers.push(setTimeout(() => { gpuStatus = 'booting'; }, 500));
    pendingTimers.push(setTimeout(() => { gpuStatus = 'ready'; }, 1500));
    return json(res, { status: 'creating', message: 'Deploy started (1 tier)' }, 202);
  }

  // ── GPU Terminate ──
  if (method === 'POST' && url === '/v1/gpu/terminate') {
    gpuStatus = 'idle';
    return json(res, { ok: true });
  }

  // ── GPU Logs ──
  if (method === 'GET' && url === '/v1/gpu/logs') {
    return json(res, {
      logs: '[2026-03-14 10:00:01] Starting BabelCast GPU server...\n[2026-03-14 10:00:03] Loading faster-whisper model...\n[2026-03-14 10:00:08] STT ready\n[2026-03-14 10:00:09] Loading Mistral-7B...\n[2026-03-14 10:00:15] LLM ready\n[2026-03-14 10:00:16] Loading Qwen3-TTS...\n[2026-03-14 10:00:22] TTS ready\n[2026-03-14 10:00:22] All models loaded. Listening on :8000',
      endpoint: gpuStatus === 'ready' ? 'https://pod-abc123-8000.proxy.runpod.net' : null,
      podId: gpuStatus !== 'idle' ? 'pod-abc123' : null,
      provider: gpuStatus !== 'idle' ? 'vast' : null,
      status: gpuStatus,
    });
  }

  // ── GPU Catalog ──
  if (method === 'GET' && url === '/v1/gpu/catalog') {
    return json(res, {
      images: [
        { name: 'marcosremar/babelcast-mistral:latest', label: 'Mistral (default)' },
        { name: 'marcosremar/babelcast-groq:latest', label: 'Groq (cloud-only)' },
      ],
    });
  }

  // ── GPU Reputation ──
  if (method === 'GET' && url === '/v1/gpu/reputation') {
    return json(res, {
      hosts: [
        { hostKey: 'vast-host-1234', provider: 'vast', gpuType: 'NVIDIA RTX A6000', deployCount: 12, successCount: 10, failCount: 1, crashCount: 1, reputationScore: 0.83, avgBootTimeS: 65, avgLatencyMs: 210, totalCostUsd: 4.20, lastDeployAt: Date.now() - 3600000 },
        { hostKey: 'td-host-5678', provider: 'tensordock', gpuType: 'NVIDIA GeForce RTX 4090', deployCount: 8, successCount: 7, failCount: 1, crashCount: 0, reputationScore: 0.72, avgBootTimeS: 45, avgLatencyMs: 180, totalCostUsd: 2.80, lastDeployAt: Date.now() - 7200000 },
        { hostKey: 'rp-host-9012', provider: 'runpod', gpuType: 'NVIDIA A100-SXM4-80GB', deployCount: 3, successCount: 1, failCount: 2, crashCount: 0, reputationScore: 0.35, avgBootTimeS: 120, avgLatencyMs: 320, totalCostUsd: 5.10, lastDeployAt: Date.now() - 86400000 },
      ],
      count: 3,
    });
  }

  // ── Translate ──
  if (method === 'POST' && url === '/v1/translate') {
    const body = JSON.parse(await readBody(req));
    if (!body.text) return json(res, { error: 'Missing text' }, 400);
    return json(res, {
      translated_text: `[Translated from ${body.source_lang || 'fr'} to ${body.target_lang || 'en'}]: ${body.text}`,
      used_gpu: gpuStatus === 'ready',
    });
  }

  // ── TTS ──
  if (method === 'POST' && url === '/v1/tts') {
    const body = JSON.parse(await readBody(req));
    if (!body.text) return json(res, { error: 'Missing text' }, 400);
    // Return a tiny valid WAV (44-byte header + 100 bytes of silence)
    const wav = Buffer.alloc(144);
    wav.write('RIFF', 0); wav.writeUInt32LE(136, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(100, 40);
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(wav);
    return;
  }

  // ── Bot Status ──
  if (method === 'GET' && url === '/v1/bot/status') {
    return json(res, {
      status: botStatus,
      podId: botStatus === 'idle' ? '' : 'bot-pod-xyz',
      endpoint: botStatus !== 'idle' ? 'https://bot-pod-xyz-8080.proxy.runpod.net' : '',
      message: botStatus === 'idle' ? 'No bot deployed' : `Bot ${botStatus}`,
      startedAt: botStatus === 'idle' ? 0 : Date.now() - 120000,
      elapsedSec: botStatus === 'idle' ? 0 : 120,
      botId: botStatus === 'joined' ? 'bot-uuid-abc' : '',
      meetingUrl: botStatus === 'joined' ? 'https://teams.microsoft.com/l/meetup-join/test' : '',
    });
  }

  // ── Bot Deploy ──
  if (method === 'POST' && url === '/v1/bot/deploy') {
    botStatus = 'creating';
    pendingTimers.push(setTimeout(() => { botStatus = 'booting'; }, 500));
    pendingTimers.push(setTimeout(() => { botStatus = 'ready'; }, 1500));
    return json(res, { status: 'creating', message: 'Bot pod deploy started' }, 202);
  }

  // ── Bot Join ──
  if (method === 'POST' && url === '/v1/bot/join') {
    const body = JSON.parse(await readBody(req));
    if (!body.meetingUrl) return json(res, { error: 'Missing meetingUrl' }, 400);
    botStatus = 'joined';
    return json(res, { ok: true, botId: 'bot-uuid-abc', meetingUrl: body.meetingUrl });
  }

  // ── Bot Leave ──
  if (method === 'POST' && url === '/v1/bot/leave') {
    botStatus = 'ready';
    return json(res, { ok: true });
  }

  // ── Bot Terminate ──
  if (method === 'POST' && url === '/v1/bot/terminate') {
    botStatus = 'idle';
    return json(res, { ok: true });
  }

  // ── Provider Config ──
  if (method === 'GET' && url === '/v1/config/providers') {
    return json(res, providerConfig);
  }
  if (method === 'POST' && url === '/v1/config/providers') {
    const body = JSON.parse(await readBody(req));
    providerConfig = { ...providerConfig, ...body, updatedAt: Date.now() };
    return json(res, providerConfig);
  }

  // ── Mock control endpoint (for tests to reset state) ──
  if (method === 'POST' && url === '/mock/reset') {
    pendingTimers.forEach(t => clearTimeout(t));
    pendingTimers = [];
    gpuStatus = 'idle';
    botStatus = 'idle';
    deployCount = 0;
    providerConfig = {
      profiles: [],
      activeProfileId: null,
      pipelineStt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
      pipelineLlm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
      pipelineTts: [{ provider: 'gpu', model: 'qwen3-tts' }],
      updatedAt: 0,
    };
    return json(res, { ok: true });
  }

  if (method === 'POST' && url === '/mock/state') {
    const body = JSON.parse(await readBody(req));
    if (body.gpuStatus) gpuStatus = body.gpuStatus;
    if (body.botStatus) botStatus = body.botStatus;
    return json(res, { ok: true, gpuStatus, botStatus });
  }

  // 404
  json(res, { error: `Not found: ${method} ${url}` }, 404);
});

server.listen(PORT, () => {
  console.log(`[mock-gateway] Listening on http://localhost:${PORT}`);
});
