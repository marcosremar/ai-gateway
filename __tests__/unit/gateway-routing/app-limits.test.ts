/**
 * Per-app limits (security test 06/10/2026, "blast radius of a leaked app key"): any key could call any OpenRouter
 * `org/model` by passthrough, with max_tokens up to 128 000 and no daily cap. A non-admin key now calls only its app's
 * aliases, with max_tokens clamped and a daily budget; admin keys are not limited.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { AppLimits, inferenceKindOf, type AppBudgetEvent } from '../../../src/gateway/proxy/app-limits';
import type { ChatRequest, LLMProvider } from '../../../src/gateway/providers/cloud/types';

const ADMIN = 'admin-key-0123456789';
const PARLE = 'parle-key-0123456789';

function limits(env: Record<string, string> = {}, now = () => Date.parse('2026-10-06T23:59:00Z')) {
  return new AppLimits({
    env, now,
    isAdmin: (u) => u === 'owner',
    aliasesOf: (u, stage) => (u === 'parle' ? new Set(stage === 'chat' ? ['parle-llm'] : stage === 'stt' ? ['parle-stt'] : ['parle-tts']) : null),
  });
}

describe('AppLimits', () => {
  it('an app key calls only its own aliases: no org/model passthrough, no embeddings/images, no model-less call', () => {
    const l = limits();
    expect(l.check('parle', 'chat', { model: 'parle-llm', messages: [] })).toBeNull();
    expect(l.check('parle', 'chat', { model: 'some-org/expensive-model', messages: [] })).toMatchObject({ status: 403 });
    expect(l.check('parle', 'stt', { model: 'parle-llm' })).toMatchObject({ status: 403 }); // a chat alias is not an STT alias
    expect(l.check('parle', 'stt', {})).toMatchObject({ status: 403 });
    expect(l.check('parle', 'embeddings', { model: 'parle-llm' })).toMatchObject({ status: 403 });
    expect(l.check('stranger', 'chat', { model: 'parle-llm' })).toMatchObject({ status: 403, message: expect.stringContaining('no routes') });
  });

  it('admin keys are never limited', () => {
    const l = limits({ APP_DAILY_REQUESTS: '1' });
    const body: Record<string, unknown> = { model: 'some-org/expensive-model', max_tokens: 100_000 };
    for (let i = 0; i < 3; i++) expect(l.check('owner', 'chat', body)).toBeNull();
    expect(body.max_tokens).toBe(100_000);
  });

  it('clamps max_tokens to APP_MAX_TOKENS (default 1024), and gives the cap to a request without one', () => {
    const big: Record<string, unknown> = { model: 'parle-llm', max_tokens: 128_000 };
    limits().check('parle', 'chat', big);
    expect(big.max_tokens).toBe(1024);
    const none: Record<string, unknown> = { model: 'parle-llm' };
    limits({ APP_MAX_TOKENS: '200' }).check('parle', 'chat', none);
    expect(none.max_tokens).toBe(200);
    const small: Record<string, unknown> = { model: 'parle-llm', max_tokens: 50 };
    limits().check('parle', 'chat', small);
    expect(small.max_tokens).toBe(50);
  });

  it('daily request and token budgets answer 429 with Retry-After until 00:00 UTC, and reset the next day', () => {
    let t = Date.parse('2026-10-06T23:59:00Z');
    const l = limits({ APP_DAILY_REQUESTS: '2' }, () => t);
    expect(l.check('parle', 'stt', { model: 'parle-stt' })).toBeNull();
    expect(l.check('parle', 'stt', { model: 'parle-stt' })).toBeNull();
    expect(l.check('parle', 'stt', { model: 'parle-stt' })).toMatchObject({ status: 429, retryAfterSeconds: 60, message: expect.stringContaining('2 requests') });
    t += 61_000;
    expect(l.check('parle', 'stt', { model: 'parle-stt' })).toBeNull();

    const tokens = limits({ APP_DAILY_TOKENS: '1500' });
    expect(tokens.check('parle', 'chat', { model: 'parle-llm', messages: [{ role: 'user', content: 'oi' }] })).toBeNull(); // ~1030
    expect(tokens.check('parle', 'chat', { model: 'parle-llm', messages: [] })).toMatchObject({ status: 429, type: 'budget_exceeded' });
    expect(tokens.usageOf('parle').requests).toBe(1);
    expect(limits({ APP_DAILY_TOKENS: '0', APP_DAILY_REQUESTS: '0' }).check('parle', 'tts', { model: 'parle-tts', input: 'x'.repeat(10_000) })).toBeNull();
  });

  const tts1000 = { model: 'parle-tts', input: 'x'.repeat(4000) };

  it('an exhausted daily budget says which budget and when it resets, machine-readable', () => {
    const l = limits({ APP_DAILY_TOKENS: '1500' });
    expect(l.check('parle', 'tts', tts1000)).toBeNull();
    expect(l.check('parle', 'tts', tts1000)).toEqual({
      status: 429, type: 'budget_exceeded', code: 'daily_budget_exhausted', budget: 'tokens', resetAt: '2026-10-07T00:00:00.000Z',
      retryAfterSeconds: 60, message: expect.stringContaining('1500 tokens'),
    });
    expect(limits({ APP_DAILY_REQUESTS: '0', APP_DAILY_TOKENS: '0' }).chargeRequests('parle', 10_000)).toBeNull();
    expect(limits({ APP_DAILY_REQUESTS: '39' }).chargeRequests('parle', 40)).toMatchObject({ code: 'daily_budget_exhausted', budget: 'requests' });
  });

  it('budgets(): use against the limit and the projected exhaustion at the recent rate, per app', () => {
    let t = Date.parse('2026-10-06T12:00:00Z');
    const l = limits({ APP_DAILY_TOKENS: '100000' }, () => t);
    expect(l.budgets()).toEqual([]);
    for (let i = 0; i < 40; i++) { expect(l.check('parle', 'tts', tts1000)).toBeNull(); t += 6_000; }
    expect(l.budgets()).toEqual([{
      app: 'parle', resetAt: '2026-10-07T00:00:00.000Z',
      requests: { used: 40, limit: 5000, perMinute: 10, exhaustedAt: '2026-10-06T20:20:00.000Z' },
      tokens: { used: 40_000, limit: 100_000, perMinute: 10_000, exhaustedAt: '2026-10-06T12:10:00.000Z' },
    }]);
    expect(l.budgets('parle')).toHaveLength(1);
    expect(l.budgets('other')).toEqual([]);
    t += 3 * 3_600_000;
    expect(l.budgets()[0].tokens).toMatchObject({ used: 40_000, exhaustedAt: null });
    t = Date.parse('2026-10-07T00:00:01Z');
    expect(l.budgets()).toEqual([]);
  });

  it('budgets(): the rate is the last 5-10 minutes, not the whole day', () => {
    let t = Date.parse('2026-10-06T08:00:00Z');
    const l = limits({ APP_DAILY_TOKENS: '2000000' }, () => t);
    l.check('parle', 'tts', tts1000);
    t = Date.parse('2026-10-06T12:00:00Z');
    for (let i = 0; i < 120; i++) { l.check('parle', 'tts', tts1000); t += 6_000; }
    const { tokens } = l.budgets()[0];
    expect(tokens.perMinute).toBeGreaterThan(9_000);
    expect(tokens.perMinute).toBeLessThanOrEqual(10_000);
  });

  it('one event at 80 % and one at exhaustion per UTC day and budget', () => {
    let t = Date.parse('2026-10-06T12:00:00Z');
    const events: AppBudgetEvent[] = [];
    const l = new AppLimits({
      env: { APP_DAILY_TOKENS: '10000' }, now: () => t, isAdmin: () => false, aliasesOf: () => new Set(['parle-tts']),
      onBudgetEvent: e => events.push(e),
    });
    for (let i = 0; i < 7; i++) l.check('parle', 'tts', tts1000);
    expect(events).toEqual([]);
    for (let i = 0; i < 3; i++) expect(l.check('parle', 'tts', tts1000)).toBeNull();
    expect(events).toEqual([{ event: 'app.budget_warning', app: 'parle', budget: 'tokens', used: 8000, limit: 10_000, resetAt: '2026-10-07T00:00:00.000Z' }]);
    for (let i = 0; i < 3; i++) expect(l.check('parle', 'tts', tts1000)).toMatchObject({ status: 429 });
    expect(events.map(e => e.event)).toEqual(['app.budget_warning', 'app.budget_exhausted']);
    expect(events[1]).toMatchObject({ app: 'parle', budget: 'tokens', used: 10_000, limit: 10_000 });
    t += 86_400_000;
    for (let i = 0; i < 8; i++) l.check('parle', 'tts', tts1000);
    expect(events.map(e => e.event)).toEqual(['app.budget_warning', 'app.budget_exhausted', 'app.budget_warning']);
  });

  it('an app with its own daily budgets is not capped by the gateway default; the others keep the default', () => {
    const own: Record<string, { dailyRequests?: number; dailyTokens?: number }> = { parle: { dailyRequests: 5 } };
    const l = new AppLimits({
      env: { APP_DAILY_REQUESTS: '2', APP_DAILY_TOKENS: '10000' }, now: () => Date.parse('2026-10-06T12:00:00Z'), isAdmin: () => false,
      aliasesOf: () => new Set(['parle-tts']), limitsOf: u => own[u],
    });
    for (let i = 0; i < 5; i++) expect(l.check('parle', 'tts', { model: 'parle-tts', input: 'oi' })).toBeNull();
    expect(l.check('parle', 'tts', { model: 'parle-tts', input: 'oi' })).toMatchObject({ status: 429, budget: 'requests' });
    expect(l.budgets('parle')[0]).toMatchObject({ requests: { used: 5, limit: 5 }, tokens: { limit: 10_000 } });
    for (let i = 0; i < 2; i++) expect(l.check('other', 'tts', { model: 'parle-tts', input: 'oi' })).toBeNull();
    expect(l.check('other', 'tts', { model: 'parle-tts', input: 'oi' })).toMatchObject({ status: 429 });
    own.parle = { dailyRequests: 0 };
    expect(l.check('parle', 'tts', { model: 'parle-tts', input: 'oi' })).toBeNull();
  });

  it('the budget ends between turns, never inside one: the last admitted turn is whole, the next is refused until 00:00 UTC', () => {
    let t = Date.parse('2026-10-06T23:59:30Z');
    const events: AppBudgetEvent[] = [];
    const l = new AppLimits({
      env: { APP_DAILY_REQUESTS: '3' }, now: () => t, isAdmin: () => false, aliasesOf: () => new Set(['parle-llm', 'parle-tts']),
      onBudgetEvent: e => events.push(e),
    });
    const turn = () => l.checkS2S('parle', { models: { chat: 'parle-llm' }, messages: [] });
    expect(l.chargeRequests('parle', 2)).toBeNull();
    expect(turn()).toBeNull();
    expect(l.usageOf('parle').requests).toBe(3);
    expect(turn()).toMatchObject({
      status: 429, code: 'daily_budget_exhausted', budget: 'requests', resetAt: '2026-10-07T00:00:00.000Z', retryAfterSeconds: 30,
    });
    expect(l.chargeRequests('parle', 40)).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(l.usageOf('parle').requests).toBe(3);
    t = Date.parse('2026-10-06T23:59:59.999Z');
    expect(turn()).toMatchObject({ status: 429, retryAfterSeconds: 1 });
    t = Date.parse('2026-10-07T00:00:00Z');
    expect(turn()).toBeNull();
    expect(l.usageOf('parle')).toMatchObject({ requests: 1 });
    expect(l.budgets('parle')[0]!.resetAt).toBe('2026-10-08T00:00:00.000Z');
    expect(events.map(e => `${e.event}@${e.resetAt}`)).toEqual([
      'app.budget_warning@2026-10-07T00:00:00.000Z', 'app.budget_exhausted@2026-10-07T00:00:00.000Z',
    ]);
  });

  it('knows which paths are inference', () => {
    expect(inferenceKindOf('POST', '/v1/chat/completions')).toBe('chat');
    expect(inferenceKindOf('POST', '/v1/audio/transcriptions')).toBe('stt');
    expect(inferenceKindOf('POST', '/v1/images/inpaint')).toBe('images');
    expect(inferenceKindOf('GET', '/v1/models')).toBeNull();
  });
});

describe('proxy with app limits', () => {
  let server: Server;
  let base: string;
  const seen: ChatRequest[] = [];
  const llm: LLMProvider = {
    providerId: 'openrouter',
    isConfigured: () => true,
    chat: async (r) => { seen.push(r); return { content: 'ok', model: r.model }; },
  };

  beforeEach(async () => {
    seen.length = 0;
    server = createProxyServer({
      apiKeys: [`${ADMIN}:owner`, `${PARLE}:parle`],
      providers: {
        chat: {}, stt: {}, tts: {},
        chatRoutes: { 'parle-llm': [{ providerId: 'openrouter', provider: llm, model: 'qwen/qwen3.5-9b' }] },
        chatDynamicRoutes: [{ providerId: 'openrouter', provider: llm, acceptsModel: (m) => m.includes('/'), upstreamModel: (m) => m }],
      } as never,
      appLimits: limits(),
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>(r => server.close(() => r())); });

  const chat = (key: string, body: Record<string, unknown>) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'oi' }], ...body }),
  });

  it('an exhausted daily budget answers 429 budget_exceeded with code, budget and reset_at (not the rate limit shape)', async () => {
    const limited = createProxyServer({
      apiKeys: [`${PARLE}:parle`],
      providers: { chat: {}, stt: {}, tts: {}, chatRoutes: { 'parle-llm': [{ providerId: 'openrouter', provider: llm, model: 'qwen/qwen3.5-9b' }] } } as never,
      appLimits: limits({ APP_DAILY_REQUESTS: '1' }),
    });
    await new Promise<void>(r => limited.listen(0, '127.0.0.1', () => r()));
    try {
      const post = () => fetch(`http://127.0.0.1:${(limited.address() as AddressInfo).port}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${PARLE}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'parle-llm', messages: [{ role: 'user', content: 'oi' }] }),
      });
      expect((await post()).status).toBe(200);
      const res = await post();
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(((await res.json()) as { error: unknown }).error).toEqual({
        message: expect.stringContaining('1 requests'), type: 'budget_exceeded', code: 'daily_budget_exhausted', budget: 'requests',
        reset_at: '2026-10-07T00:00:00.000Z',
      });
    } finally {
      await new Promise<void>(r => limited.close(() => r()));
    }
  });

  it('refuses passthrough for the app key before any provider is called, and clamps max_tokens on its alias', async () => {
    const denied = await chat(PARLE, { model: 'some-org/expensive-model', max_tokens: 128_000 });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { message: string } }).error.message).toMatch(/not an alias of app 'parle'/);
    expect(seen).toEqual([]);

    expect((await chat(PARLE, { model: 'parle-llm', max_tokens: 128_000 })).status).toBe(200);
    expect(seen[0]).toMatchObject({ model: 'qwen/qwen3.5-9b', maxTokens: 1024 });
  });

  it('the admin key keeps passthrough and its own max_tokens', async () => {
    expect((await chat(ADMIN, { model: 'some-org/expensive-model', max_tokens: 4000 })).status).toBe(200);
    expect(seen[0]).toMatchObject({ model: 'some-org/expensive-model', maxTokens: 4000 });
  });
});
