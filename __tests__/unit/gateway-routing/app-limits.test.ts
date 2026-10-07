/**
 * Per-app limits (security test 06/10/2026, "blast radius of a leaked app key"): any key could call any OpenRouter
 * `org/model` by passthrough, with max_tokens up to 128 000 and no daily cap. A non-admin key now calls only its app's
 * aliases, with max_tokens clamped and a daily budget; admin keys are not limited.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { AppLimits, inferenceKindOf } from '../../../src/gateway/proxy/app-limits';
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
