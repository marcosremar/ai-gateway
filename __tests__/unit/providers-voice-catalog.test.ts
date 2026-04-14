import { describe, it, expect } from 'vitest';
import {
  VOICE_SLOTS,
  OPENAI_VOICE_CATALOG,
  KOKORO_VOICE_CATALOG,
  QWEN3_VOICE_CATALOG,
  MOSS_TTS_VOICE_CATALOG,
  MODAL_VOICE_CATALOG,
  SKYPILOT_VOICE_CATALOG,
  getAllVoiceCatalogs,
  getVoiceCatalog,
  getVoicesForProviderModel,
  getLanguagesFromCatalog,
  filterVoicesByLanguage,
  getDefaultVoiceMappings,
  resolveVoiceSlot,
} from '../../src/providers/voice-catalog';

describe('Voice Catalog', () => {
  describe('VOICE_SLOTS', () => {
    it('has 4 voice slots', () => {
      expect(VOICE_SLOTS).toHaveLength(4);
    });

    it('has expected slot ids', () => {
      const ids = VOICE_SLOTS.map(s => s.id);
      expect(ids).toContain('male1');
      expect(ids).toContain('male2');
      expect(ids).toContain('female1');
      expect(ids).toContain('female2');
    });
  });

  describe('Provider catalogs', () => {
    it('OpenAI catalog has correct providerId', () => {
      expect(OPENAI_VOICE_CATALOG.providerId).toBe('openai');
      expect(OPENAI_VOICE_CATALOG.models.length).toBeGreaterThan(0);
    });

    it('Kokoro catalog has voices', () => {
      expect(KOKORO_VOICE_CATALOG.models[0].voices.length).toBeGreaterThan(20);
    });

    it('Qwen3 catalog has voices', () => {
      expect(QWEN3_VOICE_CATALOG.providerId).toBe('qwen3');
      expect(QWEN3_VOICE_CATALOG.models[0].voices.length).toBeGreaterThan(0);
    });

    it('MOSS-TTS catalog has language-based voices', () => {
      expect(MOSS_TTS_VOICE_CATALOG.providerId).toBe('moss-tts');
      const voices = MOSS_TTS_VOICE_CATALOG.models[0].voices;
      expect(voices.some(v => v.language === 'pt')).toBe(true);
      expect(voices.some(v => v.language === 'en')).toBe(true);
    });

    it('Modal catalog combines MOSS + Kokoro + Qwen3', () => {
      expect(MODAL_VOICE_CATALOG.models.length).toBeGreaterThanOrEqual(3);
    });

    it('SkyPilot catalog combines Kokoro + Qwen3', () => {
      expect(SKYPILOT_VOICE_CATALOG.models.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getAllVoiceCatalogs', () => {
    it('returns array of catalogs', () => {
      const catalogs = getAllVoiceCatalogs();
      expect(catalogs.length).toBeGreaterThanOrEqual(4);
      const ids = catalogs.map(c => c.providerId);
      expect(ids).toContain('openai');
      expect(ids).toContain('kokoro');
    });
  });

  describe('getVoiceCatalog', () => {
    it('returns correct catalog for known providers', () => {
      expect(getVoiceCatalog('openai')).toBe(OPENAI_VOICE_CATALOG);
      expect(getVoiceCatalog('kokoro')).toBe(KOKORO_VOICE_CATALOG);
      expect(getVoiceCatalog('qwen3')).toBe(QWEN3_VOICE_CATALOG);
      expect(getVoiceCatalog('qwen3-tts')).toBe(QWEN3_VOICE_CATALOG);
      expect(getVoiceCatalog('moss-tts')).toBe(MOSS_TTS_VOICE_CATALOG);
      expect(getVoiceCatalog('moss')).toBe(MOSS_TTS_VOICE_CATALOG);
      expect(getVoiceCatalog('modal')).toBe(MODAL_VOICE_CATALOG);
      expect(getVoiceCatalog('skypilot')).toBe(SKYPILOT_VOICE_CATALOG);
    });

    it('returns undefined for unknown provider', () => {
      expect(getVoiceCatalog('unknown')).toBeUndefined();
    });
  });

  describe('getVoicesForProviderModel', () => {
    it('returns voices for known provider+model', () => {
      const voices = getVoicesForProviderModel('openai', 'tts-1');
      expect(voices.length).toBeGreaterThan(0);
    });

    it('returns empty for unknown provider', () => {
      expect(getVoicesForProviderModel('unknown', 'tts-1')).toEqual([]);
    });

    it('returns empty for unknown model', () => {
      expect(getVoicesForProviderModel('openai', 'unknown-model')).toEqual([]);
    });
  });

  describe('getLanguagesFromCatalog', () => {
    it('extracts unique languages from Kokoro catalog', () => {
      const langs = getLanguagesFromCatalog(KOKORO_VOICE_CATALOG);
      expect(langs).toContain('en-US');
      expect(langs).toContain('pt-BR');
      expect(langs).toContain('fr');
      expect(langs).toContain('ja');
    });

    it('returns sorted languages', () => {
      const langs = getLanguagesFromCatalog(KOKORO_VOICE_CATALOG);
      for (let i = 1; i < langs.length; i++) {
        expect(langs[i] >= langs[i - 1]).toBe(true);
      }
    });
  });

  describe('filterVoicesByLanguage', () => {
    it('returns all voices for empty language', () => {
      const voices = KOKORO_VOICE_CATALOG.models[0].voices;
      expect(filterVoicesByLanguage(voices, '')).toEqual(voices);
    });

    it('returns all voices for "all" language', () => {
      const voices = KOKORO_VOICE_CATALOG.models[0].voices;
      expect(filterVoicesByLanguage(voices, 'all')).toEqual(voices);
    });

    it('filters by specific language', () => {
      const voices = KOKORO_VOICE_CATALOG.models[0].voices;
      const filtered = filterVoicesByLanguage(voices, 'pt-BR');
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every(v => v.language === 'pt-BR' || v.language === 'multi')).toBe(true);
    });
  });

  describe('getDefaultVoiceMappings', () => {
    it('returns mappings for all providers and models', () => {
      const config = getDefaultVoiceMappings();
      expect(config.mappings.length).toBeGreaterThan(0);
      expect(config.defaultSlot).toBe('female1');
    });

    it('maps male1 and female1 slots', () => {
      const config = getDefaultVoiceMappings();
      for (const mapping of config.mappings) {
        expect(mapping.mapping['male1']).toBeTruthy();
        expect(mapping.mapping['female1']).toBeTruthy();
      }
    });
  });

  describe('resolveVoiceSlot', () => {
    it('resolves via explicit mapping', () => {
      const config = {
        mappings: [{
          providerId: 'openai',
          modelId: 'tts-1',
          mapping: { male1: 'echo', female1: 'nova' },
        }],
        defaultSlot: 'female1',
      };
      expect(resolveVoiceSlot(config, 'male1', 'openai', 'tts-1')).toBe('echo');
      expect(resolveVoiceSlot(config, 'female1', 'openai', 'tts-1')).toBe('nova');
    });

    it('falls back to gender matching when no explicit mapping', () => {
      const config = { mappings: [], defaultSlot: 'female1' };
      const voice = resolveVoiceSlot(config, 'male1', 'openai', 'tts-1');
      expect(voice).toBeTruthy();
    });

    it('returns undefined for unknown slot', () => {
      const config = { mappings: [], defaultSlot: 'female1' };
      expect(resolveVoiceSlot(config, 'nonexistent', 'openai', 'tts-1')).toBeUndefined();
    });
  });
});
