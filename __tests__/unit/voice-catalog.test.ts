import { describe, it, expect } from 'vitest';
import {
  getAllVoiceCatalogs,
  getVoiceCatalog,
  getVoicesForProviderModel,
  getLanguagesFromCatalog,
  filterVoicesByLanguage,
  getDefaultVoiceMappings,
  resolveVoiceSlot,
  VOICE_SLOTS,
} from '@ai-gateway/providers/voice-catalog';

describe('voice-catalog', () => {
  // ── getAllVoiceCatalogs ────────────────────────────────────────────────

  describe('getAllVoiceCatalogs', () => {
    it('returns all catalogs', () => {
      const catalogs = getAllVoiceCatalogs();
      expect(catalogs.length).toBeGreaterThanOrEqual(3);
      const ids = catalogs.map(c => c.providerId);
      expect(ids).toContain('openai');
    });
  });

  // ── getVoiceCatalog ───────────────────────────────────────────────────

  describe('getVoiceCatalog', () => {
    it('returns catalog by providerId', () => {
      const catalog = getVoiceCatalog('openai');
      expect(catalog).toBeDefined();
      expect(catalog!.providerId).toBe('openai');
    });

    it('handles aliases (qwen3/qwen3-tts)', () => {
      const c1 = getVoiceCatalog('qwen3');
      const c2 = getVoiceCatalog('qwen3-tts');
      expect(c1).toBeDefined();
      expect(c2).toBeDefined();
      expect(c1).toBe(c2);
    });

    it('returns undefined for unknown provider', () => {
      expect(getVoiceCatalog('nonexistent')).toBeUndefined();
    });

    it('returns modal catalog', () => {
      const catalog = getVoiceCatalog('modal');
      expect(catalog).toBeDefined();
      expect(catalog!.providerId).toBe('modal');
    });
  });

  // ── getVoicesForProviderModel ─────────────────────────────────────────

  describe('getVoicesForProviderModel', () => {
    it('returns voices for known provider/model', () => {
      const catalog = getVoiceCatalog('openai');
      expect(catalog?.models.length).toBeGreaterThan(0);

      const modelId = catalog.models[0].id;
      const voices = getVoicesForProviderModel('openai', modelId);
      expect(voices.length).toBeGreaterThan(0);
    });

    it('returns empty for unknown model', () => {
      const voices = getVoicesForProviderModel('openai', 'nonexistent-model');
      expect(voices).toEqual([]);
    });

    it('returns empty for unknown provider', () => {
      const voices = getVoicesForProviderModel('nonexistent', 'any');
      expect(voices).toEqual([]);
    });
  });

  // ── getLanguagesFromCatalog ───────────────────────────────────────────

  describe('getLanguagesFromCatalog', () => {
    it('returns unique sorted languages', () => {
      const catalog = getVoiceCatalog('kokoro');
      expect(catalog).toBeTruthy();

      const langs = getLanguagesFromCatalog(catalog);
      expect(langs.length).toBeGreaterThan(0);
      // Should be sorted
      const sorted = [...langs].sort();
      expect(langs).toEqual(sorted);
      // Should be unique
      expect(new Set(langs).size).toBe(langs.length);
    });
  });

  // ── filterVoicesByLanguage ────────────────────────────────────────────

  describe('filterVoicesByLanguage', () => {
    it('filters by specific language', () => {
      const catalog = getVoiceCatalog('kokoro');
      expect(catalog?.models.length).toBeGreaterThan(0);

      const allVoices = catalog.models[0].voices;
      const ptVoices = filterVoicesByLanguage(allVoices, 'pt-BR');
      expect(ptVoices.length).toBeGreaterThan(0);
      expect(ptVoices.every(v => v.language === 'pt-BR' || v.language === 'multi')).toBe(true);
    });

    it('"all" returns all voices', () => {
      const catalog = getVoiceCatalog('kokoro');
      expect(catalog?.models.length).toBeGreaterThan(0);

      const allVoices = catalog.models[0].voices;
      const filtered = filterVoicesByLanguage(allVoices, 'all');
      expect(filtered).toEqual(allVoices);
    });

    it('empty language returns all voices', () => {
      const catalog = getVoiceCatalog('kokoro');
      expect(catalog?.models.length).toBeGreaterThan(0);

      const allVoices = catalog.models[0].voices;
      const filtered = filterVoicesByLanguage(allVoices, '');
      expect(filtered).toEqual(allVoices);
    });
  });

  // ── getDefaultVoiceMappings ───────────────────────────────────────────

  describe('getDefaultVoiceMappings', () => {
    it('returns mappings with male1/male2/female1/female2', () => {
      const config = getDefaultVoiceMappings();
      expect(config.mappings.length).toBeGreaterThan(0);

      for (const mapping of config.mappings) {
        expect(mapping.mapping).toHaveProperty('male1');
        expect(mapping.mapping).toHaveProperty('female1');
      }
    });

    it('has defaultSlot', () => {
      const config = getDefaultVoiceMappings();
      expect(config.defaultSlot).toBe('female1');
    });
  });

  // ── resolveVoiceSlot ──────────────────────────────────────────────────

  describe('resolveVoiceSlot', () => {
    it('resolves from config mapping', () => {
      const config = getDefaultVoiceMappings();
      if (!config.mappings.length) return;

      const m = config.mappings[0];
      const voiceId = resolveVoiceSlot(config, 'female1', m.providerId, m.modelId);
      expect(voiceId).toBeDefined();
      expect(typeof voiceId).toBe('string');
    });

    it('falls back by gender when no mapping', () => {
      const emptyConfig = { mappings: [], defaultSlot: 'female1' };
      const catalog = getVoiceCatalog('openai');
      expect(catalog?.models.length).toBeGreaterThan(0);

      const modelId = catalog.models[0].id;
      const voiceId = resolveVoiceSlot(emptyConfig, 'female1', 'openai', modelId);
      // Should find some voice via gender fallback
      expect(voiceId).toBeDefined();
    });
  });

  // ── VOICE_SLOTS ───────────────────────────────────────────────────────

  describe('VOICE_SLOTS', () => {
    it('has 4 slots with correct structure', () => {
      expect(VOICE_SLOTS).toHaveLength(4);
      for (const slot of VOICE_SLOTS) {
        expect(slot).toHaveProperty('id');
        expect(slot).toHaveProperty('gender');
        expect(['male', 'female']).toContain(slot.gender);
      }
    });
  });

  // ── Catalog correctness ───────────────────────────────────────────────

  describe('catalog correctness', () => {
    it('each catalog has correct providerId', () => {
      const catalogs = getAllVoiceCatalogs();
      for (const catalog of catalogs) {
        expect(typeof catalog.providerId).toBe('string');
        expect(catalog.providerId.length).toBeGreaterThan(0);
        expect(catalog.models.length).toBeGreaterThan(0);
      }
    });

    it('each catalog has voices with id field', () => {
      const catalogs = getAllVoiceCatalogs();
      for (const catalog of catalogs) {
        for (const model of catalog.models) {
          for (const voice of model.voices) {
            expect(voice.id).toBeDefined();
            expect(typeof voice.id).toBe('string');
          }
        }
      }
    });
  });
});
