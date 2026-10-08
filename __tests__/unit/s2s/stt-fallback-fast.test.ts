import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { BUDGET_CAP_HEADER, budgetCapOf, HEDGE_CAP_HEADER, SUBREQUEST_HEADER, SUBREQUEST_TOKEN } from '../../../src/gateway/proxy/internal-subrequest';
import { _resetSttCache, handleAudioTranscriptions } from '../../../src/gateway/proxy/routes/audio-transcriptions';
import { runComposite, STT_BUDGET_MS, STT_HEDGE_MS } from '../../../src/s2s/composite';
import type { S2SEvent } from '../../../src/s2s/frames';
import { loopbackStages, STAGE_RETRY_WITHIN_MS } from '../../../src/s2s/loopback-stages';
import { setGatewayTelemetrySink } from '../../../src/telemetry/emit';
import { fakeStages, sleep } from './_fakes';

type Behaviour = (signal: AbortSignal) => Promise<{ text: string }>;
const answers = (ms: number, text: string): Behaviour => () => sleep(ms).then(() => ({ text }));
const hangs: Behaviour = signal => new Promise((_, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason))));
const breaks: Behaviour = () => Promise.reject(Object.assign(new Error('upstream 500'), { status: 500 }));

let chains = 0;

function chain(first: Behaviour, second?: Behaviour, firstId = 'openrouter') {
  const model = `whisper-${++chains}`;
  const link = (providerId: string, behaviour: Behaviour) => ({
    providerId, getModels: () => [], isConfigured: () => true,
    transcribe: vi.fn((req: { signal: AbortSignal }) => behaviour(req.signal)),
  });
  const a = link(firstId, first);
  const b = link('groq', second ?? breaks);
  const routes = { 'stt-m': [{ providerId: firstId, provider: a, model }, ...(second ? [{ providerId: 'groq', provider: b, model }] : [])] };
  const breakers = new CircuitBreakerRegistry();
  let clip = 0;
  const call = (headers: Record<string, string>) => handleAudioTranscriptions({
    method: 'POST', url: '/v1/audio/transcriptions', headers, rawBody: Buffer.from([1, 2, 3, ++clip]), body: { model: 'stt-m', language: 'pt' },
  }, routes as never, undefined, breakers);
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    const out = await call(init.headers);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: out.headers });
  }) as unknown as typeof fetch;
  const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: 'stt-m' } });
  return { a, b, call, stages, first: `openrouter:${model}`, second: `groq:${model}` };
}

const sub = (hedgeMs: number, budgetMs: number) => ({
  [SUBREQUEST_HEADER]: SUBREQUEST_TOKEN, [HEDGE_CAP_HEADER]: String(hedgeMs), [BUDGET_CAP_HEADER]: String(budgetMs),
});
const audio = new Uint8Array([1]);
const live = () => new AbortController().signal;

describe('composed fallback STT: hedge to the second link and a stage budget', () => {
  const events: Array<{ event: string; attrs?: Record<string, unknown> }> = [];
  beforeEach(() => { _resetSttCache(); events.length = 0; setGatewayTelemetrySink(e => events.push(e)); });
  afterEach(() => { setGatewayTelemetrySink(null); delete process.env.S2S_STT_HEDGE_MS; delete process.env.S2S_STT_BUDGET_MS; });

  it('a slow first link: the second answers right after the hedge, each link called once, both in telemetry', async () => {
    const { a, b, stages, second } = chain(hangs, answers(20, 'Bom dia.'));
    const t0 = Date.now();
    const heard = await stages.transcribe(audio, 'audio/wav', { language: 'pt' }, live(), 100, 2_000);
    expect(heard).toMatchObject({ text: 'Bom dia.', provider: second, fallback: 'slow' });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(a.transcribe).toHaveBeenCalledTimes(1);
    expect(b.transcribe).toHaveBeenCalledTimes(1);
    expect(a.transcribe.mock.calls[0][0].signal.aborted).toBe(true);
    expect(events.filter(e => e.event === 'route.hedge')).toHaveLength(1);
    expect(events.find(e => e.event === 'route.served')?.attrs).toMatchObject({ provider: 'groq', raced: true });
  });

  it('a first link that answers inside the threshold is the only call', async () => {
    const { a, b, stages, first } = chain(answers(20, 'Bom dia.'), answers(5, 'outro'));
    const heard = await stages.transcribe(audio, 'audio/wav', { language: 'pt' }, live(), 200, 2_000);
    expect(heard).toMatchObject({ text: 'Bom dia.', provider: first, fallback: null });
    expect(a.transcribe).toHaveBeenCalledTimes(1);
    expect(b.transcribe).not.toHaveBeenCalled();
    expect(events.some(e => e.event === 'route.hedge')).toBe(false);
  });

  it('a first link that errors: the second starts at once, before the hedge', async () => {
    const { b, stages, second } = chain(breaks, answers(20, 'Bom dia.'));
    const t0 = Date.now();
    const heard = await stages.transcribe(audio, 'audio/wav', { language: 'pt' }, live(), 1_500, 2_000);
    expect(heard).toMatchObject({ text: 'Bom dia.', provider: second, fallback: '5xx' });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(b.transcribe).toHaveBeenCalledTimes(1);
  });

  it('both links slow: the stage fails at its budget with the reason, and is not run a second time', async () => {
    const { a, b, stages } = chain(hangs, hangs);
    const t0 = Date.now();
    await expect(stages.transcribe(audio, 'audio/wav', { language: 'pt' }, live(), 100, 400)).rejects.toThrow(/stt HTTP 503.*timed out/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
    expect(Date.now() - t0).toBeLessThan(900);
    expect(a.transcribe).toHaveBeenCalledTimes(1);
    expect(b.transcribe).toHaveBeenCalledTimes(1);
    expect(events.find(e => e.event === 'route.unavailable')?.attrs).toMatchObject({ stage: 'stt', codes: 'timeout' });
  });

  it('only the gateway\'s own sub-request sets the stage budget', async () => {
    expect(budgetCapOf(sub(100, 400))).toBe(400);
    expect(budgetCapOf({ [BUDGET_CAP_HEADER]: '400' })).toBe(0);
    const { call } = chain(answers(600, 'Bom dia.'), answers(600, 'outro'));
    const out = await call({ [BUDGET_CAP_HEADER]: '100' });
    expect(out.status).toBe(200);
  });

  it('fewer than two cloud links: the short budget is not applied, a slow answer is late and not a failure', async () => {
    const alone = chain(answers(600, 'Bom dia.'));
    expect(await alone.call(sub(100, 400))).toMatchObject({ status: 200, body: { text: 'Bom dia.' } });
    const behindDeployment = chain(breaks, answers(600, 'Bom dia.'), 'deployment:parle-speech');
    expect(await behindDeployment.call(sub(100, 400))).toMatchObject({ status: 200, body: { text: 'Bom dia.' } });
  });

  it('a stage that failed after its time is not retried; a quick 503 still is', async () => {
    let calls = 0;
    const slow503 = loopbackStages({
      baseUrl: 'http://gw', authorization: 'Bearer k', models: { stt: 'w' },
      fetchImpl: (async () => { calls++; await sleep(STAGE_RETRY_WITHIN_MS + 50); return new Response('{"error":{"message":"timed out"}}', { status: 503 }); }) as unknown as typeof fetch,
    });
    await expect(slow503.transcribe(audio, 'audio/wav', {}, live())).rejects.toThrow(/503/);
    expect(calls).toBe(1);
  });

  it('the composed turn asks the STT stage for the hedge and the budget, with or without a first-audio deadline', async () => {
    const { stages, calls } = fakeStages();
    const seen: Array<[number | undefined, number | undefined]> = [];
    const transcribe = stages.transcribe.bind(stages);
    stages.transcribe = (a, ct, cfg, signal, hedgeMs, budgetMs) => { seen.push([hedgeMs, budgetMs]); return transcribe(a, ct, cfg, signal, hedgeMs, budgetMs); };
    const turn = (config: object) => runComposite({ stages, audio, contentType: 'audio/wav', config, signal: live(), emitEvent: () => {}, emitAudio: () => {} });
    await turn({});
    await turn({ first_audio_deadline_ms: 2_000, endpoint_ms: 700 });
    expect(seen).toEqual([[STT_HEDGE_MS, STT_BUDGET_MS], [STT_HEDGE_MS, STT_BUDGET_MS]]);
    expect(calls.filter(c => c.stage === 'llm')).toHaveLength(2);
  });

  it('a whole turn on a slow first link is answered through the second; both slow ends the turn at the budget', async () => {
    process.env.S2S_STT_HEDGE_MS = '100';
    process.env.S2S_STT_BUDGET_MS = '400';
    const rest = fakeStages().stages;
    const turn = async (stt: ReturnType<typeof chain>) => {
      const out: S2SEvent[] = [];
      const t0 = Date.now();
      const stages = { ...rest, transcribe: stt.stages.transcribe };
      const result = await runComposite({ stages, audio, contentType: 'audio/wav', config: { language: 'pt' }, signal: live(), emitEvent: e => out.push(e), emitAudio: () => {} })
        .catch((err: Error) => err);
      return { out, result, ms: Date.now() - t0 };
    };
    const slowFirst = chain(hangs, answers(20, 'Bom dia, eu queria um pão.'));
    const hedged = await turn(slowFirst);
    expect(hedged.out.find(e => e.type === 'transcript')).toMatchObject({ text: 'Bom dia, eu queria um pão.', provider: slowFirst.second, fallback: 'slow' });
    expect(hedged.out.at(-1)).toMatchObject({ type: 'done' });
    const failed = await turn(chain(hangs, hangs));
    expect(failed.result).toBeInstanceOf(Error);
    expect((failed.result as Error).message).toMatch(/stt HTTP 503.*timed out/);
    expect(failed.ms).toBeLessThan(900);
    expect(failed.out.some(e => e.type === 'transcript')).toBe(false);
  });
});
