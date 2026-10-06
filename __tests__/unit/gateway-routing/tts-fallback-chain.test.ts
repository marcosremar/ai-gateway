/**
 * parle TTS chain: deployment → OpenRouter Qwen-Audio (stock voice by gender) → OpenRouter Kokoro. Qwen-Audio refused
 * by the account's data policy (ZDR) is taken out of the chain after the first refusal, without opening the breaker
 * shared with Kokoro, and /health says why. One-GPU mode: without TTS_DEPLOYMENT, TTS goes to the speech deployment.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildServeProviders, ttsDeploymentOf, type ServeInstances } from '../../../src/config/serve-providers';
import { stageChainsReport } from '../../../src/config/stage-chains';
import { genderOfVoice, voiceForGender, KOKORO_VOICES, QWEN_AUDIO_VOICES } from '../../../src/config/tts-fallback-voices';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import type { TTSRequest } from '../../../src/gateway/providers/cloud/types';
import { AccountPolicyGuards, isAccountPolicyRefusal } from '../../../src/gateway/proxy/account-policy-guard';
import { handleAudioSpeech } from '../../../src/gateway/proxy/routes/audio-speech';
import type { ProxyRequest } from '../../../src/gateway/proxy/types';

const ZDR_ERROR = Object.assign(new Error('404 No endpoints found matching your data policy (Zero data retention). ZDR violation'), { status: 404 });

function fakeOpenRouterTTS(onCall: (req: TTSRequest) => void, refuse: (model: string) => boolean) {
  return {
    providerId: 'openrouter', getModels: () => [], getVoices: () => [], isConfigured: () => true,
    synthesizeStream: vi.fn(),
    synthesize: vi.fn(async (req: TTSRequest) => {
      onCall(req);
      if (refuse(req.model)) throw ZDR_ERROR;
      return { audio: Buffer.from([1, 2, 3]), contentType: 'audio/mpeg' };
    }),
  };
}

const coldDeployment = {
  providerId: 'self-hosted', getModels: () => [], getVoices: () => [], isConfigured: () => true, synthesizeStream: vi.fn(),
  synthesize: vi.fn(async () => { throw Object.assign(new Error("deployment 'parle-speech': replicas are starting"), { status: 503, gatewayCode: 'cold', skipRetry: true }); }),
};

function setup(opts: { refuseQwen: boolean; env?: Record<string, string>; speechConfigured?: boolean }) {
  const calls: TTSRequest[] = [];
  const openrouter = fakeOpenRouterTTS(r => calls.push(r), m => opts.refuseQwen && m.startsWith('qwen/'));
  const p = { providerId: 'x', isConfigured: () => false } as never;
  const instances: ServeInstances = { chat: { openrouter: p }, stt: { openrouter: p }, tts: { openrouter: openrouter as never } };
  const guards = new AccountPolicyGuards();
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 });
  const built = buildServeProviders({
    instances, openrouter: { state: 'valid' }, env: opts.env ?? {}, policyGuards: guards,
    speechDeploymentConfigured: opts.speechConfigured ?? true,
    deploymentProvider: (stage) => (stage === 'tts' ? coldDeployment : p) as never,
  });
  const speak = (body: Record<string, unknown>) => handleAudioSpeech(
    { method: 'POST', url: '/v1/audio/speech', headers: {}, body, rawBody: Buffer.alloc(0) } as ProxyRequest,
    built.providers.tts!, built.providers.unavailable?.tts, breakers,
  );
  return { built, calls, openrouter, guards, breakers, speak };
}

describe('one-GPU mode', () => {
  it('without TTS_DEPLOYMENT and with the speech deployment configured, TTS goes to the speech deployment', () => {
    expect(ttsDeploymentOf({}, { speechConfigured: true })).toEqual({ name: 'parle-speech', mode: 'one-gpu' });
    expect(ttsDeploymentOf({ SPEECH_DEPLOYMENT: 'speech-x' }, { speechConfigured: true })).toEqual({ name: 'speech-x', mode: 'one-gpu' });
    const { built } = setup({ refuseQwen: false });
    expect(built.providers.tts?.['parle-tts']?.[0].providerId).toBe('deployment:parle-speech');
    expect(built.providers.stt?.['parle-stt']?.[0].providerId).toBe('deployment:parle-speech');
  });

  it('TTS_DEPLOYMENT set keeps the dedicated deployment (parle-qwen-tts)', () => {
    expect(ttsDeploymentOf({ TTS_DEPLOYMENT: 'parle-qwen-tts' }, { speechConfigured: true })).toEqual({ name: 'parle-qwen-tts', mode: 'dedicated' });
    const { built } = setup({ refuseQwen: false, env: { TTS_DEPLOYMENT: 'parle-qwen-tts' } });
    expect(built.providers.tts?.['parle-tts']?.[0].providerId).toBe('deployment:parle-qwen-tts');
  });

  it('no speech deployment and no TTS_DEPLOYMENT: legacy default parle-qwen-tts', () => {
    expect(ttsDeploymentOf({}, { speechConfigured: false })).toEqual({ name: 'parle-qwen-tts', mode: 'legacy-default' });
  });
});

describe('fallback voices by gender', () => {
  it('reads the gender from the cast table, the slug, then the Kokoro fallback_voice', () => {
    expect(genderOfVoice({ voice: 'pt-PT-1baab6' })).toBe('masculine');
    expect(genderOfVoice({ voice: 'pt-PT-2537db' })).toBe('feminine');
    expect(genderOfVoice({ voice: 'br-m-99' })).toBe('masculine');
    expect(genderOfVoice({ voice: 'rafa', fallbackVoice: 'pm_alex' })).toBe('masculine');
    expect(genderOfVoice({ voice: 'unknown' })).toBe('feminine');
  });

  it('Qwen-Audio gets Cherry/Ethan; Kokoro keeps the client fallback_voice, else pf_dora/pm_alex', () => {
    expect(voiceForGender(QWEN_AUDIO_VOICES)({ voice: 'br-m-04', fallbackVoice: 'pm_santa' })).toBe('Ethan');
    expect(voiceForGender(QWEN_AUDIO_VOICES)({ voice: 'br-f-01' })).toBe('Cherry');
    expect(voiceForGender(KOKORO_VOICES, true)({ voice: 'br-m-04', fallbackVoice: 'pm_santa' })).toBe('pm_santa');
    expect(voiceForGender(KOKORO_VOICES, true)({ voice: 'br-m-04' })).toBe('pm_alex');
    expect(voiceForGender(KOKORO_VOICES, true)({ voice: 'pt-PT-2e0907' })).toBe('pf_dora');
  });
});

describe('TTS chain: deployment → Qwen-Audio → Kokoro', () => {
  it('cold deployment: Qwen-Audio answers with the stock voice of the same gender', async () => {
    const { speak, calls } = setup({ refuseQwen: false });
    const res = await speak({ model: 'parle-tts', input: 'Olá', voice: 'br-m-04', fallback_voice: 'pm_santa', response_format: 'wav' });
    expect(res.status).toBe(200);
    expect(res.headers?.['X-Gateway-Provider']).toBe('openrouter:qwen/qwen-audio-3.0-tts-flash');
    expect(res.headers?.['X-Gateway-Fallback']).toBe('cold');
    expect(calls.map(c => `${c.model}/${c.voice}`)).toEqual(['qwen/qwen-audio-3.0-tts-flash/Ethan']);
  });

  it('ZDR refusal: Kokoro answers at once; next requests skip Qwen-Audio without calling it; breaker stays closed', async () => {
    const { speak, calls, breakers, built } = setup({ refuseQwen: true });
    const first = await speak({ model: 'parle-tts', input: 'Olá', voice: 'br-f-01', fallback_voice: 'pf_dora', response_format: 'wav' });
    expect(first.status).toBe(200);
    expect(first.headers?.['X-Gateway-Provider']).toBe('openrouter:hexgrad/kokoro-82m');
    expect(calls.map(c => `${c.model}/${c.voice}`)).toEqual(['qwen/qwen-audio-3.0-tts-flash/Cherry', 'hexgrad/kokoro-82m/pf_dora']);

    calls.length = 0;
    for (let i = 0; i < 6; i++) {
      const res = await speak({ model: 'parle-tts', input: 'Olá', voice: 'br-m-04', fallback_voice: 'pm_santa', response_format: 'wav' });
      expect(res.headers?.['X-Gateway-Provider']).toBe('openrouter:hexgrad/kokoro-82m');
    }
    expect(calls.every(c => c.model === 'hexgrad/kokoro-82m' && c.voice === 'pm_santa')).toBe(true);
    expect(calls).toHaveLength(6);
    expect(breakers.get('openrouter').isOpen()).toBe(false);

    const { stages } = stageChainsReport(built.chains, { deploymentStatus: () => 'scaled-to-zero', breakers });
    const links = stages.tts['parle-tts'].links;
    expect(links.map(l => l.state)).toEqual(['cold', 'blocked', 'ready']);
    expect(links[1].reason).toMatch(/data policy \(ZDR\)/);
    expect(stages.tts['parle-tts'].serving).toBe('openrouter:hexgrad/kokoro-82m');
  });

  it('the block is lifted by time and by a key change', () => {
    let now = 0;
    const guards = new AccountPolicyGuards(() => now);
    const g = guards.get('openrouter', 'qwen/qwen-audio-3.0-tts-flash');
    g.observe(ZDR_ERROR);
    expect(g.reason()).toMatch(/ZDR/);
    now += 31 * 60_000;
    expect(g.reason()).toBeNull();
    g.observe(ZDR_ERROR);
    guards.resetProvider('openrouter');
    expect(g.reason()).toBeNull();
  });

  it('only policy refusals block (a 5xx or a plain 404 does not)', () => {
    expect(isAccountPolicyRefusal(ZDR_ERROR)).toBe(true);
    expect(isAccountPolicyRefusal(Object.assign(new Error('502 upstream'), { status: 502 }))).toBe(false);
    expect(isAccountPolicyRefusal(new Error('404 model not found'))).toBe(false);
  });
});
