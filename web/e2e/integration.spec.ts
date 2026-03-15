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
        profiles: [profile],
        activeProfileId: 'test-integration',
      }),
    });
    expect(res.ok).toBe(true);

    // Load and verify
    const res2 = await fetch(`${GW}/v1/config/providers`);
    const config = await res2.json();
    const saved = config.profiles.find((p: any) => p.id === 'test-integration');
    expect(saved).toBeDefined();
    expect(saved.name).toBe('Integration Test Profile');
    expect(config.activeProfileId).toBe('test-integration');
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
    await expect(page.getByText('All Systems Operational')).toBeVisible({ timeout: 10_000 });

    // Stat cards
    await expect(page.locator('div').filter({ hasText: /^P50 Latency$/ }).first()).toBeVisible();
    await expect(page.locator('div').filter({ hasText: /^P95 Latency$/ }).first()).toBeVisible();

    // Pipeline stages
    await expect(page.getByText('Speech-to-Text')).toBeVisible();
    await expect(page.getByText('Translation')).toBeVisible();
    await expect(page.getByText('Text-to-Speech')).toBeVisible();

    // Provider table (after requests)
    await expect(page.getByText('Provider Performance')).toBeVisible();
  });

  test('pipeline shows latency data after requests', async ({ page }) => {
    await page.goto(`${GW}/`);
    await expect(page.getByText('Active Pipeline')).toBeVisible({ timeout: 10_000 });

    // LLM should have data from earlier tests
    const llmCard = page.locator('div').filter({ hasText: 'Translation' }).filter({ hasText: /\d+ms/ }).first();
    await expect(llmCard).toBeVisible();
  });
});

test.describe('Providers UI', () => {
  test('mode toggle Pipeline/GPU exists on providers page', async ({ page }) => {
    await page.goto(`${GW}/providers`);
    await expect(page.getByRole('heading', { name: 'Provider Configuration' })).toBeVisible({ timeout: 10_000 });

    // Both toggle buttons should exist
    const pipelineBtn = page.locator('button').filter({ hasText: /Pipeline/ }).first();
    const gpuBtn = page.locator('button').filter({ hasText: 'GPU Deploy' }).last();
    await expect(pipelineBtn).toBeVisible();
    await expect(gpuBtn).toBeVisible();
  });

  test('profiles are listed', async ({ page }) => {
    await page.goto(`${GW}/providers`);
    await expect(page.getByRole('heading', { name: 'Provider Configuration' })).toBeVisible({ timeout: 10_000 });
    // Should show the test profile we created
    await expect(page.getByText('Integration Test Profile')).toBeVisible();
  });

  test('save bar appears and works', async ({ page }) => {
    await page.goto(`${GW}/providers`);
    await expect(page.getByText('Provider Configuration')).toBeVisible({ timeout: 10_000 });

    // SaveBar should be visible
    await expect(page.getByText('Save Changes')).toBeVisible();
  });
});

test.describe('GPU Deploy UI', () => {
  test('shows deploy config and auto-stop', async ({ page }) => {
    await page.goto(`${GW}/gpu`);
    await expect(page.getByRole('heading', { name: 'GPU Deploy' })).toBeVisible({ timeout: 10_000 });

    // Deploy config
    await expect(page.getByText('Deploy Configuration')).toBeVisible();
    await expect(page.getByText('Docker Image', { exact: true })).toBeVisible();

    // Auto-stop section
    await expect(page.getByText('Auto-Stop')).toBeVisible();
    await expect(page.getByRole('button', { name: '15 min' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Never' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Custom...' })).toBeVisible();
  });

  test('auto-stop preset buttons are clickable', async ({ page }) => {
    await page.goto(`${GW}/gpu`);
    await expect(page.getByText('Auto-Stop')).toBeVisible({ timeout: 10_000 });

    // Click 30 min
    await page.locator('button').filter({ hasText: '30 min' }).click();
    await expect(page.getByText('GPU will auto-terminate after 30 minutes')).toBeVisible();

    // Click back to 15 min
    await page.locator('button').filter({ hasText: '15 min' }).click();
    await expect(page.getByText('GPU will auto-terminate after 15 minutes')).toBeVisible();
  });

  test('custom timeout input works', async ({ page }) => {
    await page.goto(`${GW}/gpu`);
    await expect(page.getByText('Auto-Stop')).toBeVisible({ timeout: 10_000 });

    await page.locator('button').filter({ hasText: 'Custom...' }).click();
    await page.locator('input[type="number"]').fill('45');
    await page.locator('button').filter({ hasText: 'Set' }).click();

    await expect(page.getByText('GPU will auto-terminate after 45 minutes')).toBeVisible();

    // Restore 15
    await page.locator('button').filter({ hasText: '15 min' }).click();
  });
});

test.describe('API Keys UI', () => {
  test('shows configured providers with masked keys', async ({ page }) => {
    await page.goto(`${GW}/api-keys`);
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
      { path: '/api-keys', text: 'API Keys' },
      { path: '/providers', text: 'Provider Configuration' },
      { path: '/gpu', text: 'GPU Deploy' },
      { path: '/bot', text: 'Bot' },
      { path: '/logs', text: 'Logs' },
    ];

    for (const route of routes) {
      await page.goto(`${GW}${route.path}`);
      await expect(page.getByText(route.text).first()).toBeVisible({ timeout: 10_000 });
    }
  });
});
