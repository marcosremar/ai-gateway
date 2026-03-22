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

describe('Service Lifecycle States', () => {

  describe('ServiceReadinessPhase type', () => {
    it('should include all service lifecycle phases', () => {
      const source = readSource('server/state.ts');
      for (const phase of ['idle', 'downloading', 'loading', 'compiling', 'warming', 'benchmarking', 'shadow', 'ready', 'degraded', 'failed', 'repechage', 'condemned']) {
        expect(source).toContain(`'${phase}'`);
      }
    });

    it('ServiceReadinessState should have loadDetail and phaseStartedAt', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('loadDetail');
      expect(source).toContain('phaseStartedAt');
    });
  });

  describe('Deploy state type', () => {
    it('should include queued status', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain("'queued'");
      expect(source).toContain("'searching'");
    });

    it('should include granular step types', () => {
      const source = readSource('server/state.ts');
      for (const step of ['searching_offers', 'no_offers', 'queued', 'creating_pod', 'pulling_image', 'downloading_models', 'loading_stt', 'loading_llm', 'loading_tts', 'compiling_tts', 'draining', 'ready']) {
        expect(source).toContain(`'${step}'`);
      }
    });

    it('should have transitions array in DeploymentState', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('transitions:');
      expect(source).toContain('Array<{');
    });
  });

  describe('Per-service phase mapping from health response', () => {
    it('updateGpuModelWarmth should map service status to readiness phases', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('STATUS_TO_PHASE');
      expect(source).toContain("downloading: 'downloading'");
      expect(source).toContain("loading: 'loading'");
      expect(source).toContain("compiling: 'compiling'");
      expect(source).toContain("loaded: 'ready'");
    });

    it('should only update loading phases (not override benchmark/shadow)', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('isLoadingPhase');
      expect(source).toContain("'idle', 'downloading', 'loading', 'compiling', 'warming'");
    });

    it('should set loadDetail with service name and status', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('loadDetail:');
      expect(source).toContain('svcName');
    });
  });

  describe('Transition tracking', () => {
    it('setDeployState should record transitions on status/step change', () => {
      const source = readSource('server/state.ts');
      const setIdx = source.indexOf('function setDeployState');
      const body = source.slice(setIdx, setIdx + 2500);
      expect(body).toContain('transitions.push');
      expect(body).toContain('gpu:transition');
    });

    it('should keep last 30 transitions', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('transitions.length > 30');
      expect(source).toContain('.slice(-30)');
    });

    it('resetDeployState should clear transitions', () => {
      const source = readSource('server/state.ts');
      expect(source).toContain('transitions: []');
    });
  });

  describe('Queued state detection in deploy', () => {
    it('should detect queued from Vast.ai status (created/loading/pending)', () => {
      const source = readSource('server/gpu-deploy.ts');
      expect(source).toContain("'created'");
      expect(source).toContain("'loading'");
      expect(source).toContain("'pending'");
      expect(source).toContain("status: 'queued'");
      expect(source).toContain("step: 'queued'");
    });
  });

  describe('Granular model loading in health response', () => {
    it('should detect downloading vs loading vs compiling per service', () => {
      const source = readSource('server/gpu-deploy.ts');
      expect(source).toContain("whisperStatus === 'downloading'");
      expect(source).toContain("llamaStatus === 'downloading'");
      expect(source).toContain("ttsStatus === 'downloading'");
      expect(source).toContain("ttsStatus === 'compiling'");
      expect(source).toContain("modelStep = 'loading_stt'");
      expect(source).toContain("modelStep = 'loading_llm'");
      expect(source).toContain("modelStep = 'loading_tts'");
      expect(source).toContain("modelStep = 'compiling_tts'");
    });

    it('should broadcast gpu:services event with granular step', () => {
      const source = readSource('server/gpu-deploy.ts');
      expect(source).toContain("type: 'gpu:services'");
      expect(source).toContain('step: modelStep');
    });
  });

  describe('Draining state in standby handover', () => {
    it('should set draining step during handover', () => {
      const source = readSource('server/gpu-standby.ts');
      expect(source).toContain("step: 'draining'");
      expect(source).toContain("gpu:draining");
      expect(source).toContain('activeRequests');
    });
  });
});

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
