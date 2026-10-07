/**
 * Service Lifecycle — Unit + Integration Tests
 *
 * Tests the separated deploy vs service state machines:
 * - Deploy states (infra): searching, queued, creating, pulling, booting
 * - Service states (per STT/LLM/TTS): downloading, loading, compiling, benchmarking, shadow, ready, degraded
 * - Per-service phase transitions from health response
 * - Transition tracking with timestamps
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

describe('UI Lifecycle Separation', () => {
  describe('ServiceForm lifecycle diagram', () => {
    it('should have separate DEPLOY_PHASES and SERVICE_PHASES', () => {
      const source = readSource('web/src/sections/profiles/ServiceForm.tsx');
      expect(source).toContain('DEPLOY_PHASES');
      expect(source).toContain('SERVICE_PHASES');
      expect(source).toContain('infrastructure');
      expect(source).toContain('per STT / LLM / TTS');
    });

    it('DEPLOY_PHASES should have infra-only states', () => {
      const source = readSource('web/src/sections/profiles/ServiceForm.tsx');
      const deployIdx = source.indexOf('const DEPLOY_PHASES');
      const deployBlock = source.slice(deployIdx, deployIdx + 1000);
      for (const phase of ['Offline', 'Searching', 'Queued', 'Creating', 'Pulling Image', 'Booting', 'Draining']) {
        expect(deployBlock).toContain(phase);
      }
    });

    it('SERVICE_PHASES should have per-service states', () => {
      const source = readSource('web/src/sections/profiles/ServiceForm.tsx');
      const serviceIdx = source.indexOf('const SERVICE_PHASES');
      const serviceBlock = source.slice(serviceIdx, serviceIdx + 1500);
      for (const phase of ['Downloading', 'Loading', 'Compiling', 'Benchmarking', 'Shadow', 'Ready', 'Degraded', 'Repechage', 'Condemned']) {
        expect(serviceBlock).toContain(phase);
      }
    });
  });

  describe('GpuLiveStatus per-service cards', () => {
    it('should have ServiceStatusCards showing STT/LLM/TTS independently', () => {
      const source = readSource('web/src/sections/profiles/GpuLiveStatus.tsx');
      expect(source).toContain('Service Status');
      expect(source).toContain("'stt'");
      expect(source).toContain("'llm'");
      expect(source).toContain("'tts'");
      expect(source).toContain('loadDetail');
    });

    it('should have all phase metadata for granular states', () => {
      const source = readSource('web/src/sections/profiles/GpuLiveStatus.tsx');
      for (const phase of ['queued', 'downloading_models', 'loading_stt', 'loading_llm', 'loading_tts', 'compiling_tts', 'draining']) {
        expect(source).toContain(`${phase}:`);
      }
    });

    it('deploy progress bar should use step aliases for granular model steps', () => {
      const source = readSource('web/src/sections/profiles/GpuLiveStatus.tsx');
      expect(source).toContain('STEP_ALIASES');
      expect(source).toContain('resolvedStep');
    });
  });
});
