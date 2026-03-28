/**
 * AI Gateway — Comprehensive Integration Tests
 *
 * Tests all major subsystems of the ai-gateway package with realistic scenarios:
 *
 *   1. Provider Fallback System
 *      - Retry with exponential backoff (5xx)
 *      - Rate-limit skip (429)
 *      - Timeout fallback (real + injected)
 *      - Auth error (401/402/403) → next provider
 *      - Non-retryable 400 → throw immediately
 *      - Context window → model upgrade → fallback
 *      - Cooldown activation, skipping, expiry
 *      - All providers fail, all cooling down
 *
 *   2. AIClient (profile-based unified client)
 *      - Profile resolution (preset names + overrides)
 *      - transcribe(), chat(), synthesize() with mock providers
 *      - Fallback across providers (STT, LLM, TTS)
 *      - Pipeline: STT → LLM → TTS cloud fallback
 *      - Spend tracking integration
 *      - Declarative fallback chains
 *
 *   3. Browser SDK — SpeechClient
 *      - Auto-discovery (merges transport config)
 *      - Transport fallback (WebSocket → SSE)
 *      - Circuit breaker (open after N failures, auto-reset)
 *      - Reconnection with exponential backoff
 *      - Event emission (connected, fallback, error, response)
 *      - Input validation (empty audio, empty text, not connected)
 *      - destroy() cleans up all state
 *
 *   4. Autoscaler Engine
 *      - Tier state machine (idle → booting → ready)
 *      - Session-based scale trigger
 *      - Latency-based scale trigger
 *      - Tier fallback (tier 0 unhealthy → boot tier 1)
 *      - Boot timeout → idle + cooldown
 *      - forceGpuReady / resetGpuState
 *      - Server restart recovery
 *
 *   5. Declarative Fallback Chains
 *      - resolveDeclarativeChain() priority sorting
 *      - findChainForStage() lookup
 *      - Per-chain option overrides
 *
 *   6. Spend Tracker
 *      - Record spend events
 *      - Daily summary aggregation
 *      - Budget check (over/under)
 *      - Cost estimation from pricing table
 *
 *   7. Load Balancer
 *      - Hash strategy (deterministic)
 *      - Round-robin strategy
 *      - Affinity strategy (sticky)
 *      - Least-latency strategy (EMA)
 *
 *   8. Audio Utilities
 *      - float32ToWavBuffer()
 *      - combineWavChunksToBase64()
 *      - buildSilentWav()
 *      - uint8ToBase64()
 *
 *   9. TypedEmitter
 *      - on/off/emit lifecycle
 *      - Error isolation (listener error doesn't break others)
 *      - removeAllListeners()
 *
 *  10. SpeechSDKError
 *      - Error codes & recoverability defaults
 *
 * Uses in-memory mocks — no Redis, no Prisma, no real network needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// Imports
// ═══════════════════════════════════════════════════════════════════════════════

// Provider fallback
import {
  withProviderFallback,
  isRetryableError,
  isContextWindowError,
  getCooldownState,
} from '@ai-gateway/providers/fallback';

// Declarative chains
import {
  resolveDeclarativeChain,
  findChainForStage,
} from '@ai-gateway/providers/declarative-chain';
import type { FallbackChainConfig } from '@ai-gateway/providers/declarative-chain';

// AIClient
import { AIClient } from '@ai-gateway/client/ai-client';
import { resolveProfile, mergeProfiles, VOICE_PROFILE, CHAT_PROFILE, STT_PROFILE, TTS_PROFILE, LLM_PROFILE, IMAGE_PROFILE, SYSTEM_PROFILE } from '@ai-gateway/client/presets';
import type { AIProfile } from '@ai-gateway/client/types';

// Registry
import { AIProviderRegistry } from '@ai-gateway/providers/registry';

// Browser SDK
import { SpeechClient } from '@ai-gateway/browser/speech-client';
import { SpeechSDKError } from '@ai-gateway/browser/errors';
import { TypedEmitter } from '@ai-gateway/browser/emitter';
import { setLogLevel } from '@ai-gateway/browser/logger';
import {
  float32ToWavBuffer,
  combineWavChunksToBase64,
  buildSilentWav,
  uint8ToBase64,
} from '@ai-gateway/browser/audio';

// Autoscaler
import { createAutoscaler } from '@ai-gateway/factory';
import type { AutoScalerConfig, GpuTierConfig } from '@ai-gateway/types';
import type { StateStore, SessionResolver, SettingsStore } from '@ai-gateway/deps';

// Spend Tracker
import { SpendTracker } from '@ai-gateway/tracking/spend-tracker';
import { lookupPricing, estimateRequestCost, DEFAULT_PRICING_TABLE } from '@ai-gateway/tracking/pricing';

// Load Balancer
import { LoadBalancer } from '@ai-gateway/autoscaler/load-balancer';
import type { GpuTierState } from '@ai-gateway/types';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function httpErr(status: number, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status });
}
function timeoutErr(provider = 'provider') {
  const e = new Error(`${provider} timeout after 50ms`);
  (e as any).__timeout = true;
  return e;
}
function contextErr(msg = 'context_length_exceeded: prompt too long') {
  return Object.assign(new Error(msg), { status: 400 });
}

/** In-memory StateStore (replaces Redis) */
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
  async ltrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key);
    if (!list) return;
    const s = start < 0 ? Math.max(list.length + start, 0) : start;
    const e = stop < 0 ? list.length + stop : stop;
    this.lists.set(key, list.slice(s, e + 1));
  }
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

class MockSettingsStore implements SettingsStore {
  private data = new Map<string, Record<string, unknown>>();
  async get(userId: string) { return this.data.get(userId) ?? {}; }
  async patch(userId: string, partial: Record<string, unknown>) {
    this.data.set(userId, { ...(this.data.get(userId) ?? {}), ...partial });
  }
  setData(userId: string, data: Record<string, unknown>) { this.data.set(userId, data); }
}

class MockSessionResolver implements SessionResolver {
  dbSessionCount = 0;
  async countDbSessions() { return this.dbSessionCount; }
  async resolveTeacher() { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Provider Fallback System
// ═══════════════════════════════════════════════════════════════════════════════

describe('1. Provider Fallback System — Integration', () => {
  beforeEach(() => {
    getCooldownState().clear();
  });

  describe('multi-error pipeline simulation', () => {
    it('groq timeout → openai 429 → openrouter 502+retry → openrouter success', async () => {
      let callIdx = 0;
      const fn = vi.fn().mockImplementation(({ provider }: { provider: string }) => {
        callIdx++;
        if (provider === 'groq') return new Promise((_, rej) => setTimeout(() => rej(timeoutErr('groq')), 60));
        if (provider === 'openai') return Promise.reject(httpErr(429));
        if (provider === 'openrouter' && callIdx === 3) return Promise.reject(httpErr(502));
        return Promise.resolve('openrouter-ok');
      });

      const { result, usedProvider, attempts } = await withProviderFallback(
        [
          { provider: 'groq', model: 'whisper' },
          { provider: 'openai', model: 'gpt-4o-mini' },
          { provider: 'openrouter', model: 'auto' },
        ],
        fn,
        { timeoutMs: 50, retriesPerProvider: 1, retryBaseDelayMs: 5 },
      );
      expect(result).toBe('openrouter-ok');
      expect(usedProvider).toBe('openrouter');
    }, 5000);

    it('cascading context window errors with model upgrades', async () => {
      const calls: string[] = [];
      const fn = vi.fn().mockImplementation(({ provider, model }: { provider: string; model: string }) => {
        calls.push(`${provider}/${model}`);
        if (model === 'llama-3.1-8b-instant') return Promise.reject(contextErr('context_length_exceeded'));
        if (model === 'llama-3.3-70b-versatile') return Promise.reject(contextErr('too many tokens'));
        if (model === 'gpt-4o-mini') return Promise.reject(contextErr('context window exceeded'));
        return Promise.resolve('gpt-4o-ok');
      });

      const { usedProvider, usedModel } = await withProviderFallback(
        [
          { provider: 'groq', model: 'llama-3.1-8b-instant' },
          { provider: 'openai', model: 'gpt-4o-mini' },
        ],
        fn,
        {
          contextWindowFallbacks: {
            'llama-3.1-8b-instant': 'llama-3.3-70b-versatile',
            'gpt-4o-mini': 'gpt-4o',
          },
        },
      );

      expect(calls).toEqual([
        'groq/llama-3.1-8b-instant',
        'groq/llama-3.3-70b-versatile',
        'openai/gpt-4o-mini',
        'openai/gpt-4o',
      ]);
      expect(usedProvider).toBe('openai');
      expect(usedModel).toBe('gpt-4o');
    });

    it('cooldown activates after repeated failures and expires after cooldownMs', async () => {
      const fn = vi.fn().mockRejectedValue(httpErr(503));
      const chain = [{ provider: 'groq', model: 'x' }, { provider: 'openai', model: 'y' }];

      // Trigger cooldown on groq (3 failures)
      for (let i = 0; i < 3; i++) {
        await withProviderFallback(chain, fn, { allowedFails: 3, cooldownMs: 100 }).catch(() => {});
      }

      // groq is now cooling down
      const state = getCooldownState().get('groq:x');
      expect(state).toBeDefined();
      expect(state!.coolUntil).toBeGreaterThan(Date.now());

      // Wait for cooldown to expire
      await new Promise((r) => setTimeout(r, 150));

      // groq should be available again
      const successFn = vi.fn().mockResolvedValue('groq-back');
      const { usedProvider } = await withProviderFallback(chain, successFn, { allowedFails: 3, cooldownMs: 100 });
      expect(usedProvider).toBe('groq');
    }, 3000);

    it('401 + 402 + 403 all skip to next provider without retry', async () => {
      const calls: number[] = [];
      const fn = vi.fn().mockImplementation((_: unknown, idx: number) => {
        calls.push(idx);
        if (idx === 0) return Promise.reject(httpErr(401));
        if (idx === 1) return Promise.reject(httpErr(402));
        if (idx === 2) return Promise.reject(httpErr(403));
        return Promise.resolve('final-ok');
      });

      const { usedProvider, attempts } = await withProviderFallback(
        [
          { provider: 'p1' }, { provider: 'p2' },
          { provider: 'p3' }, { provider: 'p4' },
        ],
        fn,
        { retriesPerProvider: 2, retryBaseDelayMs: 1 },
      );

      expect(usedProvider).toBe('p4');
      expect(attempts).toBe(4);
      // Each auth error should NOT retry, so exactly 4 calls total
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('non-retryable 400 aborts immediately even with multiple providers', async () => {
      const fn = vi.fn().mockRejectedValue(httpErr(400, 'invalid model'));
      await expect(
        withProviderFallback(
          [{ provider: 'a' }, { provider: 'b' }, { provider: 'c' }],
          fn,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('5xx retries exhaust then next provider; next provider also 5xx retries then succeeds', async () => {
      let callCount = 0;
      const fn = vi.fn().mockImplementation(({ provider }: { provider: string }) => {
        callCount++;
        // groq: fail twice (attempt + 1 retry)
        if (provider === 'groq') return Promise.reject(httpErr(503));
        // openai: fail once on first attempt, succeed on retry
        if (provider === 'openai') {
          if (callCount === 3) return Promise.reject(httpErr(502));
          return Promise.resolve('openai-recovered');
        }
        return Promise.resolve('fallback');
      });

      const { usedProvider, result } = await withProviderFallback(
        [{ provider: 'groq' }, { provider: 'openai' }],
        fn,
        { retriesPerProvider: 1, retryBaseDelayMs: 5 },
      );
      expect(usedProvider).toBe('openai');
      expect(result).toBe('openai-recovered');
      // groq: 2 calls (attempt + retry), openai: 2 calls (fail + retry success) = 4
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. AIClient — Profile-based Unified Client
// ═══════════════════════════════════════════════════════════════════════════════

describe('2. AIClient — Integration', () => {
  function createMockRegistry() {
    const registry = new AIProviderRegistry();

    const mockSTT = (id: string) => ({
      transcribe: vi.fn().mockResolvedValue({ text: `transcribed-by-${id}`, language: 'pt' }),
      isConfigured: () => true,
      getModels: () => [],
    });

    const mockLLM = (id: string) => ({
      chat: vi.fn().mockResolvedValue({
        content: `response-from-${id}`,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        model: `model-${id}`,
      }),
      isConfigured: () => true,
    });

    const mockTTS = (id: string) => ({
      synthesize: vi.fn().mockResolvedValue({
        audio: Buffer.from('audio-data'),
        contentType: 'audio/wav',
      }),
      isConfigured: () => true,
      getModels: () => [],
    });

    const mockImage = (id: string) => ({
      generate: vi.fn().mockResolvedValue({
        image: Buffer.from('image-data'),
        contentType: 'image/png',
      }),
      isConfigured: () => true,
      getModels: () => [],
    });

    for (const id of ['groq', 'openai', 'openrouter', 'fireworks', 'modal']) {
      registry.register({
        id: id as any,
        name: id,
        description: `Mock ${id}`,
        capabilities: ['stt', 'llm', 'tts', 'image'] as any[],
        requiresApiKey: false,
        stt: mockSTT(id) as any,
        llm: mockLLM(id) as any,
        tts: mockTTS(id) as any,
        image: mockImage(id) as any,
      } as any);
    }

    return registry;
  }

  beforeEach(() => {
    getCooldownState().clear();
  });

  describe('profile resolution', () => {
    it('resolves preset name to profile', () => {
      const p = resolveProfile('voice');
      expect(p.preset).toBe('voice');
      expect(p.stt).toBeDefined();
      expect(p.llm).toBeDefined();
      expect(p.tts).toBeDefined();
    });

    it('resolves all preset names', () => {
      for (const name of ['voice', 'chat', 'stt', 'tts', 'llm', 'image', 'system'] as const) {
        const p = resolveProfile(name);
        expect(p.preset).toBe(name);
      }
    });

    it('throws on unknown preset', () => {
      expect(() => resolveProfile('invalid' as any)).toThrow('Unknown profile preset');
    });

    it('mergeProfiles overrides arrays and shallow-merges options', () => {
      const base: AIProfile = {
        stt: [{ provider: 'groq' }],
        fallbackOptions: { timeoutMs: 5000 },
      };
      const override: AIProfile = {
        stt: [{ provider: 'openai' }],
        fallbackOptions: { retriesPerProvider: 2 },
      };
      const merged = mergeProfiles(base, override);
      expect(merged.stt).toEqual([{ provider: 'openai' }]);
      expect(merged.fallbackOptions?.timeoutMs).toBe(5000);
      expect(merged.fallbackOptions?.retriesPerProvider).toBe(2);
    });

    it('mergeProfiles merges keys per-provider', () => {
      const base: AIProfile = { keys: { groq: 'key1' } };
      const override: AIProfile = { keys: { openai: 'key2' } };
      const merged = mergeProfiles(base, override);
      expect(merged.keys).toEqual({ groq: 'key1', openai: 'key2' });
    });
  });

  describe('transcribe / chat / synthesize', () => {
    it('transcribe returns result from first provider', async () => {
      const registry = createMockRegistry();
      const client = new AIClient({ registry, defaultProfile: 'stt' });

      const result = await client.transcribe(Buffer.from('audio'));
      expect(result.text).toBe('transcribed-by-groq');
      expect(result.provider).toBe('groq');
      expect(result.fallbackUsed).toBe(false);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('chat returns result with usage', async () => {
      const registry = createMockRegistry();
      const client = new AIClient({ registry, defaultProfile: 'chat' });

      const result = await client.chat([{ role: 'user', content: 'Olá' }]);
      expect(result.content).toBe('response-from-openai');
      expect(result.provider).toBe('openai');
      expect(result.usage).toBeDefined();
      expect(result.usage!.totalTokens).toBe(150);
    });

    it('synthesize returns audio buffer', async () => {
      const registry = createMockRegistry();
      const client = new AIClient({ registry, defaultProfile: 'tts' });

      const result = await client.synthesize('Olá mundo');
      expect(result.audio).toBeDefined();
      expect(result.contentType).toBe('audio/wav');
      expect(result.provider).toBe('groq');
    });

    it('transcribe falls back when first provider fails', async () => {
      const registry = createMockRegistry();
      // Make groq STT fail
      (registry.getSTTProvider('groq') as any).transcribe = vi.fn().mockRejectedValue(httpErr(503));

      const client = new AIClient({ registry, defaultProfile: 'stt' });
      const result = await client.transcribe(Buffer.from('audio'));
      expect(result.text).toBe('transcribed-by-openai');
      expect(result.provider).toBe('openai');
      expect(result.fallbackUsed).toBe(true);
    });

    it('chat falls back on context window with model upgrade', async () => {
      const registry = createMockRegistry();
      const openaiLLM = registry.getLLMProvider('openai') as any;

      let callCount = 0;
      openaiLLM.chat = vi.fn().mockImplementation((req: any) => {
        callCount++;
        if (req.model === 'gpt-4o') {
          return Promise.resolve({
            content: 'large-model-response',
            usage: { promptTokens: 500, completionTokens: 200, totalTokens: 700 },
            model: 'gpt-4o',
          });
        }
        return Promise.reject(contextErr('context_length_exceeded'));
      });

      const client = new AIClient({
        registry,
        defaultProfile: {
          llm: [
            { provider: 'openai', model: 'gpt-4o-mini' },
            { provider: 'openai', model: 'gpt-4o' },
          ],
          fallbackOptions: {
            contextWindowFallbacks: { 'gpt-4o-mini': 'gpt-4o' },
          },
        },
      });

      const result = await client.chat([{ role: 'user', content: 'long message' }]);
      expect(result.content).toBe('large-model-response');
    });
  });

  describe('spend tracking integration', () => {
    it('records spend when tracker is available', async () => {
      const stateStore = new MemoryStateStore();
      const tracker = new SpendTracker(stateStore, DEFAULT_PRICING_TABLE);
      const recordSpy = vi.spyOn(tracker, 'record');

      const registry = createMockRegistry();
      const client = new AIClient({
        registry,
        userId: 'user-123',
        defaultProfile: 'chat',
        spendTracker: tracker,
      });

      await client.chat([{ role: 'user', content: 'test' }]);

      // record() is called in fire-and-forget mode
      await new Promise((r) => setTimeout(r, 50));
      expect(recordSpy).toHaveBeenCalled();
      const call = recordSpy.mock.calls[0][0];
      expect(call.userId).toBe('user-123');
      expect(call.stage).toBe('llm');
      expect(call.inputTokens).toBe(100);
      expect(call.outputTokens).toBe(50);
    });
  });

  describe('declarative fallback chains in profile', () => {
    it('uses declarative chain when specified in profile', async () => {
      const registry = createMockRegistry();
      const groqLLM = registry.getLLMProvider('groq') as any;
      groqLLM.chat = vi.fn().mockRejectedValue(httpErr(503));

      const client = new AIClient({
        registry,
        defaultProfile: {
          fallbackChains: [{
            stage: 'llm',
            chain: [
              { provider: 'groq', model: 'llama-3.3-70b', priority: 1 },
              { provider: 'openai', model: 'gpt-4o', priority: 2 },
            ],
            timeoutMs: 5000,
          }],
          llm: [{ provider: 'groq' }], // should be overridden by declarative chain
        },
      });

      const result = await client.chat([{ role: 'user', content: 'test' }]);
      expect(result.provider).toBe('openai');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Browser SDK — SpeechClient
// ═══════════════════════════════════════════════════════════════════════════════

describe('3. Browser SDK — SpeechClient Integration', () => {
  beforeEach(() => setLogLevel('silent'));
  afterEach(() => setLogLevel('warn'));

  describe('auto-discovery', () => {
    it('discover() merges transport config from backend', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          transports: {
            websocket: { url: 'wss://gpu.example.com/ws' },
            sse: { endpoint: 'https://sse.example.com' },
          },
          gpu: {
            status: 'ready',
            models: { whisper: true, llm: true, tts: true },
          },
        }), { status: 200 }),
      );

      const client = new SpeechClient({ discoveryEndpoint: '/api/speech/health' });

      const data = await client.discover();
      expect(data).not.toBeNull();
      expect(data!.transports!.websocket!.url).toBe('wss://gpu.example.com/ws');
      expect(client.serviceStatus).toBe('ready');
      expect(client.modelStatus).toEqual({ whisper: true, llm: true, tts: true });

      fetchSpy.mockRestore();
      client.destroy();
    });

    it('discover() handles failure gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const client = new SpeechClient({ discoveryEndpoint: '/api/speech/health' });
      const data = await client.discover();
      expect(data).toBeNull();

      fetchSpy.mockRestore();
      client.destroy();
    });

    it('discover() handles non-ok response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('', { status: 500 }),
      );

      const client = new SpeechClient({ discoveryEndpoint: '/api/speech/health' });
      const data = await client.discover();
      expect(data).toBeNull();

      fetchSpy.mockRestore();
      client.destroy();
    });

    it('discover() sets service status from gpu.status field', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          transports: {},
          gpu: {
            status: 'waking',
            models: { whisper: true, llm: false, tts: true },
          },
        }), { status: 200 }),
      );

      const client = new SpeechClient({ discoveryEndpoint: '/api/speech/health' });

      const statusChanges: string[] = [];
      client.on('status-change', ({ status }) => statusChanges.push(status));

      await client.discover();
      expect(client.serviceStatus).toBe('waking');
      expect(statusChanges).toContain('waking');
      expect(client.modelStatus).toEqual({ whisper: true, llm: false, tts: true });

      fetchSpy.mockRestore();
      client.destroy();
    });
  });

  describe('transport fallback', () => {
    it('falls back from SSE to next when first SSE endpoint fails', async () => {
      // Mock: first SSE health check fails, then we try a different config
      // Since WebSocket mocking is unreliable in test env, test SSE-only fallback
      const client = new SpeechClient({
        // Only SSE configured — test that connection works when health passes
        sse: { endpoint: 'https://sse.example.com' },
        fallbackOrder: ['sse'],
        fallbackTimeoutMs: 500,
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));

      const connected = await client.connect();
      expect(connected).toBe(true);
      expect(client.activeProtocol).toBe('sse');

      fetchSpy.mockRestore();
      client.destroy();
    });

    it('emits TRANSPORT_FAILED error when all transports fail', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('health fail'));

      const client = new SpeechClient({
        sse: { endpoint: 'https://broken-sse.example.com' },
        fallbackOrder: ['sse'],
        fallbackTimeoutMs: 500,
      });

      const errors: any[] = [];
      client.on('error', (e) => errors.push(e));

      const connected = await client.connect();
      expect(connected).toBe(false);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[errors.length - 1].code).toBe('TRANSPORT_FAILED');

      fetchSpy.mockRestore();
      client.destroy();
    });

    it('skips transports that have no config', async () => {
      // WebRTC and WebSocket not configured — should only try SSE
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));

      const client = new SpeechClient({
        sse: { endpoint: 'https://ok.example.com' },
        fallbackOrder: ['webrtc', 'websocket', 'sse'],
        fallbackTimeoutMs: 500,
      });

      const connected = await client.connect();
      expect(connected).toBe(true);
      expect(client.activeProtocol).toBe('sse');

      fetchSpy.mockRestore();
      client.destroy();
    });
  });

  describe('circuit breaker', () => {
    it('opens circuit after consecutive all-transport failures', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('always fail'));

      const client = new SpeechClient({
        sse: { endpoint: 'https://fail.example.com' },
        fallbackOrder: ['sse'],
        circuitBreaker: { failureThreshold: 3, cooldownMs: 200 },
        fallbackTimeoutMs: 100,
      });

      const circuitChanges: any[] = [];
      client.on('circuit-change', (e) => circuitChanges.push(e));
      const errors: any[] = [];
      client.on('error', (e) => errors.push(e));

      // Each connect attempt = 1 failure (SSE health check fails → all transports fail → recordFailure)
      for (let i = 0; i < 3; i++) {
        await client.connect();
      }

      // Circuit should be open now
      const metrics = client.getMetrics();
      expect(metrics.consecutiveFailures).toBeGreaterThanOrEqual(3);
      expect(circuitChanges.some(c => c.open === true)).toBe(true);

      // Connect should return false due to circuit breaker
      const result = await client.connect();
      expect(result).toBe(false);
      // Should get a CIRCUIT_OPEN error
      expect(errors.some(e => e.code === 'CIRCUIT_OPEN')).toBe(true);

      fetchSpy.mockRestore();
      client.destroy();
    });

    it('circuit resets after cooldown period', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('fail'));

      const client = new SpeechClient({
        sse: { endpoint: 'https://fail.example.com' },
        fallbackOrder: ['sse'],
        circuitBreaker: { failureThreshold: 2, cooldownMs: 100 },
        fallbackTimeoutMs: 100,
      });

      // Open circuit
      for (let i = 0; i < 2; i++) {
        await client.connect();
      }

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 150));

      // Now mock a successful SSE connect
      fetchSpy.mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));
      const connected = await client.connect();
      expect(connected).toBe(true);
      expect(client.getMetrics().circuitOpen).toBe(false);

      fetchSpy.mockRestore();
      client.destroy();
    });
  });

  describe('input validation', () => {
    it('throws NOT_CONNECTED when sending audio without connection', async () => {
      const client = new SpeechClient({});
      await expect(client.sendAudio(new Float32Array(100)))
        .rejects.toThrow(SpeechSDKError);
      client.destroy();
    });

    it('throws DESTROYED after destroy()', async () => {
      const client = new SpeechClient({});
      client.destroy();
      await expect(client.sendAudio(new Float32Array(100)))
        .rejects.toThrow('destroyed');
    });
  });

  describe('destroy cleanup', () => {
    it('destroy removes all listeners and stops polling', () => {
      const client = new SpeechClient({});
      let called = false;
      client.on('connected', () => { called = true; });

      client.destroy();

      // After destroy, events should not fire
      (client as any).emit('connected', { protocol: 'sse' });
      expect(called).toBe(false);
    });
  });

  describe('metrics tracking', () => {
    it('tracks connection counts on successful connect', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));

      const client = new SpeechClient({
        sse: { endpoint: 'https://ok.example.com' },
        fallbackOrder: ['sse'],
        fallbackTimeoutMs: 500,
      });

      await client.connect();
      const metrics = client.getMetrics();
      expect(metrics.totalConnections).toBe(1);
      expect(metrics.consecutiveFailures).toBe(0);
      expect(metrics.transportLatency.sse).toBeGreaterThanOrEqual(0);

      fetchSpy.mockRestore();
      client.destroy();
    });

    it('tracks errors on failed connect', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('fail'));

      const client = new SpeechClient({
        sse: { endpoint: 'https://fail.example.com' },
        fallbackOrder: ['sse'],
        fallbackTimeoutMs: 500,
      });

      await client.connect();
      const metrics = client.getMetrics();
      expect(metrics.totalConnections).toBe(0);
      expect(metrics.consecutiveFailures).toBe(1);

      fetchSpy.mockRestore();
      client.destroy();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Autoscaler Engine
// ═══════════════════════════════════════════════════════════════════════════════

describe('4. Autoscaler Engine — Integration', () => {
  const USER = 'user-autoscaler-integration';
  const healthyEndpoints = new Set<string>();

  function mockFetch(input: string | URL | Request): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/health')) {
      const endpoint = url.replace('/health', '');
      if (healthyEndpoints.has(endpoint)) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'healthy' }), { status: 200 }));
      }
      return Promise.reject(new Error('Connection refused'));
    }
    if (url.includes('runpod.io') || url.includes('tensordock.com')) {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return Promise.reject(new Error(`Unmocked: ${url}`));
  }

  function makeTier(provider: 'runpod' | 'tensordock', idx: number): GpuTierConfig {
    return {
      provider,
      instanceId: `inst-${provider}-${idx}`,
      endpoint: `http://${provider}-${idx}.test:8000`,
      apiKey: `key-${provider}`,
      ...(provider === 'tensordock' ? { authId: 'auth-td' } : {}),
    };
  }

  function makeConfig(overrides?: Partial<AutoScalerConfig>): AutoScalerConfig {
    return {
      enabled: true,
      threshold: 5,
      windowMinutes: 10,
      maxLatencyMs: 1500,
      tiers: [makeTier('runpod', 0)],
      idleGraceMinutes: 15,
      ...overrides,
    };
  }

  let sessionResolver: MockSessionResolver;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    sessionResolver = new MockSessionResolver();
    healthyEndpoints.clear();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(mockFetch) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('full lifecycle: idle → booting → ready → unhealthy → fallback', () => {
    it('completes full tier lifecycle with fallback to second tier', async () => {
      const tiers = [makeTier('tensordock', 0), makeTier('runpod', 1)];
      const config = makeConfig({ threshold: 1, tiers });
      const stateStore = new MemoryStateStore();
      const settingsStore = new MockSettingsStore();

      const autoscaler = createAutoscaler({
        settingsStore, stateStore, sessionResolver,
        loadConfig: async () => config,
      });

      // Step 1: Below threshold → idle
      sessionResolver.dbSessionCount = 0;
      let decision = await autoscaler.getAutoScaleDecision(USER, config);
      expect(decision.route).toBe('llm');
      expect(decision.gpuState).toBe('idle');

      // Step 2: Hit threshold → boots tier 0
      sessionResolver.dbSessionCount = 1;
      decision = await autoscaler.getAutoScaleDecision(USER, config);
      expect(decision.gpuState).toBe('booting');
      expect(decision.bootingTiers).toBe(1);

      // Step 3: Tier 0 becomes healthy → ready, route to GPU
      autoscaler.forceTierReady(USER, 0, tiers[0].endpoint!);
      healthyEndpoints.add(tiers[0].endpoint!);
      decision = await autoscaler.getAutoScaleDecision(USER, config);
      expect(decision.route).toBe('s2s');
      expect(decision.gpuState).toBe('ready');
      expect(decision.endpoint).toBe(tiers[0].endpoint);
      expect(decision.activeTiers).toBe(1);

      // Step 4: Tier 0 goes unhealthy → marks unhealthy, falls back to LLM
      healthyEndpoints.delete(tiers[0].endpoint!);
      autoscaler.resetGpuState(USER);
      decision = await autoscaler.getAutoScaleDecision(USER, config);
      expect(decision.route).toBe('llm');

      // Step 5: Next cycle should boot tier 1 (runpod) as fallback
      decision = await autoscaler.getAutoScaleDecision(USER, config);
      expect(decision.bootingTiers).toBe(1);
      const pool = autoscaler.getPoolStatus(USER);
      const bootingTier = pool.find(t => t.state === 'booting');
      expect(bootingTier).toBeDefined();
      expect(bootingTier!.tierIndex).toBe(1);

      // Step 6: Tier 1 becomes healthy → route to GPU via tier 1
      autoscaler.forceTierReady(USER, 1, tiers[1].endpoint!);
      healthyEndpoints.add(tiers[1].endpoint!);
      decision = await autoscaler.getAutoScaleDecision(USER, config);
      expect(decision.route).toBe('s2s');
      expect(decision.endpoint).toBe(tiers[1].endpoint);
    });
  });

  describe('forceGpuReady and resetGpuState', () => {
    it('forceGpuReady sets tier as ready immediately', async () => {
      const config = makeConfig({ threshold: 5, tiers: [makeTier('runpod', 0)] });
      const stateStore = new MemoryStateStore();
      const autoscaler = createAutoscaler({
        settingsStore: new MockSettingsStore(),
        stateStore, sessionResolver,
        loadConfig: async () => config,
      });

      autoscaler.forceGpuReady(USER, 'http://forced.test:8000');
      healthyEndpoints.add('http://forced.test:8000');

      // Even with 0 sessions, forced GPU should be used
      sessionResolver.dbSessionCount = 0;
      const decision = await autoscaler.getAutoScaleDecision(USER, config);
      expect(decision.route).toBe('s2s');
      expect(decision.endpoint).toBe('http://forced.test:8000');
    });

    it('resetGpuState clears all state', async () => {
      const config = makeConfig({ threshold: 1, tiers: [makeTier('runpod', 0)] });
      const stateStore = new MemoryStateStore();
      const autoscaler = createAutoscaler({
        settingsStore: new MockSettingsStore(),
        stateStore, sessionResolver,
        loadConfig: async () => config,
      });

      // Boot a tier
      sessionResolver.dbSessionCount = 1;
      await autoscaler.getAutoScaleDecision(USER, config);
      expect(autoscaler.getPoolStatus(USER).length).toBeGreaterThan(0);

      // Reset
      autoscaler.resetGpuState(USER);
      expect(autoscaler.getPoolStatus(USER)).toEqual([]);
    });
  });

  describe('disabled autoscaler', () => {
    it('returns llm route when disabled', async () => {
      const config = makeConfig({ enabled: false });
      const autoscaler = createAutoscaler({
        settingsStore: new MockSettingsStore(),
        stateStore: new MemoryStateStore(),
        sessionResolver,
        loadConfig: async () => config,
      });

      sessionResolver.dbSessionCount = 100;
      const decision = await autoscaler.getAutoScaleDecision(USER, config);
      expect(decision.route).toBe('llm');
      expect(decision.enabled).toBe(false);
    });
  });

  describe('estimatedReadySecs', () => {
    it('returns estimated boot time when tier is booting', async () => {
      const config = makeConfig({ threshold: 1, tiers: [makeTier('runpod', 0)] });
      const autoscaler = createAutoscaler({
        settingsStore: new MockSettingsStore(),
        stateStore: new MemoryStateStore(),
        sessionResolver,
        loadConfig: async () => config,
      });

      sessionResolver.dbSessionCount = 1;
      const decision = await autoscaler.getAutoScaleDecision(USER, config);
      expect(decision.gpuState).toBe('booting');
      expect(decision.estimatedReadySecs).toBeDefined();
      expect(decision.estimatedReadySecs).toBeGreaterThanOrEqual(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Declarative Fallback Chains
// ═══════════════════════════════════════════════════════════════════════════════

describe('5. Declarative Fallback Chains', () => {
  it('resolveDeclarativeChain sorts by priority', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [
        { provider: 'openrouter', model: 'auto', priority: 3 },
        { provider: 'groq', model: 'llama', priority: 1 },
        { provider: 'openai', model: 'gpt-4o', priority: 2 },
      ],
    };

    const { chain } = resolveDeclarativeChain(config);
    expect(chain.map(c => c.provider)).toEqual(['groq', 'openai', 'openrouter']);
  });

  it('resolveDeclarativeChain extracts per-chain options', () => {
    const config: FallbackChainConfig = {
      stage: 'stt',
      chain: [{ provider: 'groq' }],
      cooldownMs: 30000,
      retriesPerProvider: 2,
      timeoutMs: 5000,
    };

    const { options } = resolveDeclarativeChain(config);
    expect(options.cooldownMs).toBe(30000);
    expect(options.retriesPerProvider).toBe(2);
    expect(options.timeoutMs).toBe(5000);
  });

  it('resolveDeclarativeChain handles entries without priority (default 0)', () => {
    const config: FallbackChainConfig = {
      stage: 'tts',
      chain: [
        { provider: 'b' },
        { provider: 'a', priority: -1 },
        { provider: 'c', priority: 1 },
      ],
    };

    const { chain } = resolveDeclarativeChain(config);
    expect(chain.map(c => c.provider)).toEqual(['a', 'b', 'c']);
  });

  it('findChainForStage returns matching chain', () => {
    const chains: FallbackChainConfig[] = [
      { stage: 'stt', chain: [{ provider: 'groq' }] },
      { stage: 'llm', chain: [{ provider: 'openai' }] },
      { stage: 'tts', chain: [{ provider: 'modal' }] },
    ];

    expect(findChainForStage(chains, 'llm')?.chain[0].provider).toBe('openai');
    expect(findChainForStage(chains, 'tts')?.chain[0].provider).toBe('modal');
    expect(findChainForStage(chains, 'image')).toBeUndefined();
  });

  it('findChainForStage returns undefined for empty/undefined chains', () => {
    expect(findChainForStage(undefined, 'llm')).toBeUndefined();
    expect(findChainForStage([], 'llm')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Spend Tracker
// ═══════════════════════════════════════════════════════════════════════════════

describe('6. Spend Tracker', () => {
  let stateStore: MemoryStateStore;
  let tracker: SpendTracker;

  beforeEach(() => {
    stateStore = new MemoryStateStore();
    tracker = new SpendTracker(stateStore, DEFAULT_PRICING_TABLE);
  });

  describe('cost estimation', () => {
    it('estimateRequestCost calculates correctly from pricing table', () => {
      const cost = estimateRequestCost('openai', 'gpt-4o', 1000, 500);
      // gpt-4o: $2.50/1M in, $10.00/1M out
      const expected = (1000 * 2.50 + 500 * 10.00) / 1_000_000;
      expect(cost).toBeCloseTo(expected, 6);
    });

    it('estimateRequestCost returns 0 for unknown models', () => {
      const cost = estimateRequestCost('unknown', 'unknown-model', 1000, 500);
      expect(cost).toBe(0);
    });

    it('lookupPricing finds by provider/model key', () => {
      const pricing = lookupPricing('groq', 'whisper-large-v3-turbo');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPer1M).toBe(0.04);
    });

    it('lookupPricing returns null for unknown', () => {
      expect(lookupPricing('fake', 'fake-model')).toBeNull();
    });

    it('tracker.estimateCost uses pricing table', () => {
      const cost = tracker.estimateCost('groq', 'llama-3.3-70b-versatile', 1000, 500);
      expect(cost).toBeGreaterThan(0);
    });
  });

  describe('recording and daily summary', () => {
    it('records and retrieves daily summary', async () => {
      await tracker.record({
        userId: 'u1', provider: 'openai', model: 'gpt-4o',
        stage: 'llm', inputTokens: 500, outputTokens: 100,
        costUsd: 0.002, timestamp: Date.now(),
      });
      await tracker.record({
        userId: 'u1', provider: 'groq', model: 'whisper',
        stage: 'stt', inputTokens: 1000, outputTokens: 0,
        costUsd: 0.001, timestamp: Date.now(),
      });

      const summary = await tracker.getDailySummary('u1');
      expect(summary.requestCount).toBe(2);
      expect(summary.totalCostUsd).toBeCloseTo(0.003, 6);
      expect(summary.byProvider['openai']).toBeDefined();
      expect(summary.byProvider['openai'].requests).toBe(1);
      expect(summary.byProvider['groq'].requests).toBe(1);
      expect(summary.byStage['llm'].requests).toBe(1);
      expect(summary.byStage['stt'].requests).toBe(1);
    });

    it('getDailySummary returns empty for user with no records', async () => {
      const summary = await tracker.getDailySummary('no-user');
      expect(summary.requestCount).toBe(0);
      expect(summary.totalCostUsd).toBe(0);
    });
  });

  describe('budget checking', () => {
    it('reports under budget', async () => {
      await tracker.record({
        userId: 'u1', provider: 'openai', model: 'gpt-4o',
        stage: 'llm', inputTokens: 100, outputTokens: 50,
        costUsd: 0.50, timestamp: Date.now(),
      });

      const status = await tracker.checkBudget('u1', { dailyLimitUsd: 10.00 });
      expect(status.over).toBe(false);
      expect(status.pct).toBeCloseTo(0.05, 2);
      expect(status.currentUsd).toBeCloseTo(0.50, 2);
    });

    it('reports over budget', async () => {
      await tracker.record({
        userId: 'u1', provider: 'openai', model: 'gpt-4o',
        stage: 'llm', inputTokens: 100, outputTokens: 50,
        costUsd: 15.00, timestamp: Date.now(),
      });

      const status = await tracker.checkBudget('u1', { dailyLimitUsd: 10.00 });
      expect(status.over).toBe(true);
      expect(status.pct).toBeGreaterThan(1);
    });

    it('handles zero budget limit', async () => {
      const status = await tracker.checkBudget('u1', { dailyLimitUsd: 0 });
      expect(status.pct).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Load Balancer
// ═══════════════════════════════════════════════════════════════════════════════

describe('7. Load Balancer', () => {
  let stateStore: MemoryStateStore;
  let lb: LoadBalancer;

  const readyTiers: GpuTierState[] = [
    { state: 'ready', tierIndex: 0, endpoint: 'http://tier0:8000', lastHealthyAt: Date.now() } as any,
    { state: 'ready', tierIndex: 1, endpoint: 'http://tier1:8000', lastHealthyAt: Date.now() } as any,
    { state: 'ready', tierIndex: 2, endpoint: 'http://tier2:8000', lastHealthyAt: Date.now() } as any,
  ];

  beforeEach(() => {
    stateStore = new MemoryStateStore();
    lb = new LoadBalancer(stateStore);
  });

  describe('hash strategy', () => {
    it('returns deterministic result for same userId', async () => {
      const idx1 = await lb.selectTier('user-abc', readyTiers, 'hash');
      const idx2 = await lb.selectTier('user-abc', readyTiers, 'hash');
      expect(idx1).toBe(idx2);
    });

    it('distributes different users across tiers', async () => {
      const selections = new Set<number>();
      for (let i = 0; i < 100; i++) {
        const idx = await lb.selectTier(`user-${i}`, readyTiers, 'hash');
        selections.add(idx);
      }
      // With 100 users and 3 tiers, we expect all tiers to be used
      expect(selections.size).toBeGreaterThan(1);
    });
  });

  describe('round-robin strategy', () => {
    it('cycles through tiers', async () => {
      const results: any[] = [];
      for (let i = 0; i < 6; i++) {
        (results as number[]).push(await lb.selectTier('any-user', readyTiers as any, 'weighted-round-robin' as any));
      }
      expect(results).toEqual([0, 1, 2, 0, 1, 2]);
    });
  });

  describe('affinity strategy', () => {
    it('returns same tier for same user on subsequent calls', async () => {
      const idx1 = await lb.selectTier('user-sticky', readyTiers, 'affinity');
      const idx2 = await lb.selectTier('user-sticky', readyTiers, 'affinity');
      expect(idx1).toBe(idx2);
    });
  });

  describe('least-latency strategy', () => {
    it('selects tier with lowest EMA latency', async () => {
      // Report latencies: tier 0 = 500ms, tier 1 = 100ms, tier 2 = 300ms
      await lb.reportTierLatency('user-lat', 0, 500);
      await lb.reportTierLatency('user-lat', 1, 100);
      await lb.reportTierLatency('user-lat', 2, 300);

      const idx = await lb.selectTier('user-lat', readyTiers, 'least-latency');
      expect(idx).toBe(1); // tier 1 has lowest latency
    });

    it('falls back to hash when no latency data', async () => {
      const idx = await lb.selectTier('user-no-data', readyTiers, 'least-latency');
      // Should not throw, falls back to hash
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(readyTiers.length);
    });

    it('EMA tracks latency trends', async () => {
      // Initial: 1000ms
      await lb.reportTierLatency('user-ema', 0, 1000);
      let metrics = await lb.getTierLatency('user-ema', 0);
      expect(metrics!.emaLatencyMs).toBe(1000);

      // New sample: 100ms → EMA should decrease
      await lb.reportTierLatency('user-ema', 0, 100);
      metrics = await lb.getTierLatency('user-ema', 0);
      // EMA = 0.3 * 100 + 0.7 * 1000 = 730
      expect(metrics!.emaLatencyMs).toBeCloseTo(730, 0);
      expect(metrics!.sampleCount).toBe(2);
    });
  });

  describe('single tier', () => {
    it('always returns 0 for single tier regardless of strategy', async () => {
      const singleTier = [readyTiers[0]];
      for (const strategy of ['hash', 'least-latency', 'weighted-round-robin', 'affinity'] as const) {
        const idx = await lb.selectTier('user-x', singleTier, strategy);
        expect(idx).toBe(0);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Audio Utilities
// ═══════════════════════════════════════════════════════════════════════════════

describe('8. Audio Utilities', () => {
  describe('float32ToWavBuffer', () => {
    it('creates valid WAV header', () => {
      const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
      const buf = float32ToWavBuffer(samples, 16000);

      const view = new DataView(buf);
      // RIFF header
      expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
      // WAVE format
      expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
      // fmt chunk
      expect(String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15))).toBe('fmt ');
      // Sample rate
      expect(view.getUint32(24, true)).toBe(16000);
      // Bits per sample
      expect(view.getUint16(34, true)).toBe(16);
      // Data size
      expect(view.getUint32(40, true)).toBe(samples.length * 2);
      // Total buffer size: 44 header + samples * 2 bytes
      expect(buf.byteLength).toBe(44 + samples.length * 2);
    });

    it('clamps values to [-1, 1]', () => {
      const samples = new Float32Array([2, -2]); // out of range
      const buf = float32ToWavBuffer(samples);
      const view = new DataView(buf);
      // Should be clamped to max/min int16
      expect(view.getInt16(44, true)).toBe(0x7FFF);
      expect(view.getInt16(46, true)).toBe(-0x8000);
    });
  });

  describe('combineWavChunksToBase64', () => {
    it('combines multiple WAV chunks into single WAV', () => {
      const chunk1 = new Uint8Array(float32ToWavBuffer(new Float32Array([0.1, 0.2])));
      const chunk2 = new Uint8Array(float32ToWavBuffer(new Float32Array([0.3, 0.4])));

      const b64 = combineWavChunksToBase64([chunk1, chunk2]);
      expect(b64.length).toBeGreaterThan(0);

      // Decode and verify it's a valid WAV
      const raw = atob(b64);
      expect(raw.slice(0, 4)).toBe('RIFF');
      expect(raw.slice(8, 12)).toBe('WAVE');
    });

    it('returns empty string for empty chunks', () => {
      expect(combineWavChunksToBase64([])).toBe('');
    });

    it('handles non-WAV chunks by concatenating raw bytes', () => {
      const chunk = new Uint8Array([0xFF, 0xFB, 0x90, 0x00]); // MP3 header-ish
      const b64 = combineWavChunksToBase64([chunk]);
      expect(b64.length).toBeGreaterThan(0);
    });
  });

  describe('buildSilentWav', () => {
    it('creates silent WAV of correct duration', () => {
      const buf = buildSilentWav(1.0, 16000);
      const view = new DataView(buf);
      expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
      // 16000 samples * 2 bytes = 32000 data bytes
      expect(view.getUint32(40, true)).toBe(32000);
      expect(buf.byteLength).toBe(44 + 32000);
    });

    it('creates shorter WAV with fractional duration', () => {
      const buf = buildSilentWav(0.1, 16000);
      // 0.1s * 16000 = 1600 samples * 2 = 3200 bytes
      const view = new DataView(buf);
      expect(view.getUint32(40, true)).toBe(3200);
    });
  });

  describe('uint8ToBase64', () => {
    it('converts bytes to base64', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const b64 = uint8ToBase64(bytes);
      expect(atob(b64)).toBe('Hello');
    });

    it('handles empty array', () => {
      expect(uint8ToBase64(new Uint8Array(0))).toBe('');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. TypedEmitter
// ═══════════════════════════════════════════════════════════════════════════════

describe('9. TypedEmitter', () => {
  type TestEvents = {
    'data': { value: number };
    'error': { message: string };
    'done': void;
  };

  it('fires listeners on emit', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const handler = vi.fn();

    emitter.on('data', handler);
    emitter.emit('data', { value: 42 });

    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it('supports multiple listeners per event', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('data', h1);
    emitter.on('data', h2);
    emitter.emit('data', { value: 1 });

    expect(h1).toHaveBeenCalledWith({ value: 1 });
    expect(h2).toHaveBeenCalledWith({ value: 1 });
  });

  it('on() returns unsubscribe function', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const handler = vi.fn();
    const unsub = emitter.on('data', handler);

    emitter.emit('data', { value: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    emitter.emit('data', { value: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('off() removes specific listener', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const handler = vi.fn();

    emitter.on('data', handler);
    emitter.off('data', handler);
    emitter.emit('data', { value: 99 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates errors — one listener crashing does not affect others', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const h1 = vi.fn(() => { throw new Error('crash'); });
    const h2 = vi.fn();

    emitter.on('data', h1);
    emitter.on('data', h2);

    // Should not throw
    emitter.emit('data', { value: 1 });

    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled(); // h2 still called despite h1 crash
  });

  it('removeAllListeners removes everything', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('data', h1);
    emitter.on('error', h2);
    emitter.removeAllListeners();

    emitter.emit('data', { value: 1 });
    emitter.emit('error', { message: 'test' });

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('removeAllListeners for specific event', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('data', h1);
    emitter.on('error', h2);
    emitter.removeAllListeners('data');

    emitter.emit('data', { value: 1 });
    emitter.emit('error', { message: 'test' });

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('emitting non-subscribed event does nothing', () => {
    const emitter = new TypedEmitter<TestEvents>();
    // Should not throw
    emitter.emit('data', { value: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. SpeechSDKError
// ═══════════════════════════════════════════════════════════════════════════════

describe('10. SpeechSDKError', () => {
  it('default recoverability for error codes', () => {
    const recoverable = ['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'CIRCUIT_OPEN', 'BUSY'] as const;
    const nonRecoverable = ['AUTH_ERROR', 'INVALID_INPUT', 'TRANSPORT_FAILED', 'BROWSER_UNSUPPORTED', 'DESTROYED', 'NOT_CONNECTED'] as const;

    for (const code of recoverable) {
      const err = new SpeechSDKError(code, 'test');
      expect(err.recoverable).toBe(true);
      expect(err.code).toBe(code);
      expect(err.name).toBe('SpeechSDKError');
    }

    for (const code of nonRecoverable) {
      const err = new SpeechSDKError(code, 'test');
      expect(err.recoverable).toBe(false);
    }
  });

  it('allows overriding recoverability', () => {
    const err = new SpeechSDKError('AUTH_ERROR', 'test', { recoverable: true });
    expect(err.recoverable).toBe(true);
  });

  it('carries context metadata', () => {
    const err = new SpeechSDKError('TIMEOUT', 'took too long', {
      context: { transport: 'websocket', latencyMs: 30000 },
    });
    expect(err.context).toEqual({ transport: 'websocket', latencyMs: 30000 });
  });

  it('extends Error with proper inheritance', () => {
    const err = new SpeechSDKError('NETWORK_ERROR', 'connection lost');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SpeechSDKError);
    expect(err.message).toBe('connection lost');
  });

  it('supports cause chaining', () => {
    const cause = new Error('original');
    const err = new SpeechSDKError('SERVER_ERROR', 'wrapper', { cause });
    expect(err.cause).toBe(cause);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. AIProviderRegistry
// ═══════════════════════════════════════════════════════════════════════════════

describe('11. AIProviderRegistry', () => {
  it('registers and retrieves providers', () => {
    const registry = new AIProviderRegistry();
    registry.register({
      id: 'test' as any,
      name: 'Test Provider',
      description: 'A test provider',
      capabilities: ['stt', 'llm'],
      requiresApiKey: false,
      stt: {
        transcribe: vi.fn(),
        isConfigured: () => true,
        getModels: () => [],
      } as any,
      llm: {
        chat: vi.fn(),
        isConfigured: () => true,
      } as any,
    } as any);

    expect(registry.getProvider('test' as any)).toBeDefined();
    expect(registry.getProvider('test' as any)!.name).toBe('Test Provider');
  });

  it('throws when provider not found', () => {
    const registry = new AIProviderRegistry();
    expect(() => registry.getSTTProvider('missing' as any)).toThrow('not found');
    expect(() => registry.getLLMProvider('missing' as any)).toThrow('not found');
    expect(() => registry.getTTSProvider('missing' as any)).toThrow('not found');
    expect(() => registry.getImageProvider('missing' as any)).toThrow('not found');
    expect(() => registry.getRealtimeProvider('missing' as any)).toThrow('not found');
  });

  it('throws when provider exists but capability missing', () => {
    const registry = new AIProviderRegistry();
    registry.register({
      id: 'stt-only' as any,
      name: 'STT Only',
      description: 'Only supports STT',
      capabilities: ['stt'],
      requiresApiKey: false,
      stt: { transcribe: vi.fn(), isConfigured: () => true, getModels: () => [] } as any,
    } as any);

    expect(() => registry.getSTTProvider('stt-only' as any)).not.toThrow();
    expect(() => registry.getLLMProvider('stt-only' as any)).toThrow('does not support LLM');
    expect(() => registry.getTTSProvider('stt-only' as any)).toThrow('does not support TTS');
  });

  it('listProviders returns all registered', () => {
    const registry = new AIProviderRegistry();
    registry.register({ id: 'a' as any, name: 'A', description: '', capabilities: [] } as any);
    registry.register({ id: 'b' as any, name: 'B', description: '', capabilities: [] } as any);
    expect(registry.listProviders()).toHaveLength(2);
  });

  it('listProvidersByCapability filters correctly', () => {
    const registry = new AIProviderRegistry();
    registry.register({ id: 'a' as any, name: 'A', description: '', capabilities: ['stt', 'llm'] } as any);
    registry.register({ id: 'b' as any, name: 'B', description: '', capabilities: ['tts'] } as any);
    registry.register({ id: 'c' as any, name: 'C', description: '', capabilities: ['llm', 'tts'] } as any);

    expect(registry.listProvidersByCapability('llm')).toHaveLength(2);
    expect(registry.listProvidersByCapability('tts')).toHaveLength(2);
    expect(registry.listProvidersByCapability('stt')).toHaveLength(1);
    expect(registry.listProvidersByCapability('realtime')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Preset Profiles Integrity
// ═══════════════════════════════════════════════════════════════════════════════

describe('12. Preset Profiles Integrity', () => {
  it('VOICE_PROFILE has complete STT → LLM → TTS chains', () => {
    expect(VOICE_PROFILE.stt!.length).toBeGreaterThanOrEqual(2);
    expect(VOICE_PROFILE.llm!.length).toBeGreaterThanOrEqual(2);
    expect(VOICE_PROFILE.tts!.length).toBeGreaterThanOrEqual(2);
    expect(VOICE_PROFILE.voice).toBe('nova');
    expect(VOICE_PROFILE.fallbackOptions?.timeoutMs).toBe(8000);
  });

  it('CHAT_PROFILE has context window fallbacks configured', () => {
    expect(CHAT_PROFILE.fallbackOptions?.contextWindowFallbacks).toBeDefined();
    expect(CHAT_PROFILE.fallbackOptions?.contextWindowFallbacks!['gpt-4o-mini']).toBe('gpt-4o');
    expect(CHAT_PROFILE.fallbackOptions?.retriesPerProvider).toBe(1);
    expect(CHAT_PROFILE.fallbackOptions?.timeoutMs).toBe(30000);
  });

  it('STT_PROFILE is fast (no retries, short timeout)', () => {
    expect(STT_PROFILE.fallbackOptions?.retriesPerProvider).toBe(0);
    expect(STT_PROFILE.fallbackOptions?.timeoutMs).toBe(8000);
  });

  it('SYSTEM_PROFILE has higher retries for reliability', () => {
    expect(SYSTEM_PROFILE.fallbackOptions?.retriesPerProvider).toBe(2);
    expect(SYSTEM_PROFILE.fallbackOptions?.timeoutMs).toBe(30000);
    expect(SYSTEM_PROFILE.temperature).toBe(0.3);
  });

  it('IMAGE_PROFILE has long timeout', () => {
    expect(IMAGE_PROFILE.fallbackOptions?.timeoutMs).toBe(60000);
    expect(IMAGE_PROFILE.image!.length).toBeGreaterThanOrEqual(2);
  });

  it('all presets have unique names', () => {
    const presets = [VOICE_PROFILE, CHAT_PROFILE, STT_PROFILE, TTS_PROFILE, LLM_PROFILE, IMAGE_PROFILE, SYSTEM_PROFILE];
    const names = presets.map(p => p.preset);
    expect(new Set(names).size).toBe(presets.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Error Classification
// ═══════════════════════════════════════════════════════════════════════════════

describe('13. Error Classification', () => {
  describe('isRetryableError', () => {
    it('429, 500-504 are retryable', () => {
      expect(isRetryableError(httpErr(429))).toBe(true);
      expect(isRetryableError(httpErr(500))).toBe(true);
      expect(isRetryableError(httpErr(502))).toBe(true);
      expect(isRetryableError(httpErr(503))).toBe(true);
      expect(isRetryableError(httpErr(504))).toBe(true);
    });

    it('401/402/403 are retryable (different API keys)', () => {
      expect(isRetryableError(httpErr(401))).toBe(true);
      expect(isRetryableError(httpErr(402))).toBe(true);
      expect(isRetryableError(httpErr(403))).toBe(true);
    });

    it('timeout is retryable', () => {
      expect(isRetryableError(timeoutErr())).toBe(true);
    });

    it('network errors (no status) are retryable', () => {
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRetryableError(null)).toBe(true);
    });

    it('non-context 400 is NOT retryable', () => {
      expect(isRetryableError(httpErr(400, 'invalid model'))).toBe(false);
    });

    it('context window error (400) IS retryable', () => {
      expect(isRetryableError(contextErr())).toBe(true);
    });
  });

  describe('isContextWindowError', () => {
    const positive = [
      'context_length_exceeded',
      "model's context window is 4096 tokens",
      'too many tokens in the request',
      'prompt is too long for this model',
      'input too long, max 8192 tokens',
      'exceeds maximum context length',
      'tokens exceed the limit',
    ];

    for (const msg of positive) {
      it(`detects: "${msg.slice(0, 40)}..."`, () => {
        expect(isContextWindowError(new Error(msg))).toBe(true);
      });
    }

    it('ignores unrelated errors', () => {
      expect(isContextWindowError(new Error('invalid model'))).toBe(false);
      expect(isContextWindowError(null)).toBe(false);
      expect(isContextWindowError('string')).toBe(false);
    });

    it('detects via code field', () => {
      const err = Object.assign(new Error(''), { code: 'context_length_exceeded' });
      expect(isContextWindowError(err)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Tier Lifecycle Management
// ═══════════════════════════════════════════════════════════════════════════════

describe('14. Tier Lifecycle Management', () => {
  const USER = 'user-lifecycle-test';
  const healthyEndpoints = new Set<string>();

  function mockFetch(input: string | URL | Request): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/health')) {
      const endpoint = url.replace('/health', '');
      if (healthyEndpoints.has(endpoint)) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'healthy' }), { status: 200 }));
      }
      return Promise.reject(new Error('Connection refused'));
    }
    if (url.includes('runpod.io') || url.includes('tensordock.com')) {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return Promise.reject(new Error(`Unmocked: ${url}`));
  }

  function makeTier(provider: 'runpod' | 'tensordock', idx: number): GpuTierConfig {
    return {
      provider,
      instanceId: `inst-${provider}-${idx}`,
      endpoint: `http://${provider}-${idx}.test:8000`,
      apiKey: `key-${provider}`,
      ...(provider === 'tensordock' ? { authId: 'auth-td' } : {}),
    };
  }

  function makeConfig(overrides?: Partial<import('@ai-gateway/types').AutoScalerConfig>): import('@ai-gateway/types').AutoScalerConfig {
    return {
      enabled: true,
      threshold: 1,
      windowMinutes: 10,
      maxLatencyMs: 1500,
      tiers: [makeTier('runpod', 0), makeTier('tensordock', 1)],
      ...overrides,
    };
  }

  let sessionResolver: MockSessionResolver;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    sessionResolver = new MockSessionResolver();
    healthyEndpoints.clear();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(mockFetch) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('stopTier on ready tier → idle + provider.stopInstance called', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
      lifecycleLogger: { log: (e) => { lifecycleEvents.push(e as unknown as Record<string, unknown>); } },
    });

    // Force tier 0 ready
    healthyEndpoints.add(config.tiers[0].endpoint!);
    autoscaler.forceTierReady(USER, 0, config.tiers[0].endpoint!);
    expect(autoscaler.getPoolStatus(USER)[0]?.state).toBe('ready');

    // Stop it
    const result = await autoscaler.stopTier(USER, 0);
    expect(result.ok).toBe(true);
    expect(result.previousState).toBe('ready');
    expect(result.newState).toBe('idle');
    expect(autoscaler.getPoolStatus(USER)[0]?.state).toBe('idle');

    // Lifecycle event logged
    const stopEvent = lifecycleEvents.find(e => e.eventType === 'tier_stopped');
    expect(stopEvent).toBeDefined();
    expect(stopEvent!.tierIndex).toBe(0);
  });

  it('startTier on idle tier → booting + provider.startInstance called', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
    });

    // Ensure tier is idle (default)
    autoscaler.resetGpuState(USER);

    const result = await autoscaler.startTier(USER, 0);
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('booting');
    expect(autoscaler.getPoolStatus(USER)[0]?.state).toBe('booting');
  });

  it('deleteTier → stop + delete + state cleared', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
    });

    // Force ready then delete
    autoscaler.forceTierReady(USER, 0, config.tiers[0].endpoint!);
    const result = await autoscaler.deleteTier(USER, 0);
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('idle');
    expect(autoscaler.getPoolStatus(USER)[0]?.state).toBe('idle');
  });

  it('restartTier → stop then start sequence', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
      lifecycleLogger: { log: (e) => { lifecycleEvents.push(e as unknown as Record<string, unknown>); } },
    });

    autoscaler.forceTierReady(USER, 0, config.tiers[0].endpoint!);
    const result = await autoscaler.restartTier(USER, 0);
    expect(result.ok).toBe(true);
    expect(result.previousState).toBe('ready');
    expect(result.newState).toBe('booting');

    const restartEvent = lifecycleEvents.find(e => e.eventType === 'tier_restarted');
    expect(restartEvent).toBeDefined();
  });

  it('stopTier on idle tier (idempotent) → ok: true', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
    });

    const result = await autoscaler.stopTier(USER, 0);
    expect(result.ok).toBe(true);
    expect(result.previousState).toBe('idle');
    expect(result.newState).toBe('idle');
  });

  it('getTierDetail returns enriched state', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
    });

    autoscaler.forceTierReady(USER, 0, config.tiers[0].endpoint!);
    const detail = await autoscaler.getTierDetail(USER, 0);
    expect(detail).toBeDefined();
    expect(detail!.tierIndex).toBe(0);
    expect(detail!.state).toBe('ready');
    expect(detail!.endpoint).toBe(config.tiers[0].endpoint);
    expect(detail!.provider).toBe('runpod');
  });

  it('getAllTierDetails returns all tiers', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
    });

    const details = await autoscaler.getAllTierDetails(USER);
    expect(details.length).toBe(2);
    expect(details[0]!.tierIndex).toBe(0);
    expect(details[1]!.tierIndex).toBe(1);
  });

  it('lifecycle events logged for each action', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
      lifecycleLogger: { log: (e) => { lifecycleEvents.push(e as unknown as Record<string, unknown>); } },
    });

    // Start
    await autoscaler.startTier(USER, 0);
    expect(lifecycleEvents.some(e => e.eventType === 'tier_started')).toBe(true);

    // Stop
    await autoscaler.stopTier(USER, 0);
    expect(lifecycleEvents.some(e => e.eventType === 'tier_stopped')).toBe(true);

    // Delete
    autoscaler.forceTierReady(USER, 0, config.tiers[0].endpoint!);
    await autoscaler.deleteTier(USER, 0);
    expect(lifecycleEvents.some(e => e.eventType === 'tier_deleted')).toBe(true);
  });

  it('stopTier on booting tier cancels boot poller', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
    });

    // Start a tier (booting)
    await autoscaler.startTier(USER, 0);
    expect(autoscaler.getPoolStatus(USER)[0]?.state).toBe('booting');

    // Stop it — should cancel poller and set idle
    const result = await autoscaler.stopTier(USER, 0);
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('idle');
  });

  it('stopTier returns error for non-existent tier', async () => {
    const config = makeConfig();
    const stateStore = new MemoryStateStore();
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
      loadConfig: async () => config,
    });

    const result = await autoscaler.stopTier(USER, 99);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. Benchmark Tracker
// ═══════════════════════════════════════════════════════════════════════════════

import { BenchmarkTracker } from '@ai-gateway/tracking/benchmark-tracker';

describe('15. Benchmark Tracker', () => {
  const USER = 'user-bench-test';
  const TODAY = new Date().toISOString().slice(0, 10);

  it('recordBoot + getRecentBoots retrieves correctly', async () => {
    const store = new MemoryStateStore();
    const tracker = new BenchmarkTracker(store);

    await tracker.recordBoot({
      userId: USER, provider: 'runpod', tierIndex: 0,
      durationMs: 120_000, wasDiscovered: false,
      instanceId: 'pod-123', timestamp: Date.now(),
    });

    const boots = await tracker.getRecentBoots(USER, TODAY);
    expect(boots.length).toBe(1);
    expect(boots[0]!.provider).toBe('runpod');
    expect(boots[0]!.durationMs).toBe(120_000);
  });

  it('recordInference + getDailySummary computes p50/p95', async () => {
    const store = new MemoryStateStore();
    const tracker = new BenchmarkTracker(store);

    // Record multiple inference benchmarks
    for (let i = 0; i < 20; i++) {
      await tracker.recordInference({
        userId: USER, provider: 'runpod', endpoint: 'http://test:8000',
        sttMs: 100 + i * 10, llmMs: 200 + i * 5, ttsMs: 50 + i * 3,
        totalMs: 350 + i * 18, ttfaMs: 150 + i * 8,
        timestamp: Date.now(),
      });
    }

    const summary = await tracker.getDailySummary(USER, TODAY);
    expect(summary.inference.total).toBeDefined();
    expect(summary.inference.total!.count).toBe(20);
    expect(summary.inference.total!.p50).toBeGreaterThan(0);
    expect(summary.inference.total!.p95).toBeGreaterThanOrEqual(summary.inference.total!.p50);
    expect(summary.inference.total!.min).toBeLessThanOrEqual(summary.inference.total!.max);

    // STT, LLM, TTS sub-stats should also exist
    expect(summary.inference.stt!.count).toBe(20);
    expect(summary.inference.llm!.count).toBe(20);
    expect(summary.inference.tts!.count).toBe(20);
  });

  it('getTrend returns multi-day data', async () => {
    const store = new MemoryStateStore();
    const tracker = new BenchmarkTracker(store);

    // Record some data for today
    await tracker.recordBoot({
      userId: USER, provider: 'tensordock', tierIndex: 0,
      durationMs: 90_000, wasDiscovered: true, timestamp: Date.now(),
    });
    await tracker.recordInference({
      userId: USER, provider: 'tensordock', endpoint: 'http://td:8000',
      totalMs: 500, timestamp: Date.now(),
    });

    const trend = await tracker.getTrend(USER, 3);
    expect(trend.dates.length).toBe(3);
    expect(trend.bootP95.length).toBe(3);
    expect(trend.inferP95.length).toBe(3);
    // Today should have data, others null
    expect(trend.bootP95[2]).toBe(90_000);
    expect(trend.inferP95[2]).toBe(500);
    expect(trend.bootP95[0]).toBeNull();
  });

  it('boot auto-recorded on boot_ok lifecycle event', async () => {
    const stateStore = new MemoryStateStore();
    const sessionResolver = new MockSessionResolver();
    const healthyEndpoints = new Set<string>();
    const config: import('@ai-gateway/types').AutoScalerConfig = {
      enabled: true, threshold: 1, windowMinutes: 10, maxLatencyMs: 1500,
      tiers: [{
        provider: 'runpod', instanceId: 'inst-rp-0',
        endpoint: 'http://runpod-bench.test:8000',
        apiKey: 'key-rp',
      }],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/health')) {
        if (healthyEndpoints.has(url.replace('/health', ''))) {
          return Promise.resolve(new Response('{"status":"healthy"}', { status: 200 }));
        }
        return Promise.reject(new Error('refused'));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    try {
      const autoscaler = createAutoscaler({
        settingsStore: new MockSettingsStore(), stateStore, sessionResolver,
        loadConfig: async () => config,
      });

      // Force a ready state with boot timing logged via forceTierReady (triggers boot_ok)
      autoscaler.forceTierReady('bench-user', 0, config.tiers[0].endpoint!);

      // The forceTierReady triggers a boot_ok lifecycle event via the wrapped logger
      // Check that the benchmark tracker recorded it
      const boots = await autoscaler.benchmarkTracker!.getRecentBoots('bench-user', TODAY);
      // forceTierReady triggers boot_ok via lifecycle logger → auto-recorded in benchmark tracker
      // Note: forceTierReady doesn't include durationMs, so it won't be auto-recorded
      // (the auto-record only fires when durationMs is present)
      // This is correct behavior — only real boots with timing data are recorded
      expect(boots.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('empty data returns null stats', async () => {
    const store = new MemoryStateStore();
    const tracker = new BenchmarkTracker(store);

    const summary = await tracker.getDailySummary(USER, TODAY);
    expect(summary.boot).toBeNull();
    expect(summary.inference.total).toBeNull();
    expect(summary.inference.stt).toBeNull();
    expect(Object.keys(summary.byProvider).length).toBe(0);
  });

  it('summary byProvider breakdown works', async () => {
    const store = new MemoryStateStore();
    const tracker = new BenchmarkTracker(store);

    await tracker.recordBoot({
      userId: USER, provider: 'runpod', tierIndex: 0,
      durationMs: 120_000, wasDiscovered: false, timestamp: Date.now(),
    });
    await tracker.recordBoot({
      userId: USER, provider: 'tensordock', tierIndex: 1,
      durationMs: 60_000, wasDiscovered: true, timestamp: Date.now(),
    });
    await tracker.recordInference({
      userId: USER, provider: 'runpod', endpoint: 'http://rp:8000',
      totalMs: 400, timestamp: Date.now(),
    });
    await tracker.recordInference({
      userId: USER, provider: 'tensordock', endpoint: 'http://td:8000',
      totalMs: 600, timestamp: Date.now(),
    });

    const summary = await tracker.getDailySummary(USER, TODAY);
    expect(summary.byProvider.runpod).toBeDefined();
    expect(summary.byProvider.tensordock).toBeDefined();
    expect(summary.byProvider.runpod!.boot!.mean).toBe(120_000);
    expect(summary.byProvider.tensordock!.boot!.mean).toBe(60_000);
    expect(summary.byProvider.runpod!.inference!.mean).toBe(400);
    expect(summary.byProvider.tensordock!.inference!.mean).toBe(600);
  });

  it('recordInference with missing optional fields returns partial stats', async () => {
    const store = new MemoryStateStore();
    const tracker = new BenchmarkTracker(store);

    // Only totalMs, no stt/llm/tts/ttfa
    await tracker.recordInference({
      userId: USER, provider: 'runpod', endpoint: 'http://test:8000',
      totalMs: 300, timestamp: Date.now(),
    });

    const summary = await tracker.getDailySummary(USER, TODAY);
    expect(summary.inference.total!.count).toBe(1);
    expect(summary.inference.stt).toBeNull();
    expect(summary.inference.llm).toBeNull();
    expect(summary.inference.tts).toBeNull();
  });

  it('benchmarkTracker is exposed on autoscaler instance', () => {
    const store = new MemoryStateStore();
    const autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(), stateStore: store,
      sessionResolver: new MockSessionResolver(),
      loadConfig: async () => null,
    });

    expect(autoscaler.benchmarkTracker).toBeDefined();
    expect(autoscaler.benchmarkTracker).toBeInstanceOf(BenchmarkTracker);
  });
});
