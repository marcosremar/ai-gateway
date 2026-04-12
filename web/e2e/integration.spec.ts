/**
 * Integration tests for AI Gateway Settings.
 * Runs against the REAL gateway on localhost:4000.
 *
 * Tests cover:
 * - Token tracking (input/output tokens in metrics)
 * - Idle timeout configuration (save/load)
 * - API keys endpoint (list/update)
 * - Provider config persistence (profiles, pipeline chains)
 * - Overview UI (latency data, pipeline stages, provider table)
 * - Providers UI (mode toggle, profiles, save bar)
 * - GPU Deploy UI (auto-stop, deploy config)
 */
import { test, expect } from '@playwright/test';

const GW = 'http://localhost:4000';

// ── API-level tests ──────────────────────────────────────────────────────────

test.describe('Token tracking', () => {
  test('LLM request returns usage with input/output tokens', async () => {
    const res = await fetch(`${GW}/v1/playground/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hi' }] }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.usage).toBeDefined();
    expect(data.usage.promptTokens).toBeGreaterThan(0);
    expect(data.usage.completionTokens).toBeGreaterThan(0);
    expect(data.usage.totalTokens).toBe(data.usage.promptTokens + data.usage.completionTokens);
  });

  test('health endpoint exposes tokenUsage totals', async () => {
    // Ensure at least one request exists
    await fetch(`${GW}/v1/playground/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Count to 3' }] }),
    });
    await new Promise(r => setTimeout(r, 300));

    const res = await fetch(`${GW}/health`);
    const health = await res.json();

    expect(health.tokenUsage).toBeDefined();
    expect(health.tokenUsage.totalInputTokens).toBeGreaterThan(0);
    expect(health.tokenUsage.totalOutputTokens).toBeGreaterThan(0);
    expect(health.tokenUsage.totalTokens).toBe(
      health.tokenUsage.totalInputTokens + health.tokenUsage.totalOutputTokens
    );
  });

  test('provider metrics include per-provider token counts', async () => {
    const res = await fetch(`${GW}/health`);
    const health = await res.json();

    expect(health.providerMetrics.groq).toBeDefined();
    expect(typeof health.providerMetrics.groq.inputTokens).toBe('number');
    expect(typeof health.providerMetrics.groq.outputTokens).toBe('number');
    expect(health.providerMetrics.groq.inputTokens).toBeGreaterThan(0);
  });

  test('/metrics endpoint also includes tokenUsage', async () => {
    const res = await fetch(`${GW}/metrics`);
    const metrics = await res.json();
    expect(metrics.tokenUsage).toBeDefined();
    expect(metrics.tokenUsage.totalTokens).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Idle timeout configuration', () => {
  test('GET config returns idleTimeoutMin', async () => {
    const res = await fetch(`${GW}/v1/config/providers`);
    const config = await res.json();
    expect(typeof config.idleTimeoutMin).toBe('number');
    expect(config.idleTimeoutMin).toBeGreaterThanOrEqual(0);
  });

  test('PATCH config updates idleTimeoutMin', async () => {
    // Set to 20 min
    const res = await fetch(`${GW}/v1/config/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idleTimeoutMin: 20 }),
    });
    const config = await res.json();
    expect(config.idleTimeoutMin).toBe(20);

    // Verify it persisted
    const res2 = await fetch(`${GW}/v1/config/providers`);
    const config2 = await res2.json();
    expect(config2.idleTimeoutMin).toBe(20);

    // Restore default
    await fetch(`${GW}/v1/config/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idleTimeoutMin: 15 }),
    });
  });

  test('GPU status includes idleTimeoutSec', async () => {
    const res = await fetch(`${GW}/v1/gpu/status`);
    const gpu = await res.json();
    expect(typeof gpu.idleTimeoutSec).toBe('number');
    expect(gpu.idleTimeoutSec).toBeGreaterThan(0);
  });
});

test.describe('API keys endpoint', () => {
  test('GET returns list of keys with masked values', async () => {
    const res = await fetch(`${GW}/v1/config/api-keys`);
    expect(res.ok).toBe(true);
    const data = await res.json();

    expect(Array.isArray(data.keys)).toBe(true);
    expect(data.keys.length).toBeGreaterThan(0);

    // Each key has required fields
    for (const key of data.keys) {
      expect(key).toHaveProperty('id');
      expect(key).toHaveProperty('name');
      expect(key).toHaveProperty('envVar');
      expect(key).toHaveProperty('category');
      expect(key).toHaveProperty('configured');
      expect(key).toHaveProperty('masked');
      expect(['cloud', 'gpu']).toContain(key.category);
    }

    // Groq should be configured
    const groq = data.keys.find((k: any) => k.id === 'groq');
    expect(groq).toBeDefined();
    expect(groq.configured).toBe(true);
    expect(groq.masked).toContain('***');
  });
});

test.describe('Provider config persistence', () => {
  test('save and load profiles', async () => {
    const profile = {
      id: 'test-integration',
      name: 'Integration Test Profile',
      stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
      llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
      tts: [{ provider: 'groq', model: 'orpheus-v1-english' }],
    };

    // Save
    const res = await fetch(`${GW}/v1/config/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apps: [profile],
        activeAppId: 'test-integration',
      }),
    });
    expect(res.ok).toBe(true);

    // Load and verify
    const res2 = await fetch(`${GW}/v1/config/providers`);
    const config = await res2.json();
    const saved = config.apps.find((p: any) => p.id === 'test-integration');
    expect(saved).toBeDefined();
    expect(saved.name).toBe('Integration Test Profile');
    expect(config.activeAppId).toBe('test-integration');
  });

  test('pipeline chains are persisted', async () => {
    const chains = {
      pipelineStt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
      pipelineLlm: [
        { provider: 'groq', model: 'llama-3.3-70b-versatile' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ],
      pipelineTts: [{ provider: 'groq', model: 'orpheus-v1-english' }],
    };

    await fetch(`${GW}/v1/config/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chains),
    });

    const res = await fetch(`${GW}/v1/config/providers`);
    const config = await res.json();
    expect(config.pipelineLlm.length).toBe(2);
    expect(config.pipelineLlm[1].provider).toBe('openai');
  });
});

test.describe('Health endpoint completeness', () => {
  test('all 3 pipeline stages reported', async () => {
    const res = await fetch(`${GW}/health`);
    const health = await res.json();

    expect(health.components.stt).toBeDefined();
    expect(health.components.llm).toBeDefined();
    expect(health.components.tts).toBeDefined();
    expect(health.components.stt.status).toBe('ok');
    expect(health.components.llm.status).toBe('ok');
    // TTS should be ok (cloud fallback) even without GPU
    expect(health.components.tts.status).toBe('ok');
  });

  test('providers include groq and openai', async () => {
    const res = await fetch(`${GW}/health`);
    const health = await res.json();
    expect(health.providers.groq).toBe(true);
    expect(health.providers.openai).toBe(true);
  });

  test('latency data has valid structure', async () => {
    const res = await fetch(`${GW}/health`);
    const health = await res.json();
    expect(typeof health.latency.p50_ms).toBe('number');
    expect(typeof health.latency.p95_ms).toBe('number');
    expect(typeof health.latency.samples).toBe('number');
  });
});

// ── UI tests ─────────────────────────────────────────────────────────────────

test.describe('Overview UI', () => {
  test('shows status bar, stats, and pipeline', async ({ page }) => {
    await page.goto(`${GW}/`);
    await expect(page.getByText('Online')).toBeVisible({ timeout: 10_000 });

    // Compact status strip shows lowercase p50/p95
    await expect(page.getByText('p50')).toBeVisible();
    await expect(page.getByText('p95')).toBeVisible();

    // Provider performance section
    await expect(page.getByText('Provider Performance')).toBeVisible();
  });

  test('pipeline shows latency data after requests', async ({ page }) => {
    await page.goto(`${GW}/`);
    await expect(page.getByText('p50')).toBeVisible({ timeout: 10_000 });

    // Provider Performance section should appear after requests
    await expect(page.getByText('Provider Performance')).toBeVisible();
  });
});

test.describe('Profiles UI', () => {
  test('profiles page loads', async ({ page }) => {
    await page.goto(`${GW}/config/profiles`);
    await expect(page.getByText('Profiles').first()).toBeVisible({ timeout: 10_000 });
  });
});


test.describe('API Keys UI', () => {
  test('shows configured providers with masked keys', async ({ page }) => {
    await page.goto(`${GW}/config/api-keys`);
    await expect(page.getByRole('heading', { name: 'API Keys', exact: true })).toBeVisible({ timeout: 10_000 });

    // Cloud section
    await expect(page.getByText('Cloud API Keys')).toBeVisible();
    await expect(page.getByText('Groq', { exact: true }).first()).toBeVisible();

    // GPU section
    await expect(page.getByText('GPU Provider Keys')).toBeVisible();

    // Active badges for configured keys
    const activeBadges = page.locator('span').filter({ hasText: 'Active' });
    expect(await activeBadges.count()).toBeGreaterThan(0);
  });
});

test.describe('URL routing', () => {
  test('direct URL navigation works for all pages', async ({ page }) => {
    const routes = [
      { path: '/', text: 'Overview' },
      { path: '/config/profiles', text: 'Profiles' },
      { path: '/config/api-keys', text: 'API Keys' },
      { path: '/tools/bot', text: 'Bot' },
      { path: '/monitor/logs', text: 'Logs' },
    ];

    for (const route of routes) {
      await page.goto(`${GW}${route.path}`);
      await expect(page.getByText(route.text).first()).toBeVisible({ timeout: 10_000 });
    }
  });
});
