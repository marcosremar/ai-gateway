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
} from '@ai-gateway/client/presets';
import type { AIProfile } from '@ai-gateway/client/types';

describe('client-presets', () => {
  // ── Preset structure ──────────────────────────────────────────────────

  describe('preset structure', () => {
    const presets = [
      { name: 'VOICE', profile: VOICE_PROFILE },
      { name: 'CHAT', profile: CHAT_PROFILE },
      { name: 'STT', profile: STT_PROFILE },
      { name: 'TTS', profile: TTS_PROFILE },
      { name: 'LLM', profile: LLM_PROFILE },
      { name: 'IMAGE', profile: IMAGE_PROFILE },
      { name: 'SYSTEM', profile: SYSTEM_PROFILE },
    ];

    it('all 7 presets have expected fields', () => {
      for (const { name, profile } of presets) {
        expect(profile.preset, `${name} preset`).toBeDefined();
        expect(profile.fallbackOptions, `${name} fallbackOptions`).toBeDefined();
      }
    });

    it('voice profile has stt, llm, tts chains', () => {
      expect(VOICE_PROFILE.stt!.length).toBeGreaterThan(0);
      expect(VOICE_PROFILE.llm!.length).toBeGreaterThan(0);
      expect(VOICE_PROFILE.tts!.length).toBeGreaterThan(0);
      expect(VOICE_PROFILE.voice).toBe('coral');
    });

    it('image profile has image chain and dimensions', () => {
      expect(IMAGE_PROFILE.image!.length).toBeGreaterThan(0);
      expect(IMAGE_PROFILE.imageWidth).toBe(1280);
      expect(IMAGE_PROFILE.imageHeight).toBe(720);
    });
  });

  // ── resolveProfile ────────────────────────────────────────────────────

  describe('resolveProfile', () => {
    it('resolves string preset name', () => {
      const profile = resolveProfile('voice');
      expect(profile.preset).toBe('voice');
      expect(profile.stt!.length).toBeGreaterThan(0);
    });

    it('throws for unknown preset name', () => {
      expect(() => resolveProfile('nonexistent' as any)).toThrow('Unknown profile preset');
    });

    it('copies object when no preset field', () => {
      const input: AIProfile = { temperature: 0.5, maxTokens: 100 };
      const result = resolveProfile(input);
      expect(result.temperature).toBe(0.5);
      expect(result.maxTokens).toBe(100);
      // Should be a copy
      expect(result).not.toBe(input);
    });

    it('merges object with preset base', () => {
      const input: AIProfile = { preset: 'voice', temperature: 0.7 };
      const result = resolveProfile(input);
      // Should have voice preset's stt chain
      expect(result.stt!.length).toBeGreaterThan(0);
      // Should have the override
      expect(result.temperature).toBe(0.7);
    });

    it('throws for unknown preset in object', () => {
      expect(() => resolveProfile({ preset: 'bogus' as any })).toThrow('Unknown profile preset');
    });
  });

  // ── mergeProfiles ─────────────────────────────────────────────────────

  describe('mergeProfiles', () => {
    it('override wins for scalar fields', () => {
      const base: AIProfile = { temperature: 0.5, voice: 'alloy' };
      const override: AIProfile = { temperature: 0.9 };
      const result = mergeProfiles(base, override);
      expect(result.temperature).toBe(0.9);
      expect(result.voice).toBe('alloy');
    });

    it('arrays are replaced entirely', () => {
      const base: AIProfile = { stt: [{ provider: 'groq', model: 'whisper' }] };
      const override: AIProfile = { stt: [{ provider: 'openai', model: 'whisper' }] };
      const result = mergeProfiles(base, override);
      expect(result.stt).toHaveLength(1);
      expect(result.stt![0].provider).toBe('openai');
    });

    it('keys are merged (override wins per key)', () => {
      const base: AIProfile = { keys: { openai: 'key-a', groq: 'key-b' } };
      const override: AIProfile = { keys: { openai: 'key-new' } };
      const result = mergeProfiles(base, override);
      expect(result.keys!.openai).toBe('key-new');
      expect(result.keys!.groq).toBe('key-b');
    });

    it('fallbackOptions are shallow-merged', () => {
      const base: AIProfile = { fallbackOptions: { timeoutMs: 5000, retriesPerProvider: 0 } };
      const override: AIProfile = { fallbackOptions: { timeoutMs: 10000 } };
      const result = mergeProfiles(base, override);
      expect(result.fallbackOptions!.timeoutMs).toBe(10000);
      expect(result.fallbackOptions!.retriesPerProvider).toBe(0);
    });
  });

  // ── Immutability ──────────────────────────────────────────────────────

  describe('immutability', () => {
    it('resolveProfile does not mutate original preset', () => {
      const originalStt = [...VOICE_PROFILE.stt!];
      resolveProfile('voice');
      expect(VOICE_PROFILE.stt).toEqual(originalStt);
    });

    it('mergeProfiles does not mutate inputs', () => {
      const base: AIProfile = { temperature: 0.5, keys: { openai: 'a' } };
      const override: AIProfile = { temperature: 0.9, keys: { groq: 'b' } };
      const baseCopy = { ...base, keys: { ...base.keys } };
      mergeProfiles(base, override);
      expect(base.temperature).toBe(baseCopy.temperature);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty object resolved correctly', () => {
      const result = resolveProfile({});
      expect(result).toEqual({});
    });

    it('merge with no keys or fallbackOptions', () => {
      const base: AIProfile = { temperature: 1 };
      const override: AIProfile = { voice: 'nova' };
      const result = mergeProfiles(base, override);
      expect(result.keys).toBeUndefined();
      expect(result.fallbackOptions).toBeUndefined();
    });
  });
});
