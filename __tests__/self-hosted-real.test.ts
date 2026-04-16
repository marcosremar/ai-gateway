/**
 * Self-hosted warmup & alwaysActive — Real Integration Tests
 *
 * Tests the self-hosted provider lifecycle against a real Ollama instance:
 *   1. warmup() health-checks Ollama at localhost:11434
 *   2. alwaysActive providers stay warm and respond
 *   3. replicas expand the fallback chain (2x Ollama entries)
 *   4. chat() works through a self-hosted alwaysActive provider
 *   5. Fallback: self-hosted → cloud (if self-hosted is down)
 *   6. Cloud providers ignore selfHosted flags (replicas, alwaysActive)
 *
 * Requires: Ollama running on localhost:11434 with llama3.2 pulled
 *
 * Run: bunx vitest run __tests__/self-hosted-real.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AIClient } from '@ai-gateway/client/ai-client';
import { AIProviderRegistry } from '@ai-gateway/providers/registry';
import { OllamaLLMProvider } from '@ai-gateway/providers/ollama';
import type { LLMProvider, ChatRequest, ChatResponse } from '@ai-gateway/providers/types';

// ── Detect Ollama (top-level await — resolved before describe.skipIf) ───────

let ollamaAvailable = false;
let ollamaModel = 'llama3.2';
try {
  const res = await fetch('http://localhost:11434/api/tags', {
    signal: AbortSignal.timeout(3_000),
  });
  if (res.ok) {
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    // Prefer exact 'llama3.2', fall back to any llama3.2 variant (e.g. llama3.2:1b)
    const exact = data.models?.find((m) => m.name === 'llama3.2' || m.name === 'llama3.2:latest');
    const variant = data.models?.find((m) => m.name.startsWith('llama3.2'));
    const match = exact || variant;
    if (match) {
      ollamaAvailable = true;
      ollamaModel = match.name;
    }
  }
} catch {
  // Ollama not running
}

if (!ollamaAvailable) {
  console.log('  [skip] Ollama not available or llama3.2 not pulled');
}

// ── Fake cloud provider (deterministic, no API key needed) ──────────────────

class FakeCloudLLM implements LLMProvider {
  readonly providerId = 'fake-cloud';
  calls = 0;

  isConfigured() { return true; }
  withApiKey() { return this; }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    return { content: `[cloud fallback] echo: ${request.messages.at(-1)?.content}`, model: 'fake-cloud-v1' };
  }
}

// ── Broken self-hosted provider (simulates a down instance) ─────────────────

class BrokenLLM implements LLMProvider {
  readonly providerId = 'broken-local';
  calls = 0;

  isConfigured() { return true; }
  withApiKey() { return this; }

  async chat(): Promise<ChatResponse> {
    this.calls++;
    throw Object.assign(new Error('ECONNREFUSED'), { status: 503 });
  }
}

// ── Registry builder ────────────────────────────────────────────────────────

function buildRegistry() {
  const registry = new AIProviderRegistry();
  const ollamaLlm = new OllamaLLMProvider();
  const fakeCloud = new FakeCloudLLM();
  const brokenLlm = new BrokenLLM();

  registry.register({
    id: 'ollama',
    name: 'Ollama',
    description: 'Local Ollama (self-hosted)',
    capabilities: ['llm'],
    requiresApiKey: false,
    llm: ollamaLlm,
  });

  registry.register({
    id: 'fake-cloud' as any,
    name: 'Fake Cloud',
    description: 'Fake cloud LLM for testing',
    capabilities: ['llm'],
    requiresApiKey: false,
    llm: fakeCloud,
  });

  registry.register({
    id: 'broken-local' as any,
    name: 'Broken Local',
    description: 'Broken self-hosted LLM',
    capabilities: ['llm'],
    requiresApiKey: false,
    llm: brokenLlm,
  });

  return { registry, fakeCloud, brokenLlm };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!ollamaAvailable)('Self-hosted warmup — Real Ollama', () => {

  // ── 1. warmup() health-checks Ollama ──────────────────────────────────────

  it('warmup() reports ok for Ollama on localhost:11434', async () => {
    const { registry } = buildRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: ollamaModel,
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
          },
        ],
      },
    });

    const result = await client.warmup();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('ok');
    expect(result.entries[0].provider).toBe('ollama');
    expect(result.entries[0].latencyMs).toBeGreaterThan(0);
    expect(result.entries[0].latencyMs).toBeLessThan(5_000);

    console.log(`  WARMUP: ${result.entries[0].status} (${result.entries[0].latencyMs}ms)`);
  }, 10_000);

  // ── 2. warmup() with replicas checks Ollama N times ───────────────────────

  it('warmup() health-checks each replica independently', async () => {
    const { registry } = buildRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: ollamaModel,
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
            replicas: 3,
          },
        ],
      },
    });

    const result = await client.warmup();

    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((e) => e.status === 'ok')).toBe(true);
    expect(result.entries.every((e) => e.provider === 'ollama')).toBe(true);

    console.log(`  WARMUP 3 replicas: all ok`);
    for (const e of result.entries) {
      console.log(`    ${e.id}: ${e.latencyMs}ms`);
    }
  }, 15_000);

  // ── 3. warmup() skips cloud, only warms self-hosted ───────────────────────

  it('warmup() skips cloud providers in mixed profile', async () => {
    const { registry } = buildRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: ollamaModel,
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
          },
          { provider: 'fake-cloud', model: 'fake-cloud-v1' },
        ],
      },
    });

    const result = await client.warmup();

    // Only Ollama should be warmed — fake-cloud is not selfHosted
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].provider).toBe('ollama');

    console.log(`  WARMUP mixed: only self-hosted warmed (${result.entries.length} entry)`);
  }, 10_000);

  // ── 4. warmup() reports error for unreachable self-hosted endpoint ────────

  it('warmup() reports error for unreachable endpoint', async () => {
    const { registry } = buildRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'broken-local',
            model: 'broken',
            selfHosted: true,
            endpoint: 'http://localhost:59999',
            alwaysActive: true,
          },
        ],
      },
    });

    const result = await client.warmup();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('error');
    expect(result.entries[0].error).toContain('not reachable');

    console.log(`  WARMUP unreachable: ${result.entries[0].error} (${result.entries[0].latencyMs}ms)`);
  }, 15_000);

  // ── 5. chat() through real Ollama (alwaysActive self-hosted) ──────────────

  it('chat() completes through real Ollama', async () => {
    const { registry } = buildRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: ollamaModel,
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
          },
        ],
      },
    });

    const result = await client.chat([
      { role: 'user', content: 'Responda apenas "ok", nada mais.' },
    ]);

    expect(result.content).toBeTruthy();
    expect(result.provider).toBe('ollama');
    expect(result.model).toContain('llama3.2'); // matches llama3.2, llama3.2:1b, etc.
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.fallbackUsed).toBe(false);

    console.log(`  CHAT (Ollama): "${result.content.substring(0, 80)}" — ${result.latencyMs}ms`);
  }, 30_000);

  // ── 6. Fallback: broken self-hosted → cloud ──────────────────────────────

  it('chat() falls back from broken self-hosted to cloud', async () => {
    const { registry, fakeCloud } = buildRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'broken-local',
            model: 'broken',
            selfHosted: true,
            endpoint: 'http://localhost:59999',
            alwaysActive: true,
          },
          { provider: 'fake-cloud', model: 'fake-cloud-v1' },
        ],
      },
    });

    const result = await client.chat([
      { role: 'user', content: 'teste de fallback' },
    ]);

    expect(result.content).toContain('[cloud fallback]');
    expect(result.provider).toBe('fake-cloud');
    expect(result.fallbackUsed).toBe(true);
    expect(fakeCloud.calls).toBe(1);

    console.log(`  FALLBACK: broken self-hosted → cloud: "${result.content.substring(0, 60)}"`);
  }, 15_000);

  // ── 7. Replicas in fallback chain: 2x Ollama + cloud ─────────────────────

  it('replicas expand self-hosted entries in fallback chain', async () => {
    const { registry, fakeCloud } = buildRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: ollamaModel,
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
            replicas: 2,
          },
          { provider: 'fake-cloud', model: 'fake-cloud-v1' },
        ],
      },
    });

    // Should succeed on first Ollama replica, never touching cloud
    const result = await client.chat([
      { role: 'user', content: 'Diga apenas "sim".' },
    ]);

    expect(result.provider).toBe('ollama');
    expect(result.fallbackUsed).toBe(false);
    expect(fakeCloud.calls).toBe(0);

    console.log(`  REPLICAS: chat via first replica, cloud untouched: "${result.content.substring(0, 60)}"`);
  }, 30_000);

  // ── 8. Cloud provider ignores replicas ────────────────────────────────────

  it('cloud provider ignores replicas (no expansion)', async () => {
    const { registry, fakeCloud } = buildRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          { provider: 'fake-cloud', model: 'fake-cloud-v1', replicas: 5 },
        ],
      },
    });

    const result = await client.chat([
      { role: 'user', content: 'test' },
    ]);

    // Cloud should not expand replicas — only 1 call
    expect(result.provider).toBe('fake-cloud');
    expect(result.fallbackUsed).toBe(false);
    expect(fakeCloud.calls).toBe(1);

    console.log(`  CLOUD ignores replicas: 1 call, provider=${result.provider}`);
  }, 10_000);

  // ── 9. Full warmup + chat cycle ──────────────────────────────────────────

  it('warmup then chat — full self-hosted lifecycle', async () => {
    const { registry } = buildRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: ollamaModel,
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
            replicas: 2,
          },
          { provider: 'fake-cloud', model: 'fake-cloud-v1' },
        ],
      },
    });

    // Step 1: warmup
    const warmup = await client.warmup();
    expect(warmup.entries).toHaveLength(2); // 2 replicas
    expect(warmup.entries.every((e) => e.status === 'ok')).toBe(true);

    // Step 2: chat through the warm self-hosted provider
    const result = await client.chat([
      { role: 'system', content: 'Você é um assistente. Responda em uma frase curta.' },
      { role: 'user', content: 'Qual é a capital da França?' },
    ]);

    expect(result.content).toBeTruthy();
    expect(result.provider).toBe('ollama');
    expect(result.latencyMs).toBeGreaterThan(0);

    console.log(`  LIFECYCLE: warmup ok → chat "${result.content.substring(0, 80)}" (${result.latencyMs}ms)`);
  }, 45_000);
});
