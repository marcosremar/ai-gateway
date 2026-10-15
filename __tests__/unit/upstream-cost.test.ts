import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatLLMProvider } from '../../src/gateway/providers/cloud/openai-compat/openai-compat-llm';
import { setGatewayTelemetrySink } from '../../src/telemetry/emit';
import type { TelemetryEvent } from '../../src/telemetry/contract';
import { withLogContext } from '../../src/logger';

function provider(create: (body: Record<string, unknown>) => unknown) {
  const p = new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: 'https://upstream.invalid/v1', envKey: 'UNUSED_TEST_KEY' }).withApiKey('fake');
  (p as unknown as { client: unknown }).client = { chat: { completions: { create: async (body: Record<string, unknown>) => create(body) } } };
  return p;
}

const seen: Array<[TelemetryEvent, string | undefined]> = [];
afterEach(() => { seen.length = 0; setGatewayTelemetrySink(null); });
const listen = () => setGatewayTelemetrySink((e, caller) => seen.push([e, caller]));

describe('upstream cost (OpenRouter usage.cost)', () => {
  it('reports the cost of a chat answer as usage.cost, with the caller of the request', async () => {
    listen();
    const p = provider(() => ({
      model: 'google/gemini-2.5-flash', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.000123 },
    }));
    await withLogContext({ userId: 'parle' }, () => p.chat({ messages: [{ role: 'user', content: 'oi' }], model: 'google/gemini-2.5-flash' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toMatchObject({ event: 'usage.cost', attrs: { stage: 'chat', provider: 'openrouter', model: 'google/gemini-2.5-flash', costUsd: 0.000123 } });
    expect(seen[0]![1]).toBe('parle');
  });

  it('reports the cost carried by the last chunk of a stream, and nothing when the upstream sends no cost', async () => {
    listen();
    const chunks = [
      { model: 'm', choices: [{ delta: { content: 'o' }, finish_reason: null }] },
      { model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
      { model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.5 } },
    ];
    const p = provider(() => (async function* () { yield* chunks; })());
    const out: string[] = [];
    for await (const piece of p.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'm' })) out.push(piece);
    expect(out[0]).toBe('o');
    expect(seen.map(([e]) => e.attrs?.costUsd)).toEqual([0.5]);
    const free = provider(() => ({ model: 'm', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    await free.chat({ messages: [{ role: 'user', content: 'oi' }], model: 'm' });
    expect(seen).toHaveLength(1);
  });
});
