import { describe, expect, it, vi } from 'vitest';
import {
  MOBILE_BUDGET_MB, admitStages, createLocalTier, espeakPhonemizer, espeakToKokoro, fileProgress, kokoroTts, logprobMeter, probeDevice, webLlm, whisperStt,
  type DeviceCapabilities, type GatewayLike, type LlmEngine, type LocalModel, type LocalTierOptions, type SttEngine, type TtsEngine,
} from '../../sdk/browser/local/index';
import type { ChatStream, Served } from '../../sdk/node/gateway-types';

const DESKTOP: DeviceCapabilities = { webgpu: true, shaderF16: true, gpu: 'apple metal-3', mobile: false, deviceMemoryGb: 8, storageFreeMb: 50_000 };
const PHONE: DeviceCapabilities = { webgpu: false, shaderF16: false, gpu: null, mobile: true, deviceMemoryGb: null, storageFreeMb: 5_000 };
const GW_SERVED: Served = { provider: 'groq', fallback: null, fallbackFrom: null };

function gatewayStream(text: string): ChatStream {
  return { served: GW_SERVED, finishReason: 'stop', usage: null, cancel: async () => {}, async *[Symbol.asyncIterator]() { yield text; } };
}

function fakeGateway(fail = false) {
  const gw = {
    transcribe: vi.fn(async () => { if (fail) throw new Error('gw down'); return { text: 'gateway heard', served: GW_SERVED }; }),
    chat: vi.fn(async () => {
      if (fail) throw new Error('gw down');
      return { id: 'g', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'gateway says' }, finish_reason: 'stop' }], served: GW_SERVED };
    }),
    chatStream: vi.fn(async () => { if (fail) throw new Error('gw down'); return gatewayStream('gateway streams'); }),
    speech: vi.fn(async () => { if (fail) throw new Error('gw down'); return { body: new Blob(['mp3']).stream(), contentType: 'audio/mpeg', served: GW_SERVED }; }),
  };
  return gw satisfies GatewayLike;
}

const tone = () => Float32Array.from({ length: 2400 }, (_, i) => 0.3 * Math.sin(i / 5));

function fakeModels(over: { stt?: Partial<SttEngine>; tts?: Partial<TtsEngine>; llm?: Partial<LlmEngine>; loadDelay?: Promise<void> } = {}) {
  const loads = { stt: 0, tts: 0, llm: 0 };
  const model = <E>(stage: 'stt' | 'tts' | 'llm', engine: E, size: LocalModel<E>['size']): LocalModel<E> => ({
    id: `fake-${stage}`,
    size,
    async load({ onProgress }) { loads[stage]++; onProgress(0.5); await over.loadDelay; return engine; },
  });
  const stt: SttEngine = { transcribe: async () => ({ text: ' olá ', avgLogprob: -0.2 }), ...over.stt };
  const tts: TtsEngine = { speak: async () => ({ samples: tone(), rate: 24_000 }), ...over.tts };
  const llm: LlmEngine = { async *stream() { yield ''; yield 'Oi'; yield ', tudo bem?'; }, ...over.llm };
  return {
    loads,
    models: {
      stt: model('stt', stt, { webgpu: { memoryMb: 300, downloadMb: 200 }, wasm: { memoryMb: 150, downloadMb: 80 } }),
      tts: model('tts', tts, { webgpu: { memoryMb: 400, downloadMb: 330 }, wasm: { memoryMb: 180, downloadMb: 95 } }),
      llm: model('llm', llm, { webgpu: { memoryMb: 1000, downloadMb: 300 } }),
    },
  };
}

const ALL_LOCAL = { stt: 'local-first', tts: 'local-first', llm: 'local-first' } as const;
const wav = new Uint8Array([1, 2, 3]);
const sttReq = { file: wav, model: 'parle-stt', language: 'pt' };
const ttsReq = { model: 'parle-tts', input: 'Olá', voice: 'pf_dora' };
const chatReq = { model: 'parle-chat', messages: [{ role: 'user', content: 'Oi' }] };

function tier(over: Partial<LocalTierOptions> = {}, models = fakeModels()) {
  const gateway = (over.gateway ?? fakeGateway()) as ReturnType<typeof fakeGateway>;
  const telemetry = { emit: vi.fn() };
  const probe = vi.fn(async () => DESKTOP);
  const t = createLocalTier({ models: models.models, probe, telemetry, decodeAudio: async () => new Float32Array(16_000), ...over, gateway });
  return { t, gateway, telemetry, probe, loads: models.loads };
}

async function drain(stream: AsyncIterable<string>) {
  let out = '';
  for await (const d of stream) out += d;
  return out;
}

describe('local tier: default gateway-only', () => {
  it('passes every call straight to the gateway, never probes nor loads a model', async () => {
    const { t, gateway, probe, loads } = tier({ policy: undefined });
    const heard = await t.transcribe(sttReq);
    const said = await t.speak(ttsReq);
    const reply = await t.chat(chatReq);
    const stream = await t.chatStream(chatReq);
    expect(gateway.transcribe).toHaveBeenCalledWith(sttReq);
    expect(gateway.speech).toHaveBeenCalledWith(ttsReq);
    expect(gateway.chat).toHaveBeenCalledWith(chatReq);
    expect(gateway.chatStream).toHaveBeenCalledWith(chatReq);
    expect([heard.servedBy, said.servedBy, reply.servedBy, stream.servedBy]).toEqual(['gateway', 'gateway', 'gateway', 'gateway']);
    expect(heard).toMatchObject({ text: 'gateway heard', served: GW_SERVED, reason: null });
    expect(await drain(stream)).toBe('gateway streams');
    expect(probe).not.toHaveBeenCalled();
    expect(loads).toEqual({ stt: 0, tts: 0, llm: 0 });
  });
});

describe('local tier: local-first', () => {
  it('serves each stage on the device once the models are loaded, loading each once', async () => {
    const { t, gateway, loads } = tier({ policy: ALL_LOCAL });
    await t.prefetch();
    const heard = await t.transcribe(sttReq);
    const said = await t.speak(ttsReq);
    const reply = await t.chat(chatReq);
    const stream = await t.chatStream(chatReq);
    await t.transcribe(sttReq);
    expect(heard).toMatchObject({ text: 'olá', servedBy: 'local', reason: null, avg_logprob: -0.2, served: { provider: 'local:fake-stt' } });
    expect(said.contentType).toBe('audio/wav');
    expect((await new Response(said.body).arrayBuffer()).byteLength).toBe(44 + 2400 * 2);
    expect(reply.choices[0]!.message.content).toBe('Oi, tudo bem?');
    expect(stream.servedBy).toBe('local');
    expect(await drain(stream)).toBe('Oi, tudo bem?');
    expect(stream.finishReason).toBe('stop');
    expect(gateway.transcribe).not.toHaveBeenCalled();
    expect(gateway.speech).not.toHaveBeenCalled();
    expect(gateway.chat).not.toHaveBeenCalled();
    expect(gateway.chatStream).not.toHaveBeenCalled();
    expect(loads).toEqual({ stt: 1, tts: 1, llm: 1 });
  });

  it('answers from the gateway while the model is still loading, and locally once it is ready', async () => {
    let release!: () => void;
    const { t, gateway } = tier({ policy: ALL_LOCAL }, fakeModels({ loadDelay: new Promise<void>((r) => { release = r; }) }));
    const first = await t.transcribe(sttReq);
    expect(first).toMatchObject({ servedBy: 'gateway', reason: 'loading', text: 'gateway heard' });
    release();
    await t.prefetch(['stt']);
    expect((await t.transcribe(sttReq)).servedBy).toBe('local');
    expect(gateway.transcribe).toHaveBeenCalledTimes(1);
  });

  it('falls back to the gateway on a local error', async () => {
    const { t } = tier({ policy: ALL_LOCAL }, fakeModels({ tts: { speak: async () => { throw new Error('onnx'); } } }));
    await t.prefetch();
    expect(await t.speak(ttsReq)).toMatchObject({ servedBy: 'gateway', reason: 'error', contentType: 'audio/mpeg' });
  });

  it('falls back to the gateway when the stage deadline passes, and stops trying that stage locally', async () => {
    const never = new Promise<never>(() => {});
    const transcribe = vi.fn(() => never);
    const { t } = tier({ policy: ALL_LOCAL, deadlineMs: { stt: 20, llm: 20 } }, fakeModels({
      stt: { transcribe },
      llm: { async *stream() { await never; } },
    }));
    await t.prefetch();
    expect(await t.transcribe(sttReq)).toMatchObject({ servedBy: 'gateway', reason: 'timeout' });
    expect(await t.transcribe(sttReq)).toMatchObject({ servedBy: 'gateway', reason: 'timeout' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const stream = await t.chatStream(chatReq);
    expect(stream).toMatchObject({ servedBy: 'gateway', reason: 'timeout' });
    expect(await drain(stream)).toBe('gateway streams');
  });

  it('keeps an answer that blocked past the deadline, then sends the stage to the gateway', async () => {
    let clock = 0;
    const { t } = tier({ policy: ALL_LOCAL, now: () => clock }, fakeModels({ tts: { speak: async () => { clock += 9_000; return { samples: tone(), rate: 24_000 }; } } }));
    await t.prefetch();
    expect(await t.speak(ttsReq)).toMatchObject({ servedBy: 'local', reason: null });
    expect(await t.speak(ttsReq)).toMatchObject({ servedBy: 'gateway', reason: 'timeout' });
  });

  it('does not demote a stage whose deadline passed while it was still loading', async () => {
    let release!: () => void;
    const { t } = tier({ policy: { stt: 'gateway-first' }, gateway: fakeGateway(true), deadlineMs: { stt: 20 } },
      fakeModels({ loadDelay: new Promise<void>((r) => { release = r; }) }));
    await expect(t.transcribe(sttReq)).rejects.toThrow('gw down');
    release();
    expect(await t.transcribe(sttReq)).toMatchObject({ servedBy: 'local', reason: 'gateway_error' });
  });

  it.each([
    ['empty transcript', { stt: { transcribe: async () => ({ text: '  ' }) } }, 'stt'],
    ['low avg logprob', { stt: { transcribe: async () => ({ text: 'obrigado', avgLogprob: -1.6 }) } }, 'stt'],
    ['empty LLM output', { llm: { async *stream() { yield ' '; } } }, 'llm'],
    ['silent TTS', { tts: { speak: async () => ({ samples: new Float32Array(2400), rate: 24_000 }) } }, 'tts'],
  ] as const)('falls back to the gateway on low confidence: %s', async (_name, over, stage) => {
    const { t } = tier({ policy: ALL_LOCAL }, fakeModels(over as Parameters<typeof fakeModels>[0]));
    await t.prefetch();
    const result = stage === 'stt' ? await t.transcribe(sttReq) : stage === 'tts' ? await t.speak(ttsReq) : await t.chat(chatReq);
    expect(result).toMatchObject({ servedBy: 'gateway', reason: 'low_confidence' });
  });

  it('honours minAvgLogprob', async () => {
    const { t } = tier({ policy: ALL_LOCAL, minAvgLogprob: -2 }, fakeModels({ stt: { transcribe: async () => ({ text: 'bom dia', avgLogprob: -1.6 }) } }));
    await t.prefetch();
    expect((await t.transcribe(sttReq)).servedBy).toBe('local');
  });

  it('does not fall back when the caller aborted', async () => {
    const { t, gateway } = tier({ policy: ALL_LOCAL }, fakeModels({ stt: { transcribe: async () => ({ text: '' }) } }));
    await t.prefetch();
    const controller = new AbortController();
    controller.abort();
    await expect(t.transcribe({ ...sttReq, signal: controller.signal })).rejects.toThrow();
    expect(gateway.transcribe).not.toHaveBeenCalled();
  });
});

describe('local tier: gateway-first', () => {
  const policy = { stt: 'gateway-first', tts: 'gateway-first', llm: 'gateway-first' } as const;

  it('uses the gateway while it answers, without loading anything', async () => {
    const { t, loads } = tier({ policy });
    expect(await t.chat(chatReq)).toMatchObject({ servedBy: 'gateway', reason: null });
    expect(loads.llm).toBe(0);
  });

  it('serves locally when the gateway fails, waiting for the model within the deadline', async () => {
    const { t } = tier({ policy, gateway: fakeGateway(true) });
    expect(await t.transcribe(sttReq)).toMatchObject({ servedBy: 'local', reason: 'gateway_error', text: 'olá' });
    expect(await t.chatStream(chatReq)).toMatchObject({ servedBy: 'local', reason: 'gateway_error' });
  });

  it('rethrows the gateway error when the local stage fails too', async () => {
    const { t } = tier({ policy, gateway: fakeGateway(true) }, fakeModels({ tts: { speak: async () => { throw new Error('onnx'); } } }));
    await expect(t.speak(ttsReq)).rejects.toThrow('gw down');
  });
});

describe('local tier: capability check', () => {
  const { models } = fakeModels();

  it('keeps a phone to TTS + STT on WASM: no WebGPU and over budget refuse the LLM', () => {
    const stages = admitStages(ALL_LOCAL, models, PHONE, MOBILE_BUDGET_MB);
    expect(stages.tts).toEqual({ local: true, device: 'wasm', memoryMb: 180, downloadMb: 95 });
    expect(stages.stt).toEqual({ local: true, device: 'wasm', memoryMb: 150, downloadMb: 80 });
    expect(stages.llm).toEqual({ local: false, reason: 'unsupported' });
    expect(admitStages(ALL_LOCAL, models, { ...PHONE, webgpu: true }, MOBILE_BUDGET_MB).llm).toEqual({ local: false, reason: 'over_budget' });
  });

  it('prefers WebGPU and drops to WASM when the WebGPU variant does not fit', () => {
    const stages = admitStages(ALL_LOCAL, models, DESKTOP, 600);
    expect(stages.tts).toMatchObject({ local: true, device: 'webgpu' });
    expect(stages.stt).toMatchObject({ local: true, device: 'wasm' });
    expect(stages.llm).toEqual({ local: false, reason: 'over_budget' });
    expect(admitStages(ALL_LOCAL, models, DESKTOP, 2048).llm).toMatchObject({ local: true, device: 'webgpu' });
  });

  it('refuses for policy, missing model and storage', () => {
    const stages = admitStages({ stt: 'local-first', tts: 'gateway-first' }, { stt: models.stt }, { ...DESKTOP, storageFreeMb: 100 }, 2048);
    expect(stages).toEqual({ stt: { local: false, reason: 'storage' }, tts: { local: false, reason: 'no_model' }, llm: { local: false, reason: 'policy' } });
  });

  it('uses the conservative mobile budget by default and sends refused stages to the gateway', async () => {
    const { t, gateway, loads } = tier({ policy: ALL_LOCAL, probe: async () => ({ ...PHONE, webgpu: true }) });
    expect((await t.admission()).budgetMb).toBe(MOBILE_BUDGET_MB);
    await t.prefetch();
    expect(await t.chat(chatReq)).toMatchObject({ servedBy: 'gateway', reason: 'refused' });
    expect(gateway.chat).toHaveBeenCalled();
    expect(loads).toEqual({ stt: 1, tts: 1, llm: 0 });
  });

  it('probes WebGPU, f16, mobile, memory and storage from the navigator', async () => {
    const caps = await probeDevice({
      gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']), info: { vendor: 'apple', architecture: 'metal-3' } }) },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)', deviceMemory: 4,
      storage: { estimate: async () => ({ quota: 2e9, usage: 5e8 }) },
    });
    expect(caps).toEqual({ webgpu: true, shaderF16: true, gpu: 'apple metal-3', mobile: true, deviceMemoryGb: 4, storageFreeMb: 1500 });
    expect(await probeDevice({ userAgent: 'Mozilla/5.0 (Macintosh)' })).toMatchObject({ webgpu: false, mobile: false, storageFreeMb: null });
  });
});

describe('local tier: telemetry and progress', () => {
  it('emits servedBy per call and the load time, without content', async () => {
    const progress = vi.fn();
    const { t, telemetry } = tier({ policy: { stt: 'local-first' }, onProgress: progress });
    await t.prefetch();
    await t.transcribe(sttReq);
    await t.chat(chatReq);
    const events = telemetry.emit.mock.calls;
    expect(events.find(([e]) => e === 'local.load')![1]).toMatchObject({ attrs: { stage: 'stt', model: 'fake-stt', device: 'webgpu', ok: true } });
    const calls = events.filter(([e]) => e === 'local.call').map(([, f]) => f.attrs);
    expect(calls).toEqual([
      { stage: 'stt', policy: 'local-first', served_by: 'local', reason: null, device: 'webgpu' },
      { stage: 'llm', policy: 'gateway-only', served_by: 'gateway', reason: null, device: null },
    ]);
    expect(JSON.stringify(events)).not.toContain('olá');
    expect(progress.mock.calls.map(([p]) => [p.status, p.progress])).toEqual([['loading', 0], ['loading', 0.5], ['ready', 1]]);
    expect(progress.mock.calls[2][0].loadMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed load and stops trying the stage locally', async () => {
    const telemetry = { emit: vi.fn() };
    const broken: LocalModel<SttEngine> = { id: 'broken', size: { wasm: { memoryMb: 1, downloadMb: 1 } }, load: vi.fn(async () => { throw new Error('404'); }) };
    const t = createLocalTier({ gateway: fakeGateway(), policy: { stt: 'local-first' }, models: { stt: broken }, probe: async () => PHONE, telemetry });
    await t.prefetch();
    expect(await t.transcribe(sttReq)).toMatchObject({ servedBy: 'gateway', reason: 'error' });
    expect(broken.load).toHaveBeenCalledTimes(1);
    expect(telemetry.emit).toHaveBeenCalledWith('local.load', expect.objectContaining({ level: 'warn', attrs: expect.objectContaining({ ok: false }) }));
  });
});

describe('local tier: engine adapters', () => {
  it('aggregates per-file download progress', () => {
    const seen: number[] = [];
    const cb = fileProgress(p => seen.push(p));
    cb({ status: 'initiate', file: 'a' });
    cb({ status: 'progress', file: 'a', loaded: 50, total: 100 });
    cb({ status: 'progress', file: 'b', loaded: 0, total: 300 });
    cb({ status: 'progress', file: 'b', loaded: 300, total: 300 });
    expect(seen).toEqual([0.5, 0.125, 0.875]);
  });

  it('measures the average log probability of the decoded tokens', () => {
    const meter = logprobMeter();
    meter.observe([[1n]], { data: [0, 0] });
    meter.observe([[1n, 0n]], { data: [Math.log(3), 0] });
    meter.observe([[1n, 0n, 0n]], { data: [0, 0] });
    expect(meter.average()).toBeCloseTo((Math.log(0.5) + Math.log(0.75)) / 2);
    expect(logprobMeter().average()).toBeUndefined();
  });

  it('turns espeak IPA into Kokoro phonemes: punctuation back, ties folded, nasals decomposed', () => {
    expect(espeakToKokoro('olˈa\ntˈudʊ bˈe\u200dɪŋ\n', 'Olá, tudo bem?')).toBe('olˈa, tˈudʊ bˈAŋ?');
    expect(espeakToKokoro('ũŋ pˈɐ̃\u200dʊ̃\n', 'Um pão')).toBe('u\u0303ŋ pˈɐ̃ʊ̃');
    expect(espeakToKokoro('ʒə- vˈa\nʃˈe\n', 'Sr. A, B!')).toBe('ʒə vˈa, ʃˈe!');
    expect(espeakToKokoro('a\nb\nc\n', `${'!'.repeat(50_000)}x y?! `)).toBe('a, b, c?!');
  });

  it('espeakPhonemizer: runs espeak with the voice, text after --, and maps its output', async () => {
    const factory = vi.fn(async () => ({ FS: { readFile: () => 'olˈa\n' } }));
    const phonemize = espeakPhonemizer(async () => factory);
    expect(await phonemize('-v en Olá!', 'pt-br')).toBe('olˈa!');
    expect(factory).toHaveBeenCalledWith({ arguments: ['--phonout', 'out', '-q', '-b', '1', '--ipa=3', '-v', 'pt-br', '--', '-v en Olá!'] });
  });

  it('kokoroTts: English voices use generate, pt-BR goes through the phonemizer, other voices are refused', async () => {
    const generate = vi.fn(async () => ({ audio: tone(), sampling_rate: 24_000 }));
    const fromIds = vi.fn(async () => ({ audio: tone(), sampling_rate: 24_000 }));
    const fromPretrained = vi.fn(async () => ({ generate, generate_from_ids: fromIds, tokenizer: (s: string) => ({ input_ids: `ids:${s}` }) }));
    const phonemize = vi.fn(async (text: string, voice: string) => `${voice}:${text}`);
    const model = kokoroTts({ loadKokoro: async () => ({ KokoroTTS: { from_pretrained: fromPretrained } }), phonemize });
    const engine = await model.load({ device: 'wasm', caps: PHONE, onProgress: () => {} });
    expect(fromPretrained).toHaveBeenCalledWith('onnx-community/Kokoro-82M-v1.0-ONNX', expect.objectContaining({ dtype: 'q8', device: 'wasm' }));
    await model.load({ device: 'webgpu', caps: DESKTOP, onProgress: () => {} });
    expect(fromPretrained.mock.calls.map(([, o]) => (o as { dtype: string }).dtype)).toEqual(['q8', 'fp32']);
    expect(fromIds).toHaveBeenCalledWith('ids:ə', { voice: 'af_heart' });
    await engine.speak('Hi', { voice: 'af_heart' });
    expect(generate).toHaveBeenCalledWith('Hi', { voice: 'af_heart', speed: undefined });
    await engine.speak('Olá', { voice: 'alloy', fallbackVoice: 'pf_dora', speed: 1.1 });
    expect(fromIds).toHaveBeenCalledWith('ids:pt-br:Olá', { voice: 'pf_dora', speed: 1.1 });
    await expect(engine.speak('x', { voice: 'alloy' })).rejects.toThrow('not a Kokoro voice');
    await expect(engine.speak('x', { voice: 'jf_alpha' })).rejects.toThrow('no phonemizer');
  });

  it('whisperStt: dtype per device, language passed, avg logprob from the logits processor', async () => {
    const pipeline = vi.fn(async () => async (_audio: Float32Array, opts: Record<string, unknown>) => {
      const [observe] = (opts.logits_processor ?? []) as Array<(ids: bigint[][], l: { data: number[] }) => unknown>;
      observe?.([[9n]], { data: [0, 0] });
      observe?.([[9n, 1n]], { data: [0, 0] });
      return { text: ' bom dia' };
    });
    const model = whisperStt({ loadTransformers: async () => ({ pipeline }) });
    const engine = await model.load({ device: 'webgpu', caps: DESKTOP, onProgress: () => {} });
    expect(pipeline).toHaveBeenCalledWith('automatic-speech-recognition', 'onnx-community/whisper-base',
      expect.objectContaining({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }));
    const out = await engine.transcribe(new Float32Array(10), { language: 'pt' });
    expect(out.text).toBe(' bom dia');
    expect(out.avgLogprob).toBeCloseTo(Math.log(0.5));
    const env = { backends: { onnx: { wasm: { proxy: false } } } };
    await whisperStt({ loadTransformers: async () => ({ pipeline, env }) }).load({ device: 'wasm', caps: PHONE, onProgress: () => {} });
    expect(env.backends.onnx.wasm.proxy).toBe(true);
    expect(pipeline).toHaveBeenLastCalledWith('automatic-speech-recognition', 'onnx-community/whisper-base', expect.objectContaining({ device: 'wasm', dtype: 'q8' }));
  });

  it('webLlm: f32 weights without shader-f16, and interrupts a generation the reader stopped', async () => {
    const interrupt = vi.fn();
    const create = vi.fn(async () => (async function* () {
      yield { choices: [{ delta: { content: 'Oi' } }] };
      yield { choices: [{ delta: { content: '!' } }] };
    })());
    const CreateMLCEngine = vi.fn(async () => ({ chat: { completions: { create } }, interruptGenerate: interrupt }));
    const engine = await webLlm({ loadWebLlm: async () => ({ CreateMLCEngine }) }).load({ device: 'webgpu', caps: { ...DESKTOP, shaderF16: false }, onProgress: () => {} });
    expect(CreateMLCEngine).toHaveBeenCalledWith('Qwen2.5-0.5B-Instruct-q4f32_1-MLC', expect.any(Object));
    expect(create).toHaveBeenCalledWith({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
    create.mockClear();
    const signal = new AbortController().signal;
    expect(await drain(engine.stream([{ role: 'user', content: 'Oi' }], { temperature: 0.3 }, signal))).toBe('Oi!');
    expect(create).toHaveBeenCalledWith({ temperature: 0.3, messages: [{ role: 'user', content: 'Oi' }], stream: true });
    expect(interrupt).not.toHaveBeenCalled();
    for await (const _ of engine.stream([], {}, signal)) break;
    expect(interrupt).toHaveBeenCalledTimes(1);
  });
});
