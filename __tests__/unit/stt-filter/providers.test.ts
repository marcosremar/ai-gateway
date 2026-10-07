import { describe, expect, it, vi } from 'vitest';
import { DeploymentSTTProvider } from '../../../src/deployments/inference-providers';
import { applyWhisperSegments } from '../../../src/gateway/providers/cloud/stt-segments';
import { DirectCaller, FallbackPlanStore } from '../../../sdk/node/direct-fallback';
import type { FallbackPlan } from '../../../src/deployments/app-fallback';

describe('applyWhisperSegments', () => {
  it('reads segments and duration-weighted aggregates', () => {
    const r = { text: 'x' } as { text: string; segments?: unknown[]; no_speech_prob?: number };
    applyWhisperSegments(r as never, { segments: [
      { id: 0, start: 0, end: 1, text: 'a', no_speech_prob: 0.2, avg_logprob: -0.2, compression_ratio: 1 },
      { id: 1, start: 1, end: 4, text: 'b', no_speech_prob: 0.6, avg_logprob: -0.6, compression_ratio: 1 }] });
    expect(r.segments).toHaveLength(2);
    expect(r.no_speech_prob).toBe(0.5);
  });
  it('reads the flat form of the speech-stack replica', () => {
    const r = { text: 'x' } as { text: string; avg_logprob?: number; no_speech_prob?: number };
    applyWhisperSegments(r as never, { text: 'x', no_speech_prob: 0.7, avg_logprob: -1.2, compression_ratio: 1.1 });
    expect(r).toMatchObject({ no_speech_prob: 0.7, avg_logprob: -1.2 });
  });
  it('plain {text} adds nothing (blocklist only)', () => {
    const r = { text: 'x' } as Record<string, unknown>;
    applyWhisperSegments(r as never, { text: 'x' });
    expect(Object.keys(r)).toEqual(['text']);
  });
});

describe('DeploymentSTTProvider metadata', () => {
  const lease = { machine: { ip: '10.0.0.1' }, token: 't', done: () => {} };
  const controller = { get: () => ({}), acquire: async () => lease, wake: () => null } as never;

  it('asks the replica for verbose_json when the gateway wants segments, and reads them', async () => {
    const formats: string[] = [];
    const fetchImpl = (async (_u: string, init: { body: FormData }) => {
      formats.push(String(init.body.get('response_format')));
      return new Response(JSON.stringify({ text: 'oi', segments: [{ text: 'oi', start: 0, end: 1, no_speech_prob: 0.1, avg_logprob: -0.2, compression_ratio: 1 }] }), { status: 200 });
    }) as never;
    const p = new DeploymentSTTProvider(controller, 'd', { fetchImpl });
    const r = await p.transcribe({ audio: Buffer.from([1]), model: 'm', wantSegments: true });
    expect(formats).toEqual(['verbose_json']);
    expect(r.segments).toHaveLength(1);
  });

  it('a replica that refuses verbose_json is asked again with json, and remembered', async () => {
    const formats: string[] = [];
    const fetchImpl = (async (_u: string, init: { body: FormData }) => {
      const f = String(init.body.get('response_format'));
      formats.push(f);
      return f === 'verbose_json' ? new Response('bad format', { status: 422 }) : new Response(JSON.stringify({ text: 'oi' }), { status: 200 });
    }) as never;
    const p = new DeploymentSTTProvider(controller, 'd', { fetchImpl });
    expect((await p.transcribe({ audio: Buffer.from([1]), model: 'm', wantSegments: true })).text).toBe('oi');
    await p.transcribe({ audio: Buffer.from([1]), model: 'm', wantSegments: true });
    expect(formats).toEqual(['verbose_json', 'json', 'json']);
  });

  it('plain calls stay json', async () => {
    const fetchImpl = vi.fn(async (_u: string, init: { body: FormData }) => new Response(JSON.stringify({ text: String(init.body.get('response_format')) }), { status: 200 }));
    const p = new DeploymentSTTProvider(controller, 'd', { fetchImpl: fetchImpl as never });
    expect((await p.transcribe({ audio: Buffer.from([1]), model: 'm' })).text).toBe('json');
  });
});

describe('SDK direct fallback (gateway down) filters hallucinations too', () => {
  const plan = {
    app: 'a', issuedAt: '', ttlSeconds: 300, openrouter: null,
    providers: { groq: { baseUrl: 'https://groq.test/v1', apiKey: 'k' } },
    routes: { stt: { 'parle-stt': [{ provider: 'groq', model: 'whisper-large-v3' }] }, chat: {}, tts: {} },
  } as unknown as FallbackPlan;
  const caller = (answer: unknown, seen: FormData[] = []) => new DirectCaller(new FallbackPlanStore(async () => plan, () => 0),
    (async (_u: string, init: { body: FormData }) => { seen.push(init.body); return new Response(JSON.stringify(answer), { status: 200 }); }) as never,
    { stt: 5000, chat: 5000, tts: 5000 } as never);
  const cause = new Error('gateway down') as never;

  it('drops a blocklisted invention, requests segments from Whisper, does not leak them', async () => {
    const seen: FormData[] = [];
    const out = await caller({ text: 'E aí.', segments: [] }, seen).transcribe({ file: new Uint8Array([1]), model: 'parle-stt', language: 'pt' }, cause);
    expect(out.text).toBe('');
    expect(out.filtered).toEqual(['blocklist']);
    expect(seen[0].get('response_format')).toBe('verbose_json');
    expect(out).not.toHaveProperty('segments');
  });
  it('keeps real speech; filterHallucinations:false is the QA opt-out', async () => {
    expect((await caller({ text: 'Bom dia.' }).transcribe({ file: new Uint8Array([1]), model: 'parle-stt', language: 'pt' }, cause)).text).toBe('Bom dia.');
    expect((await caller({ text: 'E aí.' }).transcribe({ file: new Uint8Array([1]), model: 'parle-stt', language: 'pt', filterHallucinations: false }, cause)).text).toBe('E aí.');
  });
});
