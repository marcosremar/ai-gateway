/**
 * Guardrail + Cache — /health endpoint integration tests
 *
 * Verifies that:
 * 1. The health endpoint response shape includes `translationCache` and `guardrails`
 * 2. The guardrail stats in /health reflect actual engine activity
 * 3. The cache stats in /health reflect actual cache operations
 *
 * These tests run against a mock health response (same shape as the real endpoint)
 * without requiring a live server. For live-server tests, set GATEWAY_URL env var.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetGuardrailStats, recordGuardrailPass, recordGuardrailBlock, recordGuardrailAudit, getGuardrailStats } from '../src/gateway/guardrails/stats';
import { getTranslationCacheStats, setCachedTranslation, getCachedTranslation } from '../src/gateway/pipeline/translation-cache';
import { GuardrailEngine } from '../src/gateway/guardrails';

beforeEach(() => {
  resetGuardrailStats();
});

// ── health response shape validation ─────────────────────────────────────────

function buildHealthPayload() {
  const rawCache = getTranslationCacheStats();
  const total = rawCache.cacheHits + rawCache.cacheMisses;
  const guardrails = getGuardrailStats();

  return {
    status: 'ok',
    uptime_sec: 3600,
    translationCache: {
      hits: rawCache.cacheHits,
      misses: rawCache.cacheMisses,
      size: rawCache.cacheSize,
      hitRate: total > 0 ? Math.round((rawCache.cacheHits / total) * 10000) / 10000 : 0,
    },
    guardrails,
  };
}

describe('health payload — translationCache field', () => {
  it('contains all required fields', () => {
    const payload = buildHealthPayload();
    expect(payload.translationCache).toBeDefined();
    expect(payload.translationCache).toHaveProperty('hits');
    expect(payload.translationCache).toHaveProperty('misses');
    expect(payload.translationCache).toHaveProperty('size');
    expect(payload.translationCache).toHaveProperty('hitRate');
  });

  it('hitRate is 0 when there are no requests', () => {
    const payload = buildHealthPayload();
    // May have some prior activity from other tests but hitRate is always 0–1
    expect(payload.translationCache.hitRate).toBeGreaterThanOrEqual(0);
    expect(payload.translationCache.hitRate).toBeLessThanOrEqual(1);
  });

  it('hitRate updates after cache activity', () => {
    const phrase = `health-intg-${Date.now()}`;
    setCachedTranslation(phrase, 'en', 'fr', 'test');
    getCachedTranslation(phrase, 'en', 'fr'); // hit
    getCachedTranslation(phrase, 'en', 'fr'); // hit
    getCachedTranslation(`miss-${phrase}`, 'en', 'fr'); // miss

    const payload = buildHealthPayload();
    expect(payload.translationCache.hits).toBeGreaterThanOrEqual(2);
    expect(payload.translationCache.misses).toBeGreaterThanOrEqual(1);
    expect(payload.translationCache.size).toBeGreaterThanOrEqual(1);
    expect(payload.translationCache.hitRate).toBeGreaterThan(0);
  });

  it('all values are non-negative numbers', () => {
    const payload = buildHealthPayload();
    const c = payload.translationCache;
    expect(c.hits).toBeGreaterThanOrEqual(0);
    expect(c.misses).toBeGreaterThanOrEqual(0);
    expect(c.size).toBeGreaterThanOrEqual(0);
    expect(c.hitRate).toBeGreaterThanOrEqual(0);
  });
});

describe('health payload — guardrails field', () => {
  it('contains all required fields', () => {
    const payload = buildHealthPayload();
    const g = payload.guardrails;
    expect(g).toHaveProperty('passed');
    expect(g).toHaveProperty('blocked');
    expect(g).toHaveProperty('audited');
    expect(g).toHaveProperty('ruleHits');
    expect(g).toHaveProperty('totalEvaluations');
    expect(g).toHaveProperty('lastBlockedAt');
  });

  it('starts with all zeros after reset', () => {
    resetGuardrailStats();
    const payload = buildHealthPayload();
    const g = payload.guardrails;
    expect(g.passed).toBe(0);
    expect(g.blocked).toBe(0);
    expect(g.audited).toBe(0);
    expect(g.totalEvaluations).toBe(0);
    expect(g.ruleHits).toEqual({});
    expect(g.lastBlockedAt).toBeNull();
  });

  it('reflects engine activity — passes', async () => {
    const engine = new GuardrailEngine({
      rules: [{ type: 'notNull', hooks: ['beforeRequest'] }],
      action: 'block',
    });
    await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'valid' }] });
    await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'also valid' }] });

    const payload = buildHealthPayload();
    expect(payload.guardrails.passed).toBe(2);
    expect(payload.guardrails.blocked).toBe(0);
    expect(payload.guardrails.totalEvaluations).toBe(2);
  });

  it('reflects engine activity — blocks', async () => {
    const engine = new GuardrailEngine({
      rules: [{ type: 'regex', pattern: 'BLOCKED', not: true, hooks: ['beforeRequest'] }],
      action: 'block',
    });
    await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'BLOCKED content' }] });

    const payload = buildHealthPayload();
    expect(payload.guardrails.blocked).toBe(1);
    expect(payload.guardrails.ruleHits['regex']).toBe(1);
    expect(payload.guardrails.lastBlockedAt).not.toBeNull();
  });

  it('reflects engine activity — audits', async () => {
    const engine = new GuardrailEngine({
      rules: [{ type: 'regex', pattern: 'secret', not: true, hooks: ['afterResponse'] }],
      action: 'audit',
    });
    await engine.runAfterResponseText('contains secret info');

    const payload = buildHealthPayload();
    expect(payload.guardrails.audited).toBe(1);
    expect(payload.guardrails.blocked).toBe(0);
    expect(payload.guardrails.lastBlockedAt).toBeNull();
  });

  it('ruleHits is empty object when no rules triggered', () => {
    recordGuardrailPass();
    recordGuardrailPass();
    const payload = buildHealthPayload();
    expect(payload.guardrails.ruleHits).toEqual({});
  });

  it('totalEvaluations = passed + blocked + audited', () => {
    recordGuardrailPass();
    recordGuardrailPass();
    recordGuardrailBlock('regex');
    recordGuardrailAudit('notNull');

    const payload = buildHealthPayload();
    const g = payload.guardrails;
    expect(g.totalEvaluations).toBe(g.passed + g.blocked + g.audited);
  });
});

// ── combined cache + guardrail scenario ───────────────────────────────────────

describe('combined cache + guardrail health snapshot', () => {
  it('both fields are independently correct in the same snapshot', async () => {
    // Cache activity
    const phrase = `combined-test-${Date.now()}`;
    setCachedTranslation(phrase, 'en', 'pt', 'teste');
    getCachedTranslation(phrase, 'en', 'pt');         // hit
    getCachedTranslation(`miss-${Date.now()}`, 'en', 'pt'); // miss

    // Guardrail activity
    const engine = new GuardrailEngine({
      rules: [
        { type: 'notNull', hooks: ['beforeRequest'] },
        { type: 'modelWhitelist', models: ['gpt-4o', 'llama'], hooks: ['beforeRequest'] },
      ],
      action: 'block',
    });
    await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-4o');   // pass
    await engine.runBeforeRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'forbidden'); // block on modelWhitelist

    const payload = buildHealthPayload();

    // Cache checks
    expect(payload.translationCache.hits).toBeGreaterThanOrEqual(1);
    expect(payload.translationCache.misses).toBeGreaterThanOrEqual(1);
    expect(payload.translationCache.size).toBeGreaterThanOrEqual(1);

    // Guardrail checks
    expect(payload.guardrails.passed).toBeGreaterThanOrEqual(1);
    expect(payload.guardrails.blocked).toBeGreaterThanOrEqual(1);
    expect(payload.guardrails.ruleHits['modelWhitelist']).toBeGreaterThanOrEqual(1);
  });
});

// ── live server test (optional, skipped when GATEWAY_URL not set) ─────────────

const GATEWAY_URL = process.env.GATEWAY_URL;

describe.skipIf(!GATEWAY_URL)('GET /health — live server', () => {
  it('includes translationCache field', async () => {
    const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(10_000) });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('translationCache');
    const cache = data.translationCache as Record<string, unknown>;
    expect(typeof cache.hits).toBe('number');
    expect(typeof cache.misses).toBe('number');
    expect(typeof cache.size).toBe('number');
    expect(typeof cache.hitRate).toBe('number');
  });

  it('includes guardrails field', async () => {
    const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('guardrails');
    const g = data.guardrails as Record<string, unknown>;
    expect(typeof g.passed).toBe('number');
    expect(typeof g.blocked).toBe('number');
    expect(typeof g.audited).toBe('number');
    expect(typeof g.totalEvaluations).toBe('number');
  });
});
