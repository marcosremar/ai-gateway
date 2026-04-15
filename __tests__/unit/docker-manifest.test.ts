/**
 * Docker Manifest Tests — 100% Coverage Target
 *
 * Tests for:
 * - DockerManifest type validation
 * - validateManifest() function
 * - getLatencyTarget() function
 * - DEFAULT_LATENCY_TARGETS
 */

import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  getLatencyTarget,
  DEFAULT_LATENCY_TARGETS,
  type DockerManifest,
  type DockerCapability,
} from '../../src/gateway/providers/gpu/docker-manifest';

describe('Docker Manifest Types', () => {
  const validManifest: DockerManifest = {
    id: 'babelcast-subtitle',
    name: 'BabelCast Subtitle',
    version: '1.0.0',
    capabilities: ['stt', 'llm'],
    api: {
      stt: { endpoint: '/v1/audio/transcriptions', method: 'POST', model: 'whisper-large-v3' },
      llm: { endpoint: '/v1/translate/text', method: 'POST', type: 'translation' },
    },
    models: ['whisper-large-v3', 'translation-gemma-4b'],
    latencyTargets: { stt: 500, llm: 1000 },
  };

  describe('validateManifest', () => {
    it('should accept valid manifest', () => {
      expect(validateManifest(validManifest)).toBe(true);
    });

    it('should reject null manifest', () => {
      expect(validateManifest(null)).toBe(false);
    });

    it('should reject undefined manifest', () => {
      expect(validateManifest(undefined)).toBe(false);
    });

    it('should reject non-object manifest', () => {
      expect(validateManifest('string')).toBe(false);
      expect(validateManifest(123)).toBe(false);
      expect(validateManifest([])).toBe(false);
    });

    it('should reject manifest without id', () => {
      const invalid = { ...validManifest, id: undefined };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest with empty id', () => {
      const invalid = { ...validManifest, id: '' };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest without name', () => {
      const invalid = { ...validManifest, name: undefined };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest with empty name', () => {
      const invalid = { ...validManifest, name: '' };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest without version', () => {
      const invalid = { ...validManifest, version: undefined };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest with non-string version', () => {
      const invalid = { ...validManifest, version: 123 };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest without capabilities', () => {
      const invalid = { ...validManifest, capabilities: undefined };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest with empty capabilities', () => {
      const invalid = { ...validManifest, capabilities: [] };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest with non-array capabilities', () => {
      const invalid = { ...validManifest, capabilities: 'stt' };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest with invalid capability', () => {
      const invalid = { 
        ...validManifest, 
        capabilities: ['stt', 'invalid-capability'] 
      };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest without api', () => {
      const invalid = { ...validManifest, api: undefined };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest with null api', () => {
      const invalid = { ...validManifest, api: null };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest without models', () => {
      const invalid = { ...validManifest, models: undefined };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should reject manifest with non-array models', () => {
      const invalid = { ...validManifest, models: 'model1' };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('should accept manifest with all valid capabilities', () => {
      const allCaps: DockerCapability[] = ['stt', 'llm', 'tts', 'image', 'embedding', 'rerank'];
      const manifest = { 
        ...validManifest, 
        capabilities: allCaps,
        api: {
          stt: { endpoint: '/stt' },
          llm: { endpoint: '/llm' },
          tts: { endpoint: '/tts' },
          image: { endpoint: '/image' },
          embedding: { endpoint: '/embed' },
          rerank: { endpoint: '/rerank' },
        },
      };
      expect(validateManifest(manifest)).toBe(true);
    });

    it('should accept manifest with minimal valid structure', () => {
      const minimal = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        capabilities: ['stt'],
        api: { stt: { endpoint: '/stt' } },
        models: [],
      };
      expect(validateManifest(minimal)).toBe(true);
    });

    it('should accept manifest with optional fields', () => {
      const withOptionals = {
        ...validManifest,
        healthEndpoint: '/health',
        docsUrl: 'https://docs.example.com',
        metadata: {
          gpu: { minVramGb: 16, recommendedVramGb: 24 },
          dockerImage: 'test:latest',
          author: 'Test Author',
          license: 'MIT',
        },
      };
      expect(validateManifest(withOptionals)).toBe(true);
    });
  });

  describe('DEFAULT_LATENCY_TARGETS', () => {
    it('should have targets for all capabilities', () => {
      const caps: DockerCapability[] = ['stt', 'llm', 'tts', 'image', 'embedding', 'rerank'];
      for (const cap of caps) {
        expect(DEFAULT_LATENCY_TARGETS[cap]).toBeDefined();
        expect(typeof DEFAULT_LATENCY_TARGETS[cap]).toBe('number');
        expect(DEFAULT_LATENCY_TARGETS[cap]).toBeGreaterThan(0);
      }
    });

    it('should have reasonable default values', () => {
      expect(DEFAULT_LATENCY_TARGETS.stt).toBe(500);
      expect(DEFAULT_LATENCY_TARGETS.llm).toBe(1000);
      expect(DEFAULT_LATENCY_TARGETS.tts).toBe(800);
      expect(DEFAULT_LATENCY_TARGETS.image).toBe(5000);
      expect(DEFAULT_LATENCY_TARGETS.embedding).toBe(300);
      expect(DEFAULT_LATENCY_TARGETS.rerank).toBe(200);
    });
  });

  describe('getLatencyTarget', () => {
    it('should return custom latency when defined in manifest', () => {
      const manifest: DockerManifest = {
        ...validManifest,
        latencyTargets: { stt: 300, llm: 800 },
      };
      expect(getLatencyTarget(manifest, 'stt')).toBe(300);
      expect(getLatencyTarget(manifest, 'llm')).toBe(800);
    });

    it('should return default latency when not defined in manifest', () => {
      const manifest: DockerManifest = {
        ...validManifest,
        latencyTargets: {},
      };
      expect(getLatencyTarget(manifest, 'stt')).toBe(DEFAULT_LATENCY_TARGETS.stt);
      expect(getLatencyTarget(manifest, 'llm')).toBe(DEFAULT_LATENCY_TARGETS.llm);
    });

    it('should return default latency when latencyTargets is undefined', () => {
      const manifest: DockerManifest = {
        ...validManifest,
        latencyTargets: undefined,
      };
      expect(getLatencyTarget(manifest, 'stt')).toBe(DEFAULT_LATENCY_TARGETS.stt);
    });

    it('should return default for all capabilities', () => {
      const manifest: DockerManifest = {
        ...validManifest,
        latencyTargets: undefined,
      };
      const caps: DockerCapability[] = ['stt', 'llm', 'tts', 'image', 'embedding', 'rerank'];
      for (const cap of caps) {
        expect(getLatencyTarget(manifest, cap)).toBe(DEFAULT_LATENCY_TARGETS[cap]);
      }
    });

    it('should handle partial latency targets', () => {
      const manifest: DockerManifest = {
        ...validManifest,
        capabilities: ['stt', 'llm', 'tts'],
        latencyTargets: { stt: 400 }, // Only STT defined
      };
      expect(getLatencyTarget(manifest, 'stt')).toBe(400);
      expect(getLatencyTarget(manifest, 'llm')).toBe(DEFAULT_LATENCY_TARGETS.llm);
      expect(getLatencyTarget(manifest, 'tts')).toBe(DEFAULT_LATENCY_TARGETS.tts);
    });
  });

  describe('DockerManifest interface compliance', () => {
    it('should accept manifest with full api endpoint configuration', () => {
      const manifest: DockerManifest = {
        id: 'full-config',
        name: 'Full Config',
        version: '2.0.0',
        capabilities: ['stt', 'llm', 'tts'],
        api: {
          stt: {
            endpoint: '/v1/audio/transcriptions',
            method: 'POST',
            model: 'whisper-v3',
            contentType: 'multipart/form-data',
            responseFormat: 'json',
            type: 'transcription',
            metadata: { language: 'auto' },
          },
          llm: {
            endpoint: '/v1/chat/completions',
            method: 'POST',
            model: 'gpt-4',
            contentType: 'application/json',
            responseFormat: 'stream',
          },
          tts: {
            endpoint: '/v1/audio/speech',
            method: 'POST',
            model: 'tts-1',
            responseFormat: 'binary',
          },
        },
        models: ['whisper-v3', 'gpt-4', 'tts-1'],
        latencyTargets: { stt: 500, llm: 1000, tts: 800 },
        healthEndpoint: '/health',
        docsUrl: 'https://docs.example.com',
        metadata: {
          gpu: { minVramGb: 16, recommendedVramGb: 24 },
          dockerImage: 'full-config:latest',
          author: 'Test',
          license: 'Apache-2.0',
        },
      };
      expect(validateManifest(manifest)).toBe(true);
    });
  });
});
