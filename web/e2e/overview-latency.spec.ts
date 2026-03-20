/**
 * E2E test: verify that playground requests show up as latency data in Overview.
 *
 * Runs against the REAL gateway (localhost:4000), not a mock.
 * Prerequisites: gateway must be running (`bun run gateway-server.ts`).
 */
import { test, expect } from '@playwright/test';

const GATEWAY = 'http://localhost:4000';

test.describe('Overview latency data', () => {
  test.beforeAll(async () => {
    // Generate some real requests so metrics are populated
    const requests = [
      fetch(`${GATEWAY}/v1/playground/llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello in French' }] }),
      }),
      fetch(`${GATEWAY}/v1/playground/llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Translate: good morning' }] }),
      }),
      fetch(`${GATEWAY}/v1/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Bonjour le monde', source_lang: 'fr', target_lang: 'en' }),
      }),
    ];
    const results = await Promise.all(requests);
    for (const r of results) {
      expect(r.ok, `Request failed: ${r.status} ${r.statusText}`).toBe(true);
    }
    await new Promise(r => setTimeout(r, 500));
  });

  test('health endpoint shows non-zero latency samples', async () => {
    const res = await fetch(`${GATEWAY}/health`);
    const health = await res.json();

    expect(health.latency.samples).toBeGreaterThan(0);
    expect(health.latency.p50_ms).toBeGreaterThan(0);
    expect(health.providerMetrics.groq).toBeDefined();
    expect(health.providerMetrics.groq.requests).toBeGreaterThan(0);
  });

  test('request log contains per-stage entries', async () => {
    const res = await fetch(`${GATEWAY}/v1/requests/log?limit=20`);
    const log = await res.json();

    expect(log.entries.length).toBeGreaterThan(0);
    const stages = new Set(log.entries.map((e: any) => e.stage));
    expect(stages.has('llm')).toBe(true);
  });

  test('Overview page shows latency stats and provider performance', async ({ page }) => {
    await page.goto(`${GATEWAY}/`);
    await expect(page.getByText('Online')).toBeVisible({ timeout: 10_000 });
    // Status strip shows compact "p50 Xms p95 Xms" format (lowercase)
    await expect(page.getByText('p50')).toBeVisible();
    await expect(page.getByText('p95')).toBeVisible();
    // Provider Performance section
    await expect(page.getByText('Provider Performance')).toBeVisible();
  });

  test('Provider Performance section shows latency data', async ({ page }) => {
    await page.goto(`${GATEWAY}/`);
    await expect(page.getByText('Online')).toBeVisible({ timeout: 10_000 });
    // Provider Performance section shows providers with latency bars
    await expect(page.getByText('Provider Performance')).toBeVisible();
    // The groq provider should appear in the performance bar
    await expect(page.getByText('groq').first()).toBeVisible();
  });

  test('Status strip shows p50 and p95 latency values', async ({ page }) => {
    await page.goto(`${GATEWAY}/`);
    await expect(page.getByText('Online')).toBeVisible({ timeout: 10_000 });

    // Status strip shows "p50 Xms" and "p95 Xms" (lowercase, compact format)
    await expect(page.getByText('p50')).toBeVisible();
    await expect(page.getByText('p95')).toBeVisible();
    // At least one ms value should be visible
    await expect(page.locator('span').filter({ hasText: /\d+ms/ }).first()).toBeVisible();
  });

  test('Provider Performance section shows groq', async ({ page }) => {
    await page.goto(`${GATEWAY}/`);
    await expect(page.getByText('Online')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Provider Performance')).toBeVisible();
    // ProviderBar renders provider name in a span (not a td)
    await expect(page.getByText('groq').first()).toBeVisible();
  });
});
