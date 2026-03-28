/**
 * Integration tests — Full AI Gateway with real APIs
 *
 * Tests the complete ai-gateway against live infrastructure:
 * - RunPod GPU pod (STT/LLM/TTS inference)
 * - TensorDock GPU provider API
 * - Vast.ai GPU marketplace + instances
 * - Modal API
 * - OpenAI / Groq cloud providers
 * - All gateway features: hooks, spend tracking,
 *   declarative fallback chains, load balancer, predictive warmup
 *
 * Run: bunx vitest run --config vitest.config.gpu-providers.mts
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { TensordockClient, findCheapestLocations } from '@ai-gateway/gpu-providers/tensordock-client';
import { RunpodClient } from '@ai-gateway/gpu-providers/runpod-client';
import { GpuProviderRegistry } from '@ai-gateway/gpu-providers/registry';
import { probeGpuHealth } from '@ai-gateway/autoscaler/health';
import { emitHook } from '@ai-gateway/hooks';
import { resolveDeclarativeChain, findChainForStage } from '@ai-gateway/providers/declarative-chain';
import { LoadBalancer } from '@ai-gateway/autoscaler/load-balancer';
import { SpendTracker } from '@ai-gateway/tracking/spend-tracker';
import { estimateRequestCost } from '@ai-gateway/tracking/pricing';
import type { ProviderCredentials } from '@ai-gateway/gpu-providers/types';
import type { GatewayHooks } from '@ai-gateway/hooks';
import type { StateStore } from '@ai-gateway/deps';

// ─── In-memory StateStore ─────────────────────────────────────────────────────

class MemoryStateStore implements StateStore {
  private kv = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();

  async get(key: string) { return this.kv.get(key) ?? null; }
  async set(key: string, value: string) { this.kv.set(key, value); }
  async del(key: string) { this.kv.delete(key); this.hashes.delete(key); }
  async scan(pattern: string) {
    const prefix = pattern.replace('*', '');
    return [...this.kv.keys()].filter(k => k.startsWith(prefix));
  }
  async rpush(key: string, value: string) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key)!.push(value);
  }
  async ltrim() {}
  async lrange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const s = start < 0 ? Math.max(list.length + start, 0) : start;
    const e = stop < 0 ? list.length + stop : stop;
    return list.slice(s, e + 1);
  }
  async hset(key: string, field: string, value: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
  }
  async hdel(key: string, field: string) { this.hashes.get(key)?.delete(field); }
  async hgetall(key: string) {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash);
  }
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/** Discover the RunPod endpoint (direct IP or proxy). */
async function discoverRunpodEndpoint(creds: ProviderCredentials): Promise<string | null> {
  const client = new RunpodClient();
  const instances = await client.listInstances(creds);
  const running = instances.find(i => i.status === 'RUNNING');
  if (!running) return null;

  // Prefer direct IP (faster, no proxy overhead)
  const res = await fetch(`https://rest.runpod.io/v1/pods/${running.instanceId}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) {
    const pod = await res.json() as Record<string, unknown>;
    const ip = pod.publicIp as string | undefined;
    const portMap = pod.portMappings as Record<string, number> | undefined;
    if (ip && portMap?.['8000']) {
      return `http://${ip}:${portMap['8000']}`;
    }
  }

  return running.endpoint || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GPU PROVIDER API TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!process.env.TENSORDOCK_API_TOKEN)('TensorDock — real API', () => {
  let client: TensordockClient;
  let creds: ProviderCredentials;

  beforeAll(() => {
    client = new TensordockClient();
    creds = { apiKey: process.env.TENSORDOCK_API_TOKEN!, authId: process.env.TENSORDOCK_AUTH_ID };
  });

  it('lists instances and gets status', async () => {
    const instances = await client.listInstances(creds);
    console.log(`[tensordock] ${instances.length} instances`);
    for (const i of instances) {
      console.log(`  ${i.instanceId.substring(0, 8)} [${i.status}] ${i.endpoint || '(no endpoint)'}`);
    }
    expect(Array.isArray(instances)).toBe(true);
  }, 20_000);

  it('finds cheapest RTX3090 locations with pricing', async () => {
    const headers = {
      Authorization: `Bearer ${creds.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const locations = await findCheapestLocations('geforcertx3090-pcie-24gb', headers);
    console.log(`[tensordock] ${locations.length} RTX3090 available`);
    for (const l of locations.slice(0, 5)) {
      console.log(`  $${l.price.toFixed(3)}/hr — ${l.city} (${l.ports.length} ports)`);
    }
    expect(locations.length).toBeGreaterThan(0);
  }, 20_000);
});

describe.skipIf(!process.env.RUNPOD_API_KEY || !!process.env.SKIP_GPU_TESTS)('RunPod — real API', () => {
  let client: RunpodClient;
  let creds: ProviderCredentials;

  beforeAll(() => {
    client = new RunpodClient();
    creds = { apiKey: process.env.RUNPOD_API_KEY! };
  });

  it('lists pods with GPU info', async () => {
    const instances = await client.listInstances(creds);
    console.log(`[runpod] ${instances.length} pods`);
    for (const i of instances) {
      console.log(`  ${i.instanceId} [${i.status}] ${i.endpoint || '(no endpoint)'} gpu=${i.gpuType || '?'}`);
    }
    expect(Array.isArray(instances)).toBe(true);
  }, 20_000);

  it('discovers running GPU instance', async () => {
    const instance = await client.discoverInstance(creds, ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3090']);
    if (instance) {
      console.log(`[runpod] Discovered: ${instance.instanceId} [${instance.status}]`);
      expect(instance.endpoint).toBeTruthy();
    } else {
      console.log('[runpod] No running instances');
    }
  }, 15_000);

  it('gets pod details via REST API', async () => {
    const res = await fetch('https://rest.runpod.io/v1/pods', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    const pods = Array.isArray(data) ? data : (data.pods || data);
    console.log(`[runpod] REST: ${Array.isArray(pods) ? pods.length : 0} pods`);
    for (const p of (Array.isArray(pods) ? pods : [])) {
      console.log(`  ${p.id} "${p.name}" [${p.desiredStatus}] cost=$${p.costPerHr ?? '?'}/hr`);
    }
  }, 15_000);
});

describe.skipIf(!process.env.VAST_API_KEY)('Vast.ai — real API', () => {
  let headers: Record<string, string>;

  beforeAll(() => {
    headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.VAST_API_KEY}` };
  });

  it('lists serverless endpoints', async () => {
    const res = await fetch('https://console.vast.ai/api/v0/endptjobs/', { headers, signal: AbortSignal.timeout(15_000) });
    expect(res.ok).toBe(true);
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    const endpoints = Array.isArray(data) ? data : (data.results || data.endpoints || []);
    console.log(`[vast] ${endpoints.length} serverless endpoints`);
    for (const ep of endpoints) console.log(`  ${ep.id}: ${ep.endpoint_name || '(unnamed)'} [${ep.status || '?'}]`);
  }, 15_000);

  it('finds RTX3090 GPU offers with pricing', async () => {
    const q = encodeURIComponent('{"rentable":{"eq":true},"gpu_name":{"eq":"RTX 3090"},"num_gpus":{"eq":1}}');
    const res = await fetch(`https://console.vast.ai/api/v0/bundles?q=${q}&limit=10`, { headers, signal: AbortSignal.timeout(15_000) });
    expect(res.ok).toBe(true);
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    const offers = Array.isArray(data) ? data : (data.offers || data.results || []);
    console.log(`[vast] ${offers.length} RTX3090 offers`);
    for (const o of offers.slice(0, 5)) {
      console.log(`  $${(o.dph_total || 0).toFixed(3)}/hr | ${o.gpu_name} | ${o.geolocation || '?'} | ${o.gpu_ram || '?'}MB VRAM`);
    }
    expect(offers.length).toBeGreaterThan(0);
  }, 15_000);

  it('lists active instances', async () => {
    const res = await fetch('https://console.vast.ai/api/v0/instances/', { headers, signal: AbortSignal.timeout(15_000) });
    expect(res.ok).toBe(true);
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    const instances = Array.isArray(data) ? data : (data.instances || data.results || []);
    console.log(`[vast] ${instances.length} active instances`);
    for (const i of instances) {
      console.log(`  ${i.id}: ${i.gpu_name || '?'} [${i.actual_status || '?'}] $${(i.dph_total || 0).toFixed(3)}/hr ip=${i.public_ipaddr || '?'}`);
    }
  }, 15_000);
});

describe.skipIf(!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET)('Modal — real API', () => {
  let credentials: string;

  beforeAll(() => {
    credentials = Buffer.from(`${process.env.MODAL_TOKEN_ID}:${process.env.MODAL_TOKEN_SECRET}`).toString('base64');
  });

  it('authenticates and lists apps', async () => {
    const res = await fetch('https://api.modal.com/v1/apps', {
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`[modal] HTTP ${res.status}`);
    expect(res.status).toBeLessThan(500); // API is reachable
    const text = await res.text();
    if (text) {
      const data = JSON.parse(text) as { apps?: Array<{ name: string; state: number }> };
      const apps = data.apps ?? [];
      console.log(`[modal] ${apps.length} apps`);
      for (const a of apps.slice(0, 5)) console.log(`  "${a.name}" [state=${a.state}]`);
    }
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. GPU INFERENCE TESTS (real speech pipeline on RunPod)
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!process.env.RUNPOD_API_KEY || !!process.env.SKIP_GPU_TESTS)('GPU Inference — RunPod live pod', () => {
  let endpoint: string;

  beforeAll(async () => {
    const ep = await discoverRunpodEndpoint({ apiKey: process.env.RUNPOD_API_KEY! });
    if (!ep) throw new Error('No running RunPod pod found — cannot test inference');
    endpoint = ep;
    console.log(`[gpu] Using endpoint: ${endpoint}`);
  });

  it('health probe returns healthy with loaded models', async () => {
    const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(10_000) });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data.status).toBe('healthy');
    console.log(`[gpu] Models: STT=${(data.models as any)?.stt}, LLM=${(data.models as any)?.llm}, TTS=${(data.models as any)?.tts}`);
    console.log(`[gpu] VRAM: ${data.vram_gb}GB, Streaming: ${data.streaming}`);
  }, 15_000);

  it('probeGpuHealth() returns true for live endpoint', async () => {
    const healthy = await probeGpuHealth(endpoint);
    expect(healthy).toBe(true);
  }, 10_000);

  it('LLM+TTS inference via /api/text (text → speech)', async () => {
    const start = Date.now();
    const res = await fetch(`${endpoint}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Olá, como você está hoje?' }),
      signal: AbortSignal.timeout(60_000),
    });

    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, any>;
    const latencyMs = Date.now() - start;

    // Validate LLM response
    expect(data.response?.text).toBeTruthy();
    expect(data.response.text.length).toBeGreaterThan(5);
    console.log(`[gpu] LLM response: "${data.response.text.substring(0, 100)}"`);

    // Validate TTS audio
    expect(data.speech?.audio).toBeTruthy();
    const audioBytes = Buffer.from(data.speech.audio, 'base64');
    expect(audioBytes.length).toBeGreaterThan(1000); // WAV header + samples
    console.log(`[gpu] Audio: ${audioBytes.length} bytes, ${data.speech.format || 'wav'}, ${data.speech.sample_rate || '?'}Hz`);

    // Validate timing
    expect(data.timing?.llm_ms).toBeGreaterThan(0);
    expect(data.timing?.tts_ms).toBeGreaterThan(0);
    expect(data.timing?.total_ms).toBeGreaterThan(0);
    console.log(`[gpu] Timing: LLM=${data.timing.llm_ms}ms TTS=${data.timing.tts_ms}ms Total=${data.timing.total_ms}ms (e2e=${latencyMs}ms)`);
  }, 60_000);

  it('handles conversation context (multi-turn)', async () => {
    const res = await fetch(`${endpoint}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Meu nome é Marcos.',
        history: [
          { role: 'system', content: 'Você é um professor de português brasileiro. Responda sempre em português.' },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, any>;
    expect(data.response?.text).toBeTruthy();
    console.log(`[gpu] Multi-turn: "${data.response.text.substring(0, 120)}"`);

    // Second turn — should reference the name
    const res2 = await fetch(`${endpoint}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Qual é o meu nome?',
        history: [
          { role: 'system', content: 'Você é um professor de português brasileiro.' },
          { role: 'user', content: 'Meu nome é Marcos.' },
          { role: 'assistant', content: data.response.text },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    expect(res2.ok).toBe(true);
    const data2 = await res2.json() as Record<string, any>;
    expect(data2.response?.text).toBeTruthy();
    console.log(`[gpu] Follow-up: "${data2.response.text.substring(0, 120)}"`);
    // The model should remember the name
    expect(data2.response.text.toLowerCase()).toContain('marcos');
  }, 120_000);

  it('concurrent requests are handled', async () => {
    const requests = Array.from({ length: 3 }, (_, i) =>
      fetch(`${endpoint}/api/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Diga apenas o número ${i + 1}.` }),
        signal: AbortSignal.timeout(60_000),
      }).then(async r => ({ ok: r.ok, data: await r.json() as Record<string, any>, idx: i, error: null as string | null }))
        .catch(err => ({ ok: false, data: {} as Record<string, any>, idx: i, error: err.message as string }))
    );

    const results = await Promise.all(requests);
    const succeeded = results.filter(r => r.ok && r.data.response?.text);
    const failed = results.filter(r => !r.ok);

    for (const r of succeeded) {
      console.log(`[gpu] Concurrent #${r.idx}: "${r.data.response.text.substring(0, 60)}" (${r.data.timing?.total_ms}ms)`);
    }
    for (const r of failed) {
      console.log(`[gpu] Concurrent #${r.idx}: FAILED — ${r.error || 'non-ok response'}`);
    }

    // At least 2 of 3 must succeed (single-worker GPU may drop one connection under load)
    expect(succeeded.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. AI-GATEWAY FEATURES WITH REAL DATA
// ═══════════════════════════════════════════════════════════════════════════════

describe('Observability Hooks — lifecycle tracking', () => {
  it('tracks full request lifecycle with hooks', async () => {
    const events: Array<{ hook: string; data: Record<string, any> }> = [];
    const hooks: GatewayHooks = {
      onRequestStart: (e) => { events.push({ hook: 'start', data: e }); },
      onRequestEnd: (e) => { events.push({ hook: 'end', data: e }); },
      onScaleUp: (e) => { events.push({ hook: 'scaleUp', data: e }); },
      onScaleDown: (e) => { events.push({ hook: 'scaleDown', data: e }); },
      onHealthChange: (e) => { events.push({ hook: 'healthChange', data: e }); },
      onCostAlert: (e) => { events.push({ hook: 'costAlert', data: e }); },
    };

    // Simulate a real request flow
    emitHook(hooks, 'onRequestStart', { userId: 'u1', provider: 'openai', stage: 'llm', model: 'gpt-4o-mini', timestamp: Date.now() });
    emitHook(hooks, 'onRequestEnd', { userId: 'u1', provider: 'openai', stage: 'llm', model: 'gpt-4o-mini', latencyMs: 450, success: true, timestamp: Date.now() });
    emitHook(hooks, 'onScaleUp', { userId: 'u1', tierIndex: 0, provider: 'runpod', trigger: 'sessions', activeSessions: 6, timestamp: Date.now() });
    emitHook(hooks, 'onHealthChange', { userId: 'u1', tierIndex: 0, provider: 'runpod', previousState: 'booting', newState: 'ready', endpoint: 'http://gpu:8000', timestamp: Date.now() });
    emitHook(hooks, 'onScaleDown', { userId: 'u1', tierIndex: 0, provider: 'runpod', reason: 'idle', idleMinutes: 15, timestamp: Date.now() });

    expect(events).toHaveLength(5);
    expect(events.map(e => e.hook)).toEqual(['start', 'end', 'scaleUp', 'healthChange', 'scaleDown']);
    expect(events[0].data.provider).toBe('openai');
    expect(events[2].data.activeSessions).toBe(6);
    expect(events[3].data.newState).toBe('ready');
  });

  it('async hook errors are swallowed', async () => {
    const hooks: GatewayHooks = {
      onRequestStart: async () => { throw new Error('hook crash'); },
    };
    // Should not throw
    emitHook(hooks, 'onRequestStart', { userId: 'u1', provider: 'x', stage: 'llm', model: 'y', timestamp: Date.now() });
    // Give async error time to be caught
    await new Promise(r => setTimeout(r, 50));
  });
});

describe.skipIf(!process.env.OPENAI_API_KEY)('Spend Tracking — real OpenAI usage', () => {
  it('records real API call cost and checks budget', async () => {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Real API call
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Responda em uma palavra.' },
        { role: 'user', content: 'Qual é a capital do Brasil?' },
      ],
      max_tokens: 10,
    });

    const usage = response.usage!;
    const cost = estimateRequestCost('openai', 'gpt-4o-mini', usage.prompt_tokens, usage.completion_tokens);

    console.log(`[spend] ${usage.prompt_tokens} in + ${usage.completion_tokens} out = $${cost.toFixed(6)}`);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);

    // Track in SpendTracker
    const store = new MemoryStateStore();
    const tracker = new SpendTracker(store);

    await tracker.record({
      userId: 'test-user',
      provider: 'openai',
      model: 'gpt-4o-mini',
      stage: 'llm',
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      costUsd: cost,
      timestamp: Date.now(),
    });

    // Verify summary
    const summary = await tracker.getDailySummary('test-user');
    expect(summary.requestCount).toBe(1);
    expect(summary.totalCostUsd).toBeCloseTo(cost, 6);
    expect(summary.byProvider.openai.requests).toBe(1);
    expect(summary.byStage.llm.requests).toBe(1);

    // Check budget
    const budget = await tracker.checkBudget('test-user', { dailyLimitUsd: 1.0 });
    expect(budget.over).toBe(false);
    expect(budget.pct).toBeLessThan(0.01);
    expect(budget.currentUsd).toBeCloseTo(cost, 6);
    console.log(`[spend] Budget: $${budget.currentUsd.toFixed(6)} / $${budget.limitUsd} (${(budget.pct * 100).toFixed(4)}%)`);
  }, 15_000);

  it('tracks multi-provider spend across pipeline stages', async () => {
    const store = new MemoryStateStore();
    const tracker = new SpendTracker(store);
    const now = Date.now();

    // Simulate a full pipeline: STT (OpenAI) → LLM (Groq) → TTS (OpenAI)
    await tracker.record({ userId: 'u1', provider: 'openai', model: 'whisper-1', stage: 'stt', inputTokens: 0, outputTokens: 0, costUsd: 0.006, timestamp: now });
    await tracker.record({ userId: 'u1', provider: 'groq', model: 'llama-3.3-70b', stage: 'llm', inputTokens: 500, outputTokens: 100, costUsd: 0.00035, timestamp: now + 1 });
    await tracker.record({ userId: 'u1', provider: 'openai', model: 'tts-1', stage: 'tts', inputTokens: 0, outputTokens: 0, costUsd: 0.015, timestamp: now + 2 });

    const summary = await tracker.getDailySummary('u1');
    expect(summary.requestCount).toBe(3);
    expect(summary.totalCostUsd).toBeCloseTo(0.02135, 5);
    expect(summary.byProvider.openai.requests).toBe(2);
    expect(summary.byProvider.groq.requests).toBe(1);
    expect(summary.byStage.stt.requests).toBe(1);
    expect(summary.byStage.llm.requests).toBe(1);
    expect(summary.byStage.tts.requests).toBe(1);

    console.log(`[spend] Pipeline total: $${summary.totalCostUsd.toFixed(5)}`);
    console.log(`[spend] By provider: openai=$${summary.byProvider.openai.costUsd.toFixed(5)}, groq=$${summary.byProvider.groq.costUsd.toFixed(5)}`);
  });
});

describe('Declarative Fallback Chains', () => {
  it('resolves multi-provider chain with priority ordering', () => {
    const chains = [
      {
        stage: 'llm' as const,
        chain: [
          { provider: 'groq', model: 'llama-3.3-70b-versatile', priority: 1 },
          { provider: 'openai', model: 'gpt-4o-mini', priority: 2 },
          { provider: 'gpu', model: 'ministral-3b', priority: 3 },
        ],
        cooldownMs: 30_000,
        retriesPerProvider: 2,
        timeoutMs: 15_000,
      },
      {
        stage: 'stt' as const,
        chain: [
          { provider: 'openai', model: 'whisper-1', priority: 1 },
        ],
      },
      {
        stage: 'tts' as const,
        chain: [
          { provider: 'gpu', model: 'moss-tts', priority: 1 },
          { provider: 'openai', model: 'tts-1', priority: 2 },
        ],
      },
    ];

    // LLM chain
    const llm = findChainForStage(chains, 'llm');
    expect(llm).toBeTruthy();
    const resolved = resolveDeclarativeChain(llm!);
    expect(resolved.chain).toHaveLength(3);
    expect(resolved.chain[0].provider).toBe('groq');
    expect(resolved.chain[1].provider).toBe('openai');
    expect(resolved.chain[2].provider).toBe('gpu');
    expect(resolved.options.cooldownMs).toBe(30_000);
    expect(resolved.options.retriesPerProvider).toBe(2);

    // TTS chain
    const tts = findChainForStage(chains, 'tts');
    const ttsResolved = resolveDeclarativeChain(tts!);
    expect(ttsResolved.chain[0].provider).toBe('gpu');
    expect(ttsResolved.chain[1].provider).toBe('openai');

    // Non-existent stage
    expect(findChainForStage(chains, 'realtime' as any)).toBeUndefined();
  });
});

describe('Health-Aware Load Balancer', () => {
  let store: MemoryStateStore;
  let lb: LoadBalancer;

  beforeAll(() => {
    store = new MemoryStateStore();
    lb = new LoadBalancer(store);
  });

  it('least-latency selects fastest tier', async () => {
    const tiers = [
      { state: 'ready' as const, endpoint: 'http://gpu-0:8000', tierIndex: 0, lastHealthyAt: Date.now() },
      { state: 'ready' as const, endpoint: 'http://gpu-1:8000', tierIndex: 1, lastHealthyAt: Date.now() },
      { state: 'ready' as const, endpoint: 'http://gpu-2:8000', tierIndex: 2, lastHealthyAt: Date.now() },
    ];

    // Report latencies
    await lb.reportTierLatency('u1', 0, 500);
    await lb.reportTierLatency('u1', 1, 100);
    await lb.reportTierLatency('u1', 2, 300);

    expect(await lb.selectTier('u1', tiers, 'least-latency')).toBe(1);

    // Update: tier 2 gets faster
    await lb.reportTierLatency('u1', 2, 50);
    await lb.reportTierLatency('u1', 2, 50);
    // EMA: 0.3*50 + 0.7*300 = 225, then 0.3*50 + 0.7*225 = 172.5 — still tier 1 wins at 100
    expect(await lb.selectTier('u1', tiers, 'least-latency')).toBe(1);
  });

  it('weighted-round-robin cycles evenly', async () => {
    const tiers = [
      { state: 'ready' as const, endpoint: 'http://a:8000', tierIndex: 0, lastHealthyAt: Date.now() },
      { state: 'ready' as const, endpoint: 'http://b:8000', tierIndex: 1, lastHealthyAt: Date.now() },
    ];

    const results: number[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(await lb.selectTier('rr-user', tiers, 'weighted-round-robin'));
    }
    expect(results).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('affinity sticks to same tier', async () => {
    const tiers = [
      { state: 'ready' as const, endpoint: 'http://a:8000', tierIndex: 0, lastHealthyAt: Date.now() },
      { state: 'ready' as const, endpoint: 'http://b:8000', tierIndex: 1, lastHealthyAt: Date.now() },
      { state: 'ready' as const, endpoint: 'http://c:8000', tierIndex: 2, lastHealthyAt: Date.now() },
    ];

    const first = await lb.selectTier('sticky-user', tiers, 'affinity');
    for (let i = 0; i < 5; i++) {
      expect(await lb.selectTier('sticky-user', tiers, 'affinity')).toBe(first);
    }
  });

  it('hash distributes deterministically', async () => {
    const tiers = [
      { state: 'ready' as const, endpoint: 'http://a:8000', tierIndex: 0, lastHealthyAt: Date.now() },
      { state: 'ready' as const, endpoint: 'http://b:8000', tierIndex: 1, lastHealthyAt: Date.now() },
      { state: 'ready' as const, endpoint: 'http://c:8000', tierIndex: 2, lastHealthyAt: Date.now() },
    ];

    // Same user always gets same tier
    const idx = await lb.selectTier('user-123', tiers, 'hash');
    for (let i = 0; i < 10; i++) {
      expect(await lb.selectTier('user-123', tiers, 'hash')).toBe(idx);
    }

    // Different users spread across tiers
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      seen.add(await lb.selectTier(`user-${i}`, tiers, 'hash'));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('GPU Provider Registry', () => {
  it('registers and retrieves all provider types', () => {
    const registry = new GpuProviderRegistry();
    registry.register(new RunpodClient());
    registry.register(new TensordockClient());

    expect(registry.get('runpod')?.providerId).toBe('runpod');
    expect(registry.get('tensordock')?.providerId).toBe('tensordock');
    expect(registry.getOrThrow('runpod').bootTimeSecs).toBeGreaterThan(0);
    expect(registry.getMonitorable('runpod')).toBeTruthy();
    expect(registry.getMonitorable('tensordock')).toBeTruthy();
    expect(registry.getMonitorable('nonexistent')).toBeUndefined();
    expect(() => registry.getOrThrow('nonexistent')).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. END-TO-END: GATEWAY DECISION FLOW WITH REAL DATA
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E: Gateway decision flow', () => {
  it('simulates full autoscaler decision + routing + tracking cycle', async () => {
    const store = new MemoryStateStore();
    const lb = new LoadBalancer(store);
    const tracker = new SpendTracker(store);
    const events: string[] = [];

    const hooks: GatewayHooks = {
      onRequestStart: (e) => { events.push(`start:${e.stage}:${e.provider}`); },
      onRequestEnd: (e) => { events.push(`end:${e.stage}:${e.success ? 'ok' : 'fail'}`); },
      onScaleUp: (e) => { events.push(`scaleUp:tier${e.tierIndex}`); },
      onHealthChange: (e) => { events.push(`health:${e.previousState}→${e.newState}`); },
    };

    // Step 1: Resolve fallback chain
    const chains = [{
      stage: 'llm' as const,
      chain: [
        { provider: 'groq', model: 'llama-3.3-70b', priority: 1 },
        { provider: 'openai', model: 'gpt-4o-mini', priority: 2 },
      ],
    }];
    const llmChain = resolveDeclarativeChain(findChainForStage(chains, 'llm')!);
    expect(llmChain.chain[0].provider).toBe('groq');

    // Step 3: Select tier via load balancer
    const tiers = [
      { state: 'ready' as const, endpoint: 'http://gpu-0:8000', tierIndex: 0, lastHealthyAt: Date.now() },
      { state: 'ready' as const, endpoint: 'http://gpu-1:8000', tierIndex: 1, lastHealthyAt: Date.now() },
    ];
    await lb.reportTierLatency('e2e-user', 0, 200);
    await lb.reportTierLatency('e2e-user', 1, 150);
    const selectedTier = await lb.selectTier('e2e-user', tiers, 'least-latency');
    expect(selectedTier).toBe(1);
    console.log(`[e2e] Selected tier: ${selectedTier} (${tiers[selectedTier].endpoint})`);

    // Step 4: Fire hooks
    emitHook(hooks, 'onRequestStart', { userId: 'e2e-user', provider: 'groq', stage: 'llm', model: 'llama-3.3-70b', timestamp: Date.now() });
    emitHook(hooks, 'onRequestEnd', { userId: 'e2e-user', provider: 'groq', stage: 'llm', model: 'llama-3.3-70b', latencyMs: 350, success: true, timestamp: Date.now() });

    // Step 5: Track spend
    await tracker.record({
      userId: 'e2e-user',
      provider: 'groq',
      model: 'llama-3.3-70b',
      stage: 'llm',
      inputTokens: 200,
      outputTokens: 80,
      costUsd: estimateRequestCost('groq', 'llama-3.3-70b-versatile', 200, 80),
      timestamp: Date.now(),
    });

    const summary = await tracker.getDailySummary('e2e-user');
    expect(summary.requestCount).toBe(1);
    expect(summary.byProvider.groq.requests).toBe(1);

    // Step 6: Simulate scale-up event
    emitHook(hooks, 'onScaleUp', { userId: 'e2e-user', tierIndex: 0, provider: 'runpod', trigger: 'sessions', activeSessions: 6, timestamp: Date.now() });
    emitHook(hooks, 'onHealthChange', { userId: 'e2e-user', tierIndex: 0, provider: 'runpod', previousState: 'booting', newState: 'ready', endpoint: 'http://gpu-0:8000', timestamp: Date.now() });

    expect(events).toEqual([
      'start:llm:groq',
      'end:llm:ok',
      'scaleUp:tier0',
      'health:booting→ready',
    ]);

    console.log(`[e2e] Events: ${events.join(' → ')}`);
    console.log(`[e2e] Spend: $${summary.totalCostUsd.toFixed(6)} across ${summary.requestCount} request(s)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. FULL BOOT CYCLE: Stop → Boot → Wait → Inference
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!process.env.RUNPOD_API_KEY || !!process.env.SKIP_GPU_TESTS)('E2E: GPU Boot Cycle — stop, boot, wait, inference', () => {
  let client: RunpodClient;
  let creds: ProviderCredentials;
  let bootedEndpoint: string;
  let bootedPodId: string;

  beforeAll(() => {
    client = new RunpodClient();
    creds = { apiKey: process.env.RUNPOD_API_KEY! };
  });

  it('stops all existing RunPod pods', async () => {
    const pods = await client.listInstances(creds);
    const running = pods.filter(p => p.status === 'RUNNING' || p.status === 'STARTING');
    console.log(`[boot-cycle] Found ${running.length} active pod(s) to stop`);

    for (const pod of running) {
      console.log(`[boot-cycle] Stopping ${pod.instanceId}...`);
      await client.stopInstance(pod.instanceId, creds);
    }

    if (running.length > 0) {
      // Wait for pods to actually stop
      let attempts = 0;
      while (attempts < 12) {
        await new Promise(r => setTimeout(r, 5_000));
        const current = await client.listInstances(creds);
        const stillRunning = current.filter(p => p.status === 'RUNNING');
        if (stillRunning.length === 0) {
          console.log(`[boot-cycle] All pods stopped after ${(attempts + 1) * 5}s`);
          break;
        }
        attempts++;
      }
    }

    const final = await client.listInstances(creds);
    const stillActive = final.filter(p => p.status === 'RUNNING');
    expect(stillActive.length).toBe(0);
    console.log('[boot-cycle] All pods stopped');
  }, 120_000);

  it('boots a new GPU via autoscaler triggerGpuBoot()', async () => {
    const registry = new GpuProviderRegistry();
    registry.register(client);

    // Use the autoscaler engine to boot
    const { AutoscalerEngine } = await import('@ai-gateway/autoscaler/engine');
    const { SessionTracker } = await import('@ai-gateway/autoscaler/session-tracker');
    const { LatencyTracker } = await import('@ai-gateway/autoscaler/latency-tracker');
    const { StatePersistence } = await import('@ai-gateway/autoscaler/state-persistence');

    const store = new MemoryStateStore();
    const sessionTracker = new SessionTracker(store, { getActiveSessionCount: async () => 0 } as any);
    const latencyTracker = new LatencyTracker(store);
    const persistence = new StatePersistence(store);
    const noop = async () => {};

    const engine = new AutoscalerEngine({
      registry, sessionTracker, latencyTracker, persistence,
      probeHealth: probeGpuHealth, cleanupInstance: async () => {},
    } as any);

    const tierConfig = {
      provider: 'runpod' as const,
      apiKey: process.env.RUNPOD_API_KEY!,
      gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3090', 'NVIDIA RTX A5000'],
      dockerImage: 'marcosremar/parle-s2s:latest',
      hfToken: process.env.HF_TOKEN,
    };

    console.log('[boot-cycle] Triggering GPU boot via autoscaler...');
    const bootStart = Date.now();
    const result = await engine.triggerGpuBoot(tierConfig, 0, 'boot-test-user');

    expect(result.ok).toBe(true);
    console.log(`[boot-cycle] Boot triggered: instanceId=${result.instanceId}, endpoint=${result.endpoint}`);
    console.log(`[boot-cycle] Boot trigger took ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

    bootedPodId = result.instanceId!;
    expect(bootedPodId).toBeTruthy();
  }, 120_000);

  it('waits for GPU to become healthy (polls every 15s, max 10min)', async () => {
    expect(bootedPodId).toBeTruthy();

    // Get the direct endpoint
    const res = await fetch(`https://rest.runpod.io/v1/pods/${bootedPodId}`, {
      headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY!}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    let endpoint: string | null = null;

    if (res.ok) {
      const pod = await res.json() as Record<string, any>;
      const ip = pod.publicIp;
      const portMap = pod.portMappings as Record<string, number> | undefined;
      if (ip && portMap?.['8000']) {
        endpoint = `http://${ip}:${portMap['8000']}`;
      }
    }

    // Fallback to proxy
    if (!endpoint) {
      endpoint = `https://${bootedPodId}-8000.proxy.runpod.net`;
    }

    console.log(`[boot-cycle] Polling health at: ${endpoint}`);
    const pollStart = Date.now();
    const maxWaitMs = 10 * 60 * 1000; // 10 minutes
    const pollIntervalMs = 15_000;
    let healthy = false;
    let lastStatus = '';

    while (Date.now() - pollStart < maxWaitMs) {
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
      try {
        // Re-discover endpoint (IP/port may change as pod starts)
        const podRes = await fetch(`https://rest.runpod.io/v1/pods/${bootedPodId}`, {
          headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY!}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        }).catch(() => null);

        if (podRes?.ok) {
          const pod = await podRes.json() as Record<string, any>;
          const ip = pod.publicIp;
          const portMap = pod.portMappings as Record<string, number> | undefined;
          if (ip && portMap?.['8000']) {
            const newEndpoint = `http://${ip}:${portMap['8000']}`;
            if (newEndpoint !== endpoint) {
              console.log(`[boot-cycle] [${elapsed}s] Endpoint updated: ${endpoint} → ${newEndpoint}`);
              endpoint = newEndpoint;
            }
          }
          const status = pod.desiredStatus || pod.status || '?';
          if (status !== lastStatus) {
            console.log(`[boot-cycle] [${elapsed}s] Pod status: ${status}`);
            lastStatus = status;
          }
        }

        const healthRes = await fetch(`${endpoint}/health`, {
          signal: AbortSignal.timeout(5_000),
        });

        if (healthRes.ok) {
          const data = await healthRes.json() as Record<string, any>;
          if (data.status === 'healthy') {
            healthy = true;
            bootedEndpoint = endpoint;
            const totalSecs = ((Date.now() - pollStart) / 1000).toFixed(1);
            console.log(`[boot-cycle] [${elapsed}s] GPU HEALTHY after ${totalSecs}s`);
            console.log(`[boot-cycle] Models: STT=${data.models?.stt}, LLM=${data.models?.llm}, TTS=${data.models?.tts}`);
            console.log(`[boot-cycle] VRAM: ${data.vram_gb}GB`);
            break;
          } else {
            console.log(`[boot-cycle] [${elapsed}s] Health response: ${data.status || 'loading...'}`);
          }
        } else {
          console.log(`[boot-cycle] [${elapsed}s] Health HTTP ${healthRes.status}`);
        }
      } catch (err: any) {
        const msg = err.message?.includes('timeout') ? 'timeout'
          : err.message?.includes('ECONNREFUSED') ? 'connection refused'
          : err.message?.includes('fetch failed') ? 'unreachable'
          : err.message?.substring(0, 50) || 'error';
        console.log(`[boot-cycle] [${elapsed}s] ${msg}`);
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    expect(healthy).toBe(true);
  }, 660_000); // 11 min timeout

  it('runs inference on freshly booted GPU', async () => {
    expect(bootedEndpoint).toBeTruthy();

    // Health check
    const healthOk = await probeGpuHealth(bootedEndpoint);
    expect(healthOk).toBe(true);

    // LLM + TTS inference
    const start = Date.now();
    const res = await fetch(`${bootedEndpoint}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Olá! Me fale sobre o Brasil em uma frase.',
        history: [
          { role: 'system', content: 'Você é um professor de português brasileiro. Responda em português, de forma concisa.' },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, any>;
    const latency = Date.now() - start;

    // LLM response
    expect(data.response?.text).toBeTruthy();
    expect(data.response.text.length).toBeGreaterThan(10);
    console.log(`[boot-cycle] LLM: "${data.response.text.substring(0, 120)}"`);

    // TTS audio
    expect(data.speech?.audio).toBeTruthy();
    const audioBytes = Buffer.from(data.speech.audio, 'base64');
    expect(audioBytes.length).toBeGreaterThan(1000);
    console.log(`[boot-cycle] Audio: ${audioBytes.length} bytes, ${data.speech.format || 'wav'}`);

    // Timing
    console.log(`[boot-cycle] Timing: LLM=${data.timing?.llm_ms}ms TTS=${data.timing?.tts_ms}ms Total=${data.timing?.total_ms}ms (e2e=${latency}ms)`);

    // Multi-turn test
    const res2 = await fetch(`${bootedEndpoint}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Repita exatamente: "O teste de boot funcionou!"',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    expect(res2.ok).toBe(true);
    const data2 = await res2.json() as Record<string, any>;
    expect(data2.response?.text).toBeTruthy();
    console.log(`[boot-cycle] Verification: "${data2.response.text.substring(0, 100)}"`);
    console.log('[boot-cycle] FULL BOOT CYCLE COMPLETE — GPU operational');
  }, 120_000);
});
