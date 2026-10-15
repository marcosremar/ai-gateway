import { describe, expect, it } from 'vitest';
import { createFallbackProbe, fallbackLinks, probeLink, probeWav, type FallbackProbeResult } from '../../../src/telemetry/fallback-probe';
import { createOpsAlerts, type OpsAlert } from '../../../src/telemetry/ops-alerts';
import { opsAlertMail } from '../../../src/telemetry/alert-email';
import type { LLMProvider, STTProvider, TTSProvider } from '../../../src/gateway/providers/cloud/types';

const flush = () => new Promise(r => setTimeout(r, 0));

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function fakes(fail: { stt?: Error; chat?: Error; tts?: Error } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const stt = {
    providerId: 'openrouter', isConfigured: () => true, getModels: () => [],
    async transcribe(req) { calls.push({ stage: 'stt', model: req.model, bytes: (req.audio as Buffer).length }); if (fail.stt) throw fail.stt; return { text: '' }; },
  } as STTProvider;
  const chat = {
    providerId: 'openrouter', isConfigured: () => true,
    async chat(req) { calls.push({ stage: 'chat', model: req.model, maxTokens: req.maxTokens, extraBody: req.extraBody }); if (fail.chat) throw fail.chat; return { content: 'ok', model: req.model }; },
  } as LLMProvider;
  const tts = {
    providerId: 'openrouter', isConfigured: () => true, getModels: () => [], getVoices: () => [],
    async synthesize(req) { calls.push({ stage: 'tts', model: req.model, voice: req.voice }); if (fail.tts) throw fail.tts; return { audio: Buffer.from([1, 2]), contentType: 'audio/mpeg' }; },
    synthesizeStream: () => Promise.reject(new Error('unused')),
  } as TTSProvider;
  const gpu = { providerId: 'deployment:x-speech', isConfigured: () => true, async chat() { throw new Error('a GPU must never be probed'); } } as LLMProvider;
  const chains = { stt: { 'x-stt': [], 'y-stt': [] }, chat: { 'x-llm': [] }, tts: { 'x-tts': [] } };
  const routes = {
    stt: {
      'x-stt': [{ providerId: 'openrouter', provider: stt, model: 'openai/whisper-large-v3-turbo' }],
      'y-stt': [{ providerId: 'openrouter', provider: stt, model: 'openai/whisper-large-v3-turbo' }],
      'not-an-alias': [{ providerId: 'groq', provider: stt, model: 'whisper-large-v3' }],
    },
    chatRoutes: {
      'x-llm': [
        { providerId: 'deployment:x-speech', provider: gpu, model: 'Qwen' },
        { providerId: 'openrouter', provider: chat, model: 'google/gemini-2.5-flash-lite', extraBody: { reasoning: { enabled: false } } },
      ],
    },
    tts: {
      'x-tts': [
        { providerId: 'openrouter', provider: tts, model: 'microsoft/mai-voice-2.1-flash', voice: 'en-US-Harper', fixedVoice: true },
        { providerId: 'openrouter', provider: tts, model: 'microsoft/mai-voice-2.1-flash', voiceFor: () => 'pt-BR-Antonio' },
      ],
    },
  };
  return { calls, links: () => fallbackLinks(chains, routes) };
}

describe('fallback probe: every cloud link of the alias chains is called for real', () => {
  it('lists each cloud link once (aliases merged), skips deployments and models no app aliases, keeps voice and extraBody', () => {
    const links = fakes().links();
    expect(links.map(l => [l.stage, l.target, l.voice ?? null, l.aliases])).toEqual([
      ['stt', 'openrouter:openai/whisper-large-v3-turbo', null, ['x-stt', 'y-stt']],
      ['chat', 'openrouter:google/gemini-2.5-flash-lite', null, ['x-llm']],
      ['tts', 'openrouter:microsoft/mai-voice-2.1-flash', 'en-US-Harper', ['x-tts']],
      ['tts', 'openrouter:microsoft/mai-voice-2.1-flash', 'pt-BR-Antonio', ['x-tts']],
    ]);
    expect(links[1].extraBody).toEqual({ reasoning: { enabled: false } });
  });

  it('sends a minimal real request per link: a short WAV, a few chat tokens, two words in the link voice', async () => {
    const { calls, links } = fakes();
    const probe = createFallbackProbe({ env: {}, links, onResults: () => {} });
    const results = await probe.check();
    expect(results.every(r => r.ok)).toBe(true);
    expect(calls).toEqual([
      { stage: 'tts', model: 'microsoft/mai-voice-2.1-flash', voice: 'en-US-Harper' },
      { stage: 'tts', model: 'microsoft/mai-voice-2.1-flash', voice: 'pt-BR-Antonio' },
      { stage: 'stt', model: 'openai/whisper-large-v3-turbo', bytes: probeWav().length },
      { stage: 'chat', model: 'google/gemini-2.5-flash-lite', maxTokens: 16, extraBody: { reasoning: { enabled: false } } },
    ]);
    expect(results.map(r => [r.stage, r.content])).toEqual([['stt', null], ['chat', 'ok'], ['tts', 'mismatch'], ['tts', 'mismatch']]);
    expect(probe.snapshot()).toMatchObject({ intervalMinutes: 15, ok: 4, failing: [] });
    expect(probeWav().subarray(0, 4).toString()).toBe('RIFF');
  });

  it('a failure keeps status and code with the key redacted; a timeout is a failure too', async () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789';
    const [stt] = fakes({ stt: httpError(402, `no credit for ${key}`) }).links();
    const r = await probeLink(stt, { env: { OPENROUTER_API_KEY: key } });
    expect(r).toMatchObject({ ok: false, status: 402, code: 'credit', target: 'openrouter:openai/whisper-large-v3-turbo' });
    expect(r.error).not.toContain(key);
    const slow = { ...stt, provider: { ...stt.provider, transcribe: (req: { signal: AbortSignal }) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason))) } } as typeof stt;
    expect(await probeLink(slow, { timeoutMs: 10 })).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('failures become one grouped ops alert, a 402 also a credit alert; a recovery is logged', async () => {
    const sent: OpsAlert[] = [];
    const alerts = createOpsAlerts(a => { sent.push(a); }, () => Date.parse('2026-10-12T16:00:00Z'), 30 * 60_000, 0);
    const fail = { tts: httpError(500, 'upstream down'), chat: httpError(402, 'Payment required') };
    const { links } = fakes(fail);
    const logged: string[] = [];
    const probe = createFallbackProbe({ env: {}, links, onResults: (rs: FallbackProbeResult[]) => alerts.fromFallbackProbes(rs), log: m => logged.push(m) });
    await probe.check();
    await flush();
    expect(sent.map(a => a.event)).toEqual(['provider.credit_exhausted', 'fallback.probe_failed']);
    expect(sent[1].data).toMatchObject({ stage: 'chat, tts', count: 3 });
    expect(String(sent[1].data.items)).toContain('tts openrouter:microsoft/mai-voice-2.1-flash (en-US-Harper) [x-tts]: (5xx) upstream down');
    expect(opsAlertMail(sent[1])?.subject).toContain('reserva na nuvem falhou');
    expect(probe.snapshot().failing).toHaveLength(3);
    delete fail.tts; delete fail.chat;
    await probe.check();
    expect(logged.filter(m => m === 'fallback probe recovered')).toHaveLength(3);
  });

  it('FALLBACK_PROBE_MINUTES=0 turns it off', () => {
    let called = 0;
    const probe = createFallbackProbe({ env: { FALLBACK_PROBE_MINUTES: '0', FALLBACK_PROBE_DELAY_MS: '0' }, links: () => { called++; return []; }, onResults: () => {} });
    probe.start();
    probe.stop();
    expect(called).toBe(0);
  });
});

describe('fallback probe: the answer itself is checked, not only the HTTP status', () => {
  const wav = (amplitude: number) => {
    const pcm = probeWav();
    for (let i = 44; i + 1 < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 7) * amplitude), i);
    return pcm;
  };

  function chain(opts: { tts: () => { audio: Buffer; contentType: string; stream?: ReadableStream<Uint8Array> }; heard?: (bytes: number) => string; said?: string }) {
    const seen: number[] = [];
    const stt = { providerId: 'openrouter', isConfigured: () => true, getModels: () => [],
      async transcribe(req) { seen.push((req.audio as Buffer).length); return { text: opts.heard?.((req.audio as Buffer).length) ?? '' }; } } as STTProvider;
    const chat = { providerId: 'openrouter', isConfigured: () => true, async chat(req) { return { content: opts.said ?? 'ok', model: req.model }; } } as LLMProvider;
    const tts = { providerId: 'openrouter', isConfigured: () => true, getModels: () => [], getVoices: () => [],
      async synthesize() { return opts.tts(); }, synthesizeStream: () => Promise.reject(new Error('unused')) } as TTSProvider;
    const links = () => fallbackLinks({ stt: { s: [] }, chat: { c: [] }, tts: { t: [] } }, {
      stt: { s: [{ providerId: 'openrouter', provider: stt, model: 'whisper' }] },
      chatRoutes: { c: [{ providerId: 'openrouter', provider: chat, model: 'gemini' }] },
      tts: { t: [{ providerId: 'openrouter', provider: tts, model: 'kokoro', voice: 'pm_alex' }] },
    });
    return { seen, links };
  }

  it('feeds the speech of a good TTS link to the STT links and expects «bom dia» back', async () => {
    const speech = wav(4_000);
    const { seen, links } = chain({ tts: () => ({ audio: speech, contentType: 'audio/wav' }), heard: () => ' Bom dia.' });
    const results = await createFallbackProbe({ env: {}, links, onResults: () => {} }).check();
    expect(seen).toEqual([speech.length]);
    expect(results.map(r => [r.stage, r.ok, r.content])).toEqual([['stt', true, 'ok'], ['chat', true, 'ok'], ['tts', true, 'ok']]);
    expect(results.some(r => 'audio' in r)).toBe(false);
  });

  it('flags silence, a short clip, a wrong transcript and a chat that ignores the instruction, without failing the link', async () => {
    const silent = chain({ tts: () => ({ audio: wav(20), contentType: 'audio/wav' }), said: 'Sure! Here you go.' });
    const r1 = await createFallbackProbe({ env: {}, links: silent.links, onResults: () => {} }).check();
    expect(silent.seen).toEqual([probeWav().length]);
    expect(r1.find(r => r.stage === 'tts')).toMatchObject({ ok: true, content: 'mismatch', contentNote: expect.stringMatching(/silêncio/) });
    expect(r1.find(r => r.stage === 'chat')).toMatchObject({ ok: true, content: 'mismatch', contentNote: 'respondeu «Sure! Here you go.» em vez de «ok»' });
    expect(r1.find(r => r.stage === 'stt')).toMatchObject({ ok: true, content: null });
    const mp3 = chain({ tts: () => ({ audio: Buffer.alloc(4_000, 7), contentType: 'audio/mpeg' }), heard: () => 'Obrigado.' });
    const r2 = await createFallbackProbe({ env: {}, links: mp3.links, onResults: () => {} }).check();
    expect(r2.find(r => r.stage === 'stt')).toMatchObject({ ok: true, content: 'mismatch', contentNote: 'ouviu «Obrigado.» em vez de «bom dia»' });
    const short = chain({ tts: () => ({ audio: Buffer.alloc(300, 7), contentType: 'audio/mpeg' }) });
    const r3 = await createFallbackProbe({ env: {}, links: short.links, onResults: () => {} }).check();
    expect(r3.find(r => r.stage === 'tts')!.contentNote).toMatch(/curto demais/);
  });

  it('reads a streamed answer to check it, and FALLBACK_PROBE_CONTENT=enforce turns a mismatch into a failure', async () => {
    const body = wav(4_000);
    const stream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body.subarray(0, 1000)); c.enqueue(body.subarray(1000)); c.close(); } });
    const { links } = chain({ tts: () => ({ audio: Buffer.alloc(0), contentType: 'audio/wav', stream: stream() }), heard: () => 'bom dia', said: 'nope' });
    const results = await createFallbackProbe({ env: { FALLBACK_PROBE_CONTENT: 'enforce' }, links, onResults: () => {} }).check();
    expect(results.find(r => r.stage === 'tts')).toMatchObject({ ok: true, content: 'ok' });
    expect(results.find(r => r.stage === 'stt')).toMatchObject({ ok: true, content: 'ok' });
    expect(results.find(r => r.stage === 'chat')).toMatchObject({ ok: false, code: 'content', error: 'respondeu «nope» em vez de «ok»' });
  });
});
