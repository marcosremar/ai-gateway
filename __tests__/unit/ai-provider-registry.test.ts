import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIProviderRegistry } from '@ai-gateway/providers/registry';
import type { ProviderDescriptor, ProviderCapability, ModelInfo } from '@ai-gateway/providers/types';

function mockProvider(id: string, caps: ProviderCapability[] = ['stt', 'tts', 'llm']): ProviderDescriptor {
  return {
    id: id as any,
    name: `Mock ${id}`,
    description: `Mock provider ${id}`,
    capabilities: caps,
    stt: caps.includes('stt') ? {
      isConfigured: vi.fn().mockReturnValue(true),
      getModels: vi.fn().mockReturnValue([{ id: `${id}-stt-model`, name: 'STT', description: '', capability: 'stt' }]),
      transcribe: vi.fn(),
    } as any : undefined,
    tts: caps.includes('tts') ? {
      isConfigured: vi.fn().mockReturnValue(true),
      getModels: vi.fn().mockReturnValue([{ id: `${id}-tts-model`, name: 'TTS', description: '', capability: 'tts' }]),
      synthesize: vi.fn(),
    } as any : undefined,
    llm: caps.includes('llm') ? {
      isConfigured: vi.fn().mockReturnValue(true),
      chat: vi.fn(),
    } as any : undefined,
    realtime: caps.includes('realtime') ? {
      isConfigured: vi.fn().mockReturnValue(true),
      getModels: vi.fn().mockReturnValue([{ id: `${id}-rt-model`, name: 'Realtime', description: '', capability: 'realtime' }]),
    } as any : undefined,
    image: caps.includes('image') ? {
      isConfigured: vi.fn().mockReturnValue(true),
    } as any : undefined,
    omni: caps.includes('omni') ? {
      isConfigured: vi.fn().mockReturnValue(true),
      getModels: vi.fn().mockReturnValue([{ id: `${id}-omni-model`, name: 'Omni', description: '', capability: 'omni' }]),
    } as any : undefined,
  } as any;
}

describe('AIProviderRegistry', () => {
  let registry: AIProviderRegistry;

  beforeEach(() => {
    registry = new AIProviderRegistry();
  });

  // ── CRUD ──────────────────────────────────────────────────────────────

  describe('register / getProvider', () => {
    it('registers and retrieves provider', () => {
      const p = mockProvider('openai');
      registry.register(p);
      expect(registry.getProvider('openai')).toBe(p);
    });

    it('returns undefined for unknown provider', () => {
      expect(registry.getProvider('nonexistent' as any)).toBeUndefined();
    });

    it('listProviders returns all registered', () => {
      registry.register(mockProvider('openai'));
      registry.register(mockProvider('groq'));
      expect(registry.listProviders()).toHaveLength(2);
    });
  });

  // ── Capability getters ────────────────────────────────────────────────

  describe('capability getters', () => {
    it('getSTTProvider returns stt sub-provider', () => {
      registry.register(mockProvider('openai', ['stt']));
      const stt = registry.getSTTProvider('openai');
      expect(stt).toBeDefined();
      expect(stt.isConfigured()).toBe(true);
    });

    it('getTTSProvider returns tts sub-provider', () => {
      registry.register(mockProvider('openai', ['tts']));
      const tts = registry.getTTSProvider('openai');
      expect(tts).toBeDefined();
    });

    it('getLLMProvider returns llm sub-provider', () => {
      registry.register(mockProvider('openai', ['llm']));
      const llm = registry.getLLMProvider('openai');
      expect(llm).toBeDefined();
    });

    it('getRealtimeProvider returns realtime sub-provider', () => {
      registry.register(mockProvider('openai', ['realtime']));
      const rt = registry.getRealtimeProvider('openai');
      expect(rt).toBeDefined();
    });

    it('getImageProvider returns image sub-provider', () => {
      registry.register(mockProvider('fireworks', ['image']));
      const img = registry.getImageProvider('fireworks');
      expect(img).toBeDefined();
    });

    it('getOmniProvider returns omni sub-provider', () => {
      registry.register(mockProvider('openai', ['omni']));
      const omni = registry.getOmniProvider('openai');
      expect(omni).toBeDefined();
    });
  });

  // ── Missing provider / capability throws ──────────────────────────────

  describe('missing provider/capability throws', () => {
    it('getSTTProvider throws for unknown provider', () => {
      expect(() => registry.getSTTProvider('unknown' as any)).toThrow('not found');
    });

    it('getLLMProvider throws when provider lacks LLM', () => {
      registry.register(mockProvider('stt-only', ['stt']));
      expect(() => registry.getLLMProvider('stt-only' as any)).toThrow('does not support LLM');
    });

    it('getTTSProvider throws when provider lacks TTS', () => {
      registry.register(mockProvider('llm-only', ['llm']));
      expect(() => registry.getTTSProvider('llm-only' as any)).toThrow('does not support TTS');
    });
  });

  // ── listProvidersByCapability ──────────────────────────────────────────

  describe('listProvidersByCapability', () => {
    it('filters by capability', () => {
      registry.register(mockProvider('openai', ['stt', 'tts', 'llm']));
      registry.register(mockProvider('groq', ['stt', 'llm']));
      registry.register(mockProvider('fireworks', ['image']));

      const sttProviders = registry.listProvidersByCapability('stt');
      expect(sttProviders).toHaveLength(2);

      const imageProviders = registry.listProvidersByCapability('image');
      expect(imageProviders).toHaveLength(1);
    });

    it('returns empty for no matches', () => {
      registry.register(mockProvider('openai', ['stt']));
      expect(registry.listProvidersByCapability('image')).toHaveLength(0);
    });
  });

  // ── getAllModels ───────────────────────────────────────────────────────

  describe('getAllModels', () => {
    it('aggregates STT models across providers', () => {
      registry.register(mockProvider('openai', ['stt']));
      registry.register(mockProvider('groq', ['stt']));

      const models = registry.getAllModels('stt');
      expect(models).toHaveLength(2);
      expect(models[0].providerId).toBe('openai');
      expect(models[1].providerId).toBe('groq');
    });

    it('aggregates TTS models', () => {
      registry.register(mockProvider('openai', ['tts']));
      const models = registry.getAllModels('tts');
      expect(models).toHaveLength(1);
      expect(models[0].id).toContain('tts');
    });
  });

  // ── isProviderReady ───────────────────────────────────────────────────

  describe('isProviderReady', () => {
    it('returns true when provider is configured', () => {
      registry.register(mockProvider('openai', ['stt']));
      expect(registry.isProviderReady('openai', 'stt')).toBe(true);
    });

    it('returns false for unknown provider', () => {
      expect(registry.isProviderReady('unknown' as any, 'stt')).toBe(false);
    });

    it('returns false for unsupported capability', () => {
      registry.register(mockProvider('stt-only', ['stt']));
      expect(registry.isProviderReady('stt-only' as any, 'image')).toBe(false);
    });
  });

  // ── Overwrite ─────────────────────────────────────────────────────────

  describe('overwrite', () => {
    it('overwrites existing registration', () => {
      const p1 = mockProvider('openai', ['stt']);
      const p2 = mockProvider('openai', ['stt', 'tts']);
      registry.register(p1);
      registry.register(p2);
      expect(registry.getProvider('openai')).toBe(p2);
      expect(registry.listProviders()).toHaveLength(1);
    });
  });
});
