import { describe, it, expect } from 'vitest';
import {
  resolveProfile,
  mergeProfiles,
  VOICE_PROFILE,
  CHAT_PROFILE,
  STT_PROFILE,
  TTS_PROFILE,
  LLM_PROFILE,
  IMAGE_PROFILE,
  SYSTEM_PROFILE,
  SPEECH_TO_SPEECH_PROFILE,
  OPENAI_REALTIME_PROFILE,
} from '../../src/client/presets';

describe('resolveProfile()', () => {
  it('should return VOICE_PROFILE for preset "voice"', () => {
    const result = resolveProfile('voice');
    expect(result).toEqual(VOICE_PROFILE);
  });

  it('should return CHAT_PROFILE for preset "chat"', () => {
    const result = resolveProfile('chat');
    expect(result).toEqual(CHAT_PROFILE);
  });

  it('should return STT_PROFILE for preset "stt"', () => {
    const result = resolveProfile('stt');
    expect(result).toEqual(STT_PROFILE);
  });

  it('should throw for unknown preset name', () => {
    expect(() => resolveProfile('nonexistent' as any)).toThrow('Unknown profile preset: "nonexistent"');
  });

  it('should return a copy when given object without preset', () => {
    const input = { temperature: 0.5, maxTokens: 100 };
    const result = resolveProfile(input as any);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('should merge on top of preset base when object has preset field', () => {
    const result = resolveProfile({ preset: 'chat', temperature: 0.9 } as any);
    expect(result.preset).toBe('chat');
    expect(result.temperature).toBe(0.9);
    expect(result.llm).toEqual(CHAT_PROFILE.llm);
    expect(result.fallbackOptions).toBeDefined();
  });
});

describe('mergeProfiles()', () => {
  it('should let override keys replace base keys', () => {
    const base = { temperature: 0.3, maxTokens: 1000 };
    const override = { temperature: 0.9 };
    const result = mergeProfiles(base as any, override as any);
    expect(result.temperature).toBe(0.9);
    expect(result.maxTokens).toBe(1000);
  });

  it('should shallow merge fallbackOptions', () => {
    const base = { fallbackOptions: { timeoutMs: 30_000, retriesPerProvider: 1 } };
    const override = { fallbackOptions: { timeoutMs: 5_000 } };
    const result = mergeProfiles(base as any, override as any);
    expect(result.fallbackOptions!.timeoutMs).toBe(5_000);
    expect(result.fallbackOptions!.retriesPerProvider).toBe(1);
  });

  it('should merge keys with override winning', () => {
    const base = { keys: { openai: 'sk-old', groq: 'gsk-old' } };
    const override = { keys: { openai: 'sk-new' } };
    const result = mergeProfiles(base as any, override as any);
    expect(result.keys!.openai).toBe('sk-new');
    expect(result.keys!.groq).toBe('gsk-old');
  });
});

describe('preset structures', () => {
  const checks: [string, any, string[]][] = [
    ['VOICE_PROFILE', VOICE_PROFILE, ['stt', 'llm', 'tts']],
    ['CHAT_PROFILE', CHAT_PROFILE, ['llm']],
    ['STT_PROFILE', STT_PROFILE, ['stt']],
    ['TTS_PROFILE', TTS_PROFILE, ['tts']],
    ['LLM_PROFILE', LLM_PROFILE, ['llm']],
    ['IMAGE_PROFILE', IMAGE_PROFILE, ['image']],
    ['SYSTEM_PROFILE', SYSTEM_PROFILE, ['stt', 'llm']],
    ['SPEECH_TO_SPEECH_PROFILE', SPEECH_TO_SPEECH_PROFILE, ['stt', 'llm', 'tts']],
    ['OPENAI_REALTIME_PROFILE', OPENAI_REALTIME_PROFILE, ['realtime', 'omni', 'stt', 'llm', 'tts']],
  ];

  for (const [name, profile, fields] of checks) {
    it(`${name} has correct structure (${fields.join(', ')})`, () => {
      for (const field of fields) {
        expect(Array.isArray(profile[field]), `${name}.${field}`).toBe(true);
        expect(profile[field].length, `${name}.${field} should not be empty`).toBeGreaterThan(0);
      }
    });
  }
});
