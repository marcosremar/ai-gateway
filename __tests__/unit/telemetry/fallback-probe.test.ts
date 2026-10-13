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
      { stage: 'stt', model: 'openai/whisper-large-v3-turbo', bytes: probeWav().length },
      { stage: 'chat', model: 'google/gemini-2.5-flash-lite', maxTokens: 16, extraBody: { reasoning: { enabled: false } } },
      { stage: 'tts', model: 'microsoft/mai-voice-2.1-flash', voice: 'en-US-Harper' },
      { stage: 'tts', model: 'microsoft/mai-voice-2.1-flash', voice: 'pt-BR-Antonio' },
    ]);
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
