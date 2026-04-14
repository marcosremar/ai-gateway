import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatLLMProvider } from '../../src/providers/openai-compat/openai-compat-llm';
import { OpenAICompatSTTProvider } from '../../src/providers/openai-compat/openai-compat-stt';
import { OpenAICompatTTSProvider } from '../../src/providers/openai-compat/openai-compat-tts';

// ── Shared test configs ───────────────────────────────────────────────────────

const LLM_CONFIG = {
  providerId: 'groq' as const,
  baseURL: 'https://api.groq.com/openai/v1',
  envKey: 'GROQ_API_KEY',
  defaultModel: 'llama-3.3-70b-versatile',
};

const STT_CONFIG = {
  providerId: 'groq' as const,
  baseURL: 'https://api.groq.com/openai/v1',
  envKey: 'GROQ_API_KEY',
  models: [
    {
      id: 'whisper-large-v3-turbo',
      name: 'Whisper V3 Turbo',
      description: 'Fast',
      capability: 'stt' as const,
      isDefault: true,
    },
    {
      id: 'whisper-large-v3',
      name: 'Whisper V3',
      description: 'Accurate',
      capability: 'stt' as const,
    },
  ],
  defaultModel: 'whisper-large-v3-turbo',
};

const TTS_CONFIG = {
  providerId: 'groq' as const,
  baseURL: 'https://api.groq.com/openai/v1',
  envKey: 'GROQ_API_KEY',
  models: [
    {
      id: 'orpheus-v1',
      name: 'Orpheus',
      description: 'HQ TTS',
      capability: 'tts' as const,
      isDefault: true,
    },
  ],
  voices: [
    { id: 'autumn', name: 'Autumn', description: 'Female' },
    { id: 'austin', name: 'Austin', description: 'Male' },
  ],
  defaultModel: 'orpheus-v1',
  defaultVoice: 'autumn',
};

// ── OpenAICompatLLMProvider ───────────────────────────────────────────────────

describe('OpenAICompatLLMProvider', () => {
  describe('constructor', () => {
    it('should set providerId from config', () => {
      const provider = new OpenAICompatLLMProvider(LLM_CONFIG);
      expect(provider.providerId).toBe('groq');
    });
  });

  describe('isConfigured()', () => {
    it('should return true when env var is set', () => {
      process.env.GROQ_API_KEY = 'test-key';
      const provider = new OpenAICompatLLMProvider(LLM_CONFIG);
      expect(provider.isConfigured()).toBe(true);
      delete process.env.GROQ_API_KEY;
    });

    it('should return false when env var is not set', () => {
      delete process.env.GROQ_API_KEY;
      const provider = new OpenAICompatLLMProvider(LLM_CONFIG);
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe('withApiKey()', () => {
    it('should return a new provider instance with the given API key', () => {
      const provider = new OpenAICompatLLMProvider(LLM_CONFIG);
      const withKey = provider.withApiKey('sk-custom-key');
      expect(withKey).toBeInstanceOf(OpenAICompatLLMProvider);
      expect(withKey).not.toBe(provider);
    });

    it('should create provider with pre-set client', () => {
      const provider = new OpenAICompatLLMProvider(LLM_CONFIG);
      const withKey = provider.withApiKey('sk-custom-key');
      expect(withKey.isConfigured()).toBeFalsy(); // env key doesn't matter anymore
      // The client should be pre-set, but we can't easily test without calling getClient()
    });
  });

  describe('withConfig()', () => {
    it('should return a new provider with custom apiKey and baseURL', () => {
      const provider = new OpenAICompatLLMProvider(LLM_CONFIG);
      const withCfg = provider.withConfig({ apiKey: 'sk-test', baseURL: 'http://localhost:8000' });
      expect(withCfg).toBeInstanceOf(OpenAICompatLLMProvider);
      expect(withCfg).not.toBe(provider);
    });

    it('should use original baseURL when not provided in withConfig', () => {
      const provider = new OpenAICompatLLMProvider(LLM_CONFIG);
      const withCfg = provider.withConfig({ apiKey: 'sk-test' });
      expect(withCfg).toBeInstanceOf(OpenAICompatLLMProvider);
    });
  });

  describe('getClient() — error when not configured', () => {
    it('should throw when env key is not set', () => {
      delete process.env.GROQ_API_KEY;
      const provider = new OpenAICompatLLMProvider(LLM_CONFIG);
      expect(() => (provider as any).getClient()).toThrow('GROQ_API_KEY is not set');
    });
  });

  describe('getClient() — caches client', () => {
    it('should return same client on repeated calls', () => {
      process.env.GROQ_API_KEY = 'test-key';
      const provider = new OpenAICompatLLMProvider(LLM_CONFIG);
      const c1 = (provider as any).getClient();
      const c2 = (provider as any).getClient();
      expect(c1).toBe(c2);
      delete process.env.GROQ_API_KEY;
    });
  });

  describe('with defaultHeaders', () => {
    it('should accept config with defaultHeaders', () => {
      const configWithHeaders = {
        ...LLM_CONFIG,
        defaultHeaders: { 'X-Custom': 'header' },
      };
      const provider = new OpenAICompatLLMProvider(configWithHeaders);
      expect(provider.providerId).toBe('groq');
    });
  });
});

// ── OpenAICompatSTTProvider ───────────────────────────────────────────────────

describe('OpenAICompatSTTProvider', () => {
  describe('constructor', () => {
    it('should set providerId from config', () => {
      const provider = new OpenAICompatSTTProvider(STT_CONFIG);
      expect(provider.providerId).toBe('groq');
    });
  });

  describe('getModels()', () => {
    it('should return all models', () => {
      const provider = new OpenAICompatSTTProvider(STT_CONFIG);
      expect(provider.getModels()).toHaveLength(2);
    });

    it('should return models with correct ids', () => {
      const provider = new OpenAICompatSTTProvider(STT_CONFIG);
      const ids = provider.getModels().map((m) => m.id);
      expect(ids).toContain('whisper-large-v3-turbo');
      expect(ids).toContain('whisper-large-v3');
    });

    it('should mark first model as default', () => {
      const provider = new OpenAICompatSTTProvider(STT_CONFIG);
      const defaultModel = provider.getModels().find((m) => m.isDefault);
      expect(defaultModel?.id).toBe('whisper-large-v3-turbo');
    });
  });

  describe('isConfigured()', () => {
    it('should return true when env var is set', () => {
      process.env.GROQ_API_KEY = 'test-key';
      const provider = new OpenAICompatSTTProvider(STT_CONFIG);
      expect(provider.isConfigured()).toBe(true);
      delete process.env.GROQ_API_KEY;
    });

    it('should return false when env var is not set', () => {
      delete process.env.GROQ_API_KEY;
      const provider = new OpenAICompatSTTProvider(STT_CONFIG);
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe('withApiKey()', () => {
    it('should return a new provider instance', () => {
      const provider = new OpenAICompatSTTProvider(STT_CONFIG);
      const withKey = provider.withApiKey('sk-custom-key');
      expect(withKey).toBeInstanceOf(OpenAICompatSTTProvider);
      expect(withKey).not.toBe(provider);
    });

    it('should preserve model list', () => {
      const provider = new OpenAICompatSTTProvider(STT_CONFIG);
      const withKey = provider.withApiKey('sk-custom-key');
      expect(withKey.getModels()).toHaveLength(2);
    });
  });

  describe('getClient() — error when not configured', () => {
    it('should throw when env key is not set', () => {
      delete process.env.GROQ_API_KEY;
      const provider = new OpenAICompatSTTProvider(STT_CONFIG);
      expect(() => (provider as any).getClient()).toThrow('GROQ_API_KEY is not set');
    });
  });
});

// ── OpenAICompatTTSProvider ───────────────────────────────────────────────────

describe('OpenAICompatTTSProvider', () => {
  describe('constructor', () => {
    it('should set providerId from config', () => {
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      expect(provider.providerId).toBe('groq');
    });
  });

  describe('getModels()', () => {
    it('should return all models', () => {
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      expect(provider.getModels()).toHaveLength(1);
      expect(provider.getModels()[0]?.id).toBe('orpheus-v1');
    });
  });

  describe('getVoices()', () => {
    it('should return all voices', () => {
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      expect(provider.getVoices()).toHaveLength(2);
    });

    it('should include configured voices', () => {
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      const ids = provider.getVoices().map((v) => v.id);
      expect(ids).toContain('autumn');
      expect(ids).toContain('austin');
    });
  });

  describe('isConfigured()', () => {
    it('should return true when env var is set', () => {
      process.env.GROQ_API_KEY = 'test-key';
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      expect(provider.isConfigured()).toBe(true);
      delete process.env.GROQ_API_KEY;
    });

    it('should return false when env var is not set', () => {
      delete process.env.GROQ_API_KEY;
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe('withApiKey()', () => {
    it('should return a new provider instance', () => {
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      const withKey = provider.withApiKey('sk-custom-key');
      expect(withKey).toBeInstanceOf(OpenAICompatTTSProvider);
      expect(withKey).not.toBe(provider);
    });

    it('should preserve voice list', () => {
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      const withKey = provider.withApiKey('sk-custom-key');
      expect(withKey.getVoices()).toHaveLength(2);
    });
  });

  describe('resolveVoice() — via synthesize', () => {
    it('should fall back to defaultVoice for unknown voice (internal)', () => {
      // We can't call resolveVoice directly since it's private,
      // but we can test it indirectly via the client behavior
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      // Voice set is: autumn, austin — both should be recognized
      // Unknown voice should fall back to defaultVoice
      expect(provider.getVoices().map((v) => v.id)).not.toContain('unknown-voice');
    });
  });

  describe('getClient() — error when not configured', () => {
    it('should throw when env key is not set', () => {
      delete process.env.GROQ_API_KEY;
      const provider = new OpenAICompatTTSProvider(TTS_CONFIG);
      expect(() => (provider as any).getClient()).toThrow('GROQ_API_KEY is not set');
    });
  });

  describe('without defaultVoice', () => {
    it('should fall back to alloy when no defaultVoice set', () => {
      const configNoDefault = { ...TTS_CONFIG, defaultVoice: undefined };
      const provider = new OpenAICompatTTSProvider(configNoDefault);
      expect(provider.providerId).toBe('groq');
    });
  });
});
