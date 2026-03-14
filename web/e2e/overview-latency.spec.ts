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

  test('Overview page shows Active Pipeline with 3 stages', async ({ page }) => {
    await page.goto(`${GATEWAY}/`);
    await expect(page.getByText('All Systems Operational')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Active Pipeline')).toBeVisible();

    // All 3 stages visible by their subtitle text (unique per stage)
    await expect(page.getByText('Speech-to-Text')).toBeVisible();
    await expect(page.getByText('Translation')).toBeVisible();
    await expect(page.getByText('Text-to-Speech')).toBeVisible();
  });

  test('LLM stage card shows latency values', async ({ page }) => {
    await page.goto(`${GATEWAY}/`);
    await expect(page.getByText('All Systems Operational')).toBeVisible({ timeout: 10_000 });

    // The LLM card should have at least one latency reading with "ms"
    // Find the card that contains both "Translation" (LLM subtitle) and a ms value
    const llmCard = page.locator('div').filter({ hasText: 'Translation' }).filter({ hasText: /\d+ms/ }).first();
    await expect(llmCard).toBeVisible();

    // Should show Cold or Warm label
    const text = await llmCard.textContent() || '';
    const hasColdOrWarm = text.includes('Cold') || text.includes('Warm');
    expect(hasColdOrWarm).toBe(true);
  });

  test('Stat cards show P50 and P95 latency', async ({ page }) => {
    await page.goto(`${GATEWAY}/`);
    await expect(page.getByText('All Systems Operational')).toBeVisible({ timeout: 10_000 });

    // P50 card should exist and show a ms value
    const p50 = page.locator('div').filter({ hasText: 'P50 Latency' }).filter({ hasText: /\d+ms/ }).first();
    await expect(p50).toBeVisible();

    // P95 card
    const p95 = page.locator('div').filter({ hasText: 'P95 Latency' }).filter({ hasText: /\d+ms/ }).first();
    await expect(p95).toBeVisible();
  });

  test('Provider Performance table shows groq', async ({ page }) => {
    await page.goto(`${GATEWAY}/`);
    await expect(page.getByText('All Systems Operational')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Provider Performance')).toBeVisible();
    await expect(page.locator('td').filter({ hasText: 'groq' }).first()).toBeVisible();
  });
});
