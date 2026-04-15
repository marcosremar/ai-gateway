/**
 * Docker Registry Tests — 100% Coverage Target
 *
 * Tests for:
 * - fetchDockerManifest() — fetch and validation
 * - registerDockerImageProvider() — provider registration
 * - autoRegisterDockerProvider() — auto-discovery flow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger before importing modules
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  fetchDockerManifest,
  registerDockerImageProvider,
  autoRegisterDockerProvider,
} from '../../src/gateway/providers/gpu/docker-registry';
import type { DockerManifest } from '../../src/gateway/providers/gpu/docker-manifest';

describe('fetchDockerManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validManifest: DockerManifest = {
    id: 'test-image',
    name: 'Test Image',
    version: '1.0.0',
    capabilities: ['stt', 'llm'],
    api: {
      stt: { endpoint: '/v1/audio/transcriptions', method: 'POST' },
      llm: { endpoint: '/v1/chat/completions', method: 'POST' },
    },
    models: ['model-1'],
  };

  it('should fetch and validate manifest successfully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => validManifest,
    } as Response);

    const result = await fetchDockerManifest('http://test-endpoint:8000');
    
    expect(result).not.toBeNull();
    expect(result?.id).toBe('test-image');
    expect(result?.capabilities).toEqual(['stt', 'llm']);
  });

  it('should call correct endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => validManifest,
    } as Response);

    await fetchDockerManifest('http://test-endpoint:8000');
    
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-endpoint:8000/v1/manifest',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json' },
      })
    );
  });

  it('should use custom timeout', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => validManifest,
    } as Response);

    await fetchDockerManifest('http://test-endpoint:8000', 10000);
    
    expect(mockFetch).toHaveBeenCalled();
  });

  it('should return null when endpoint returns 404', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);

    const result = await fetchDockerManifest('http://test-endpoint:8000');
    
    expect(result).toBeNull();
  });

  it('should return null when endpoint returns 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    const result = await fetchDockerManifest('http://test-endpoint:8000');
    
    expect(result).toBeNull();
  });

  it('should return null for invalid manifest structure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ invalid: 'structure' }),
    } as Response);

    const result = await fetchDockerManifest('http://test-endpoint:8000');
    
    expect(result).toBeNull();
  });

  it('should return null when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await fetchDockerManifest('http://test-endpoint:8000');
    
    expect(result).toBeNull();
  });

  it('should return null when fetch times out', async () => {
    mockFetch.mockImplementationOnce(() => {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout')), 100);
      });
    });

    const result = await fetchDockerManifest('http://test-endpoint:8000', 50);
    
    expect(result).toBeNull();
  });

  it('should handle manifest without optional fields', async () => {
    const minimalManifest = {
      id: 'minimal',
      name: 'Minimal',
      version: '1.0.0',
      capabilities: ['stt'],
      api: { stt: { endpoint: '/stt' } },
      models: [],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => minimalManifest,
    } as Response);

    const result = await fetchDockerManifest('http://test-endpoint:8000');
    
    expect(result).not.toBeNull();
    expect(result?.id).toBe('minimal');
  });
});

describe('registerDockerImageProvider', () => {
  const mockRegistry = {
    register: vi.fn(),
  };

  const validManifest: DockerManifest = {
    id: 'test-provider',
    name: 'Test Provider',
    version: '1.0.0',
    capabilities: ['stt', 'llm'],
    api: {
      stt: { endpoint: '/v1/audio/transcriptions', method: 'POST', model: 'whisper-v3' },
      llm: { endpoint: '/v1/translate/text', method: 'POST', type: 'translation' },
    },
    models: ['whisper-v3', 'translation-model'],
    latencyTargets: { stt: 500, llm: 1000 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register provider with STT capability', () => {
    const manifest: DockerManifest = {
      ...validManifest,
      capabilities: ['stt'],
      api: { stt: { endpoint: '/stt', method: 'POST' } },
    };

    const result = registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
    
    expect(result).toBe(true);
    expect(mockRegistry.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test-provider',
        capabilities: ['stt'],
        requiresApiKey: false,
        stt: expect.objectContaining({
          id: 'test-provider-stt',
          name: 'Test Provider STT',
        }),
      })
    );
  });

  it('should register provider with LLM capability', () => {
    const manifest: DockerManifest = {
      ...validManifest,
      capabilities: ['llm'],
      api: { llm: { endpoint: '/llm', method: 'POST' } },
    };

    const result = registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
    
    expect(result).toBe(true);
    expect(mockRegistry.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test-provider',
        capabilities: ['llm'],
        llm: expect.objectContaining({
          id: 'test-provider-llm',
          name: 'Test Provider LLM',
        }),
      })
    );
  });

  it('should register provider with TTS capability', () => {
    const manifest: DockerManifest = {
      ...validManifest,
      capabilities: ['tts'],
      api: { tts: { endpoint: '/tts', method: 'POST' } },
    };

    const result = registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
    
    expect(result).toBe(true);
    expect(mockRegistry.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test-provider',
        capabilities: ['tts'],
        tts: expect.objectContaining({
          id: 'test-provider-tts',
          name: 'Test Provider TTS',
        }),
      })
    );
  });

  it('should register provider with multiple capabilities', () => {
    const result = registerDockerImageProvider(mockRegistry as any, validManifest, 'http://endpoint:8000');
    
    expect(result).toBe(true);
    expect(mockRegistry.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test-provider',
        capabilities: ['stt', 'llm'],
        requiresApiKey: false,
        metadata: expect.objectContaining({
          endpoint: 'http://endpoint:8000',
          models: ['whisper-v3', 'translation-model'],
          latencyTargets: { stt: 500, llm: 1000 },
        }),
      })
    );
  });

  it('should not register capability without api config', () => {
    const manifest: DockerManifest = {
      ...validManifest,
      capabilities: ['stt', 'llm'],
      api: { stt: { endpoint: '/stt' } }, // No llm api
    };

    registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
    
    const callArg = mockRegistry.register.mock.calls[0][0];
    expect(callArg.stt).toBeDefined();
    expect(callArg.llm).toBeUndefined();
  });

  it('should include description with endpoint', () => {
    registerDockerImageProvider(mockRegistry as any, validManifest, 'http://endpoint:8000');
    
    expect(mockRegistry.register).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Test Provider v1.0.0 at http://endpoint:8000',
      })
    );
  });

  it('should handle registration failure gracefully', () => {
    mockRegistry.register.mockImplementationOnce(() => {
      throw new Error('Registration failed');
    });

    const result = registerDockerImageProvider(mockRegistry as any, validManifest, 'http://endpoint:8000');
    
    expect(result).toBe(false);
  });

  it('should use default latency targets when not specified', () => {
    const manifest: DockerManifest = {
      ...validManifest,
      latencyTargets: undefined,
    };

    registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
    
    const callArg = mockRegistry.register.mock.calls[0][0];
    expect(callArg.metadata.latencyTargets).toEqual({
      stt: 500,
      llm: 1000,
    });
  });
});

describe('autoRegisterDockerProvider', () => {
  const mockRegistry = {
    register: vi.fn(),
  };

  const validManifest: DockerManifest = {
    id: 'auto-test',
    name: 'Auto Test',
    version: '1.0.0',
    capabilities: ['stt'],
    api: { stt: { endpoint: '/stt' } },
    models: ['model-1'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should auto-discover and register provider', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => validManifest,
    } as Response);

    const result = await autoRegisterDockerProvider(mockRegistry as any, 'http://endpoint:8000');
    
    expect(result).not.toBeNull();
    expect(result?.id).toBe('auto-test');
    expect(mockRegistry.register).toHaveBeenCalled();
  });

  it('should return null when no manifest found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const result = await autoRegisterDockerProvider(mockRegistry as any, 'http://endpoint:8000');
    
    expect(result).toBeNull();
    expect(mockRegistry.register).not.toHaveBeenCalled();
  });

  it('should return null when registration fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => validManifest,
    } as Response);

    mockRegistry.register.mockImplementationOnce(() => {
      throw new Error('Registration failed');
    });

    const result = await autoRegisterDockerProvider(mockRegistry as any, 'http://endpoint:8000');
    
    expect(result).toBeNull();
  });

  it('should handle network errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await autoRegisterDockerProvider(mockRegistry as any, 'http://endpoint:8000');
    
    expect(result).toBeNull();
  });
});

describe('Provider method implementations', () => {
  const mockRegistry = {
    register: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('STT Provider', () => {
    it('should call transcribe endpoint correctly', async () => {
      const manifest: DockerManifest = {
        id: 'stt-test',
        name: 'STT Test',
        version: '1.0.0',
        capabilities: ['stt'],
        api: { 
          stt: { 
            endpoint: '/v1/audio/transcriptions', 
            method: 'POST',
            model: 'whisper-v3',
          } 
        },
        models: ['whisper-v3'],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ text: 'Hello world', language: 'en', confidence: 0.95 }),
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      const audioBuffer = Buffer.from('fake audio data');
      
      const result = await provider.stt.transcribe(audioBuffer, { 
        language: 'en', 
        prompt: 'test prompt',
        hotwords: ['word1'],
      });

      expect(result.text).toBe('Hello world');
      expect(result.language).toBe('en');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://endpoint:8000/v1/audio/transcriptions',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should handle transcription with transcription field', async () => {
      const manifest: DockerManifest = {
        id: 'stt-test',
        name: 'STT Test',
        version: '1.0.0',
        capabilities: ['stt'],
        api: { stt: { endpoint: '/stt' } },
        models: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ transcription: 'Transcribed text' }),
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      const result = await provider.stt.transcribe(Buffer.from('audio'));

      expect(result.text).toBe('Transcribed text');
    });

    it('should throw on transcription failure', async () => {
      const manifest: DockerManifest = {
        id: 'stt-test',
        name: 'STT Test',
        version: '1.0.0',
        capabilities: ['stt'],
        api: { stt: { endpoint: '/stt' } },
        models: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      
      await expect(provider.stt.transcribe(Buffer.from('audio'))).rejects.toThrow('STT request failed');
    });
  });

  describe('LLM Provider', () => {
    it('should call translation endpoint', async () => {
      const manifest: DockerManifest = {
        id: 'llm-test',
        name: 'LLM Test',
        version: '1.0.0',
        capabilities: ['llm'],
        api: { 
          llm: { 
            endpoint: '/v1/translate/text', 
            method: 'POST',
            type: 'translation',
            model: 'translation-model',
          } 
        },
        models: ['translation-model'],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ text: 'Olá mundo', model: 'translation-model', tokens: 10 }),
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      const result = await provider.llm.translate('Hello world', 'en', 'pt', {
        glossary: ['word'],
        context: 'test context',
      });

      expect(result.text).toBe('Olá mundo');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://endpoint:8000/v1/translate/text',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('Hello world'),
        })
      );
    });

    it('should call chat completions endpoint when not translation type', async () => {
      const manifest: DockerManifest = {
        id: 'llm-test',
        name: 'LLM Test',
        version: '1.0.0',
        capabilities: ['llm'],
        api: { 
          llm: { 
            endpoint: '/v1/chat/completions', 
            method: 'POST',
          } 
        },
        models: ['gpt-4'],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ 
          choices: [{ message: { content: 'Translated text' } }],
          model: 'gpt-4',
          usage: { total_tokens: 15 },
        }),
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      const result = await provider.llm.translate('Hello', 'en', 'pt');

      expect(result.text).toBe('Translated text');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://endpoint:8000/v1/chat/completions',
        expect.objectContaining({
          body: expect.stringContaining('messages'),
        })
      );
    });

    it('should handle different response formats', async () => {
      const manifest: DockerManifest = {
        id: 'llm-test',
        name: 'LLM Test',
        version: '1.0.0',
        capabilities: ['llm'],
        api: { llm: { endpoint: '/translate', type: 'translation' } },
        models: [],
      };

      // Test with 'translation' field
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ translation: 'Translated' }),
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      let result = await provider.llm.translate('Hello', 'en', 'pt');
      expect(result.text).toBe('Translated');

      // Test with 'output' field
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ output: 'Output text' }),
      } as Response);

      result = await provider.llm.translate('Hello', 'en', 'pt');
      expect(result.text).toBe('Output text');
    });

    it('should throw on LLM request failure', async () => {
      const manifest: DockerManifest = {
        id: 'llm-test',
        name: 'LLM Test',
        version: '1.0.0',
        capabilities: ['llm'],
        api: { llm: { endpoint: '/translate', type: 'translation' } },
        models: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      
      await expect(provider.llm.translate('Hello', 'en', 'pt')).rejects.toThrow('LLM request failed');
    });
  });

  describe('TTS Provider', () => {
    it('should call TTS endpoint correctly', async () => {
      const manifest: DockerManifest = {
        id: 'tts-test',
        name: 'TTS Test',
        version: '1.0.0',
        capabilities: ['tts'],
        api: { 
          tts: { 
            endpoint: '/v1/audio/speech', 
            method: 'POST',
            model: 'tts-1',
          } 
        },
        models: ['tts-1'],
      };

      const audioBuffer = new ArrayBuffer(8);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => audioBuffer,
        headers: new Headers({ 'content-type': 'audio/wav' }),
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      const result = await provider.tts.speak('Hello world', 'en', { voice: 'alloy', speed: 1.2 });

      expect(result.audio).toBeInstanceOf(Buffer);
      expect(result.format).toBe('wav');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://endpoint:8000/v1/audio/speech',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('Hello world'),
        })
      );
    });

    it('should detect mp3 format from content-type', async () => {
      const manifest: DockerManifest = {
        id: 'tts-test',
        name: 'TTS Test',
        version: '1.0.0',
        capabilities: ['tts'],
        api: { tts: { endpoint: '/tts' } },
        models: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(8),
        headers: new Headers({ 'content-type': 'audio/mp3' }),
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      const result = await provider.tts.speak('Hello', 'en');

      expect(result.format).toBe('mp3');
    });

    it('should throw on TTS request failure', async () => {
      const manifest: DockerManifest = {
        id: 'tts-test',
        name: 'TTS Test',
        version: '1.0.0',
        capabilities: ['tts'],
        api: { tts: { endpoint: '/tts' } },
        models: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      registerDockerImageProvider(mockRegistry as any, manifest, 'http://endpoint:8000');
      
      const provider = mockRegistry.register.mock.calls[0][0];
      
      await expect(provider.tts.speak('Hello', 'en')).rejects.toThrow('TTS request failed');
    });
  });
});
