import { describe, expect, it } from 'vitest';
import { appForCall, appStageModels } from '../../../src/s2s/app-stage-models';
import { spendLimitsFromEnv } from '../../../src/deployments/spend-limits';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';

const parle = {
  stt: { 'parle-stt': [{ provider: 'deployment', deployment: 'parle-speech' }, { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' }] },
  chat: { 'parle-llm': [{ provider: 'deployment', deployment: 'parle-speech' }] },
  tts: { 'parle-tts': [{ provider: 'openrouter', model: 'x' }], 'parle-tts-gpu': [{ provider: 'deployment', deployment: 'parle-speech' }] },
} as never;

describe('composed s2s fallback models from the calling app', () => {
  it('takes the app aliases per stage, preferring the alias whose chain reaches the deployment', () => {
    expect(appStageModels(parle, 'parle-speech')).toEqual({ stt: 'parle-stt', chat: 'parle-llm', tts: 'parle-tts-gpu' });
    expect(appStageModels(parle)).toEqual({ stt: 'parle-stt', chat: 'parle-llm', tts: 'parle-tts' });
  });

  it('an app with no routes (or a stage without one) leaves that stage unset', () => {
    expect(appStageModels(undefined, 'x')).toEqual({});
    expect(appStageModels({ stt: { a: [] } } as never)).toEqual({ stt: 'a' });
  });

  it('the app is the deployment owner, else the caller', () => {
    expect(appForCall({ deploymentApp: 'parle', callerApp: 'other' })).toBe('parle');
    expect(appForCall({ deploymentApp: null, callerApp: 'parle' })).toBe('parle');
    expect(appForCall({ deploymentApp: undefined, callerApp: undefined })).toBeNull();
  });
});

describe('spend limits from env', () => {
  it('defaults: 8 stopped, 6 €/h, parked 72 h', () => {
    expect(spendLimitsFromEnv({})).toEqual({ maxStoppedReplicas: 8, maxEurPerHour: 6, parkedMaxMs: 72 * 3_600_000 });
  });
  it('reads the three variables; 0 turns the € ceiling and the park limit off; junk falls back', () => {
    expect(spendLimitsFromEnv({ DEPLOYMENTS_MAX_STOPPED: '3', DEPLOYMENTS_MAX_EUR_PER_HOUR: '0', DEPLOYMENTS_PARKED_MAX_HOURS: '0' }))
      .toEqual({ maxStoppedReplicas: 3, maxEurPerHour: 0, parkedMaxMs: 0 });
    expect(spendLimitsFromEnv({ DEPLOYMENTS_MAX_EUR_PER_HOUR: 'abc', DEPLOYMENTS_MAX_STOPPED: '-1' }))
      .toMatchObject({ maxStoppedReplicas: 8, maxEurPerHour: 6 });
  });
});

describe('speech-stack profile', () => {
  it('adds a replica at 6 turns in flight (QA 2026-10-06: first-audio p95 < 3 s up to 5–8 per L40S)', () => {
    expect(BUILTIN_PROFILES.find(p => p.name === 'speech-stack')!.spec.targetInflightPerReplica).toBe(6);
  });
});
