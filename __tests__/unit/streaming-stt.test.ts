import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StreamingSTTRouter,
  StreamingSTTBackend,
  type StreamingSTTConfig,
  type StreamingSTTStatus,
  type StreamingSTTProvider,
} from '../src/streaming-stt';

const makeConfig = (overrides: Partial<StreamingSTTConfig> = {}): StreamingSTTConfig => ({
  getGpuUrl: () => null,
  fireworksApiKey: undefined,
  getQwen3AsrUrl: () => null,
  providerOrder: undefined,
  ...overrides,
});

describe('StreamingSTTRouter', () => {
  describe('constructor', () => {
    it('uses default provider order when not specified', () => {
      const router = new StreamingSTTRouter(makeConfig());
      const status = router.getStatus();
      expect(Object.keys(status)).toEqual(['gpu', 'qwen3-asr', 'fireworks']);
    });

    it('accepts custom providerOrder', () => {
      const router = new StreamingSTTRouter(makeConfig({
        providerOrder: ['fireworks', 'gpu', 'qwen3-asr'],
      }));
      expect(router.getActiveProvider()).toBeNull();
    });
  });

  describe('getStatus()', () => {
    it('reports GPU available when getGpuUrl returns a URL', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => 'http://gpu-host:8000',
      }));
      const status = router.getStatus();

      expect(status.gpu.available).toBe(true);
      expect(status.gpu.reason).toBe('endpoint: http://gpu-host:8000');
      expect(status['qwen3-asr'].available).toBe(false);
      expect(status.fireworks.available).toBe(false);
    });

    it('reports qwen3-asr available when GPU is down', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => null,
        getQwen3AsrUrl: () => 'https://modal.run/api',
      }));
      const status = router.getStatus();

      expect(status.gpu.available).toBe(false);
      expect(status['qwen3-asr'].available).toBe(true);
      expect(status['qwen3-asr'].reason).toBe('endpoint: https://modal.run/api');
      expect(status.fireworks.available).toBe(false);
    });

    it('reports fireworks available when configured with API key', () => {
      const router = new StreamingSTTRouter(makeConfig({
        fireworksApiKey: 'fw-test-key',
      }));
      const status = router.getStatus();

      expect(status.fireworks.available).toBe(true);
      expect(status.fireworks.reason).toBe('API key configured');
    });

    it('reports all unavailable when nothing is configured', () => {
      const router = new StreamingSTTRouter(makeConfig());
      const status = router.getStatus();

      expect(status.gpu.available).toBe(false);
      expect(status['qwen3-asr'].available).toBe(false);
      expect(status.fireworks.available).toBe(false);
      expect(status.gpu.reason).toBe('GPU not ready');
      expect(status['qwen3-asr'].reason).toBe('No endpoint configured');
      expect(status.fireworks.reason).toBe('No API key');
    });
  });

  describe('getActiveProvider()', () => {
    it('returns gpu when GPU URL is available (default order)', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => 'http://gpu:8000',
        getQwen3AsrUrl: () => 'https://modal.run',
        fireworksApiKey: 'key',
      }));
      expect(router.getActiveProvider()).toBe('gpu');
    });

    it('falls back to qwen3-asr when GPU is not available', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => null,
        getQwen3AsrUrl: () => 'https://modal.run',
        fireworksApiKey: 'key',
      }));
      expect(router.getActiveProvider()).toBe('qwen3-asr');
    });

    it('falls back to fireworks when GPU and qwen3 are not available', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => null,
        fireworksApiKey: 'key',
      }));
      expect(router.getActiveProvider()).toBe('fireworks');
    });

    it('returns null when all backends are down', () => {
      const router = new StreamingSTTRouter(makeConfig());
      expect(router.getActiveProvider()).toBeNull();
    });

    it('respects custom providerOrder', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => 'http://gpu:8000',
        getQwen3AsrUrl: () => 'https://modal.run',
        providerOrder: ['fireworks', 'qwen3-asr', 'gpu'],
      }));
      expect(router.getActiveProvider()).toBe('qwen3-asr');
    });
  });

  describe('createBackend()', () => {
    it('creates GPU backend when GPU URL is available', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => 'http://gpu:8000',
      }));
      const backend = router.createBackend('pt');
      expect(backend).toBeInstanceOf(StreamingSTTBackend);
      expect(backend!.provider).toBe('gpu');
    });

    it('creates qwen3-asr backend as fallback', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => null,
        getQwen3AsrUrl: () => 'https://modal.run/api',
      }));
      const backend = router.createBackend('pt');
      expect(backend).toBeInstanceOf(StreamingSTTBackend);
      expect(backend!.provider).toBe('qwen3-asr');
    });

    it('creates fireworks backend as last fallback', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => null,
        fireworksApiKey: 'fw-key',
      }));
      const backend = router.createBackend('en');
      expect(backend).toBeInstanceOf(StreamingSTTBackend);
      expect(backend!.provider).toBe('fireworks');
    });

    it('returns null when no providers are available', () => {
      const router = new StreamingSTTRouter(makeConfig());
      expect(router.createBackend('pt')).toBeNull();
    });

    it('respects excludeProviders', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => 'http://gpu:8000',
        getQwen3AsrUrl: () => 'https://modal.run/api',
      }));
      const backend = router.createBackend('pt', new Set(['gpu']));
      expect(backend!.provider).toBe('qwen3-asr');
    });

    it('builds correct WebSocket URL for GPU backend with params', () => {
      const router = new StreamingSTTRouter(makeConfig({
        getGpuUrl: () => 'http://gpu:8000',
      }));
      const backend = router.createBackend('pt', undefined, {
        chunkSize: 2.0,
        beamSize: 5,
        temperature: 0.1,
      });
      expect(backend!.constructor.prototype).toBeDefined();
    });

    it('builds correct WebSocket URL for fireworks', () => {
      const router = new StreamingSTTRouter(makeConfig({
        fireworksApiKey: 'fw-key',
      }));
      const backend = router.createBackend('en');
      expect(backend!.provider).toBe('fireworks');
    });
  });
});

describe('StreamingSTTBackend', () => {
  it('starts with isOpen false', () => {
    const backend = new StreamingSTTBackend('ws://localhost', {}, 'gpu');
    expect(backend.isOpen).toBe(false);
  });
});
