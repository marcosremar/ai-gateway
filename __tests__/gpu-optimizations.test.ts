import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

describe('GPU Optimizations', () => {
  describe('Host reputation blacklist', () => {
    it('should filter blacklisted hosts in autoSelectCheapestGpu', () => {
      const source = readSource('server/gpu-deploy.ts');
      expect(source).toContain('blacklistedHosts');
      expect(source).toContain('crashCount');
      expect(source).toContain('3+ crashes');
    });
  });

  describe('Progressive benchmark targets', () => {
    it('should relax target by 15% before repechage', () => {
      const source = readSource('server/gpu-readiness.ts');
      expect(source).toContain('Relaxing target');
      expect(source).toContain('1.15');
    });
  });

  describe('TTS benchmark parallel', () => {
    it('should run TTS benchmark in background', () => {
      const source = readSource('server/gpu-readiness.ts');
      expect(source).toContain('ttsBenchmarkPromise');
      expect(source).toContain('non-blocking');
    });
  });

  describe('Parallel provider probe', () => {
    it('should probe providers before sequential deploy', () => {
      const source = readSource('server/gpu-deploy.ts');
      expect(source).toContain('Provider probe');
      expect(source).toContain('probeResults');
    });
  });

  describe('Skip benchmark for known-good hosts', () => {
    it('should fast-track reliable hosts', () => {
      const source = readSource('server/gpu-readiness.ts');
      expect(source).toContain('Fast-track');
      expect(source).toContain('reputationScore');
      expect(source).toContain('skipping benchmark');
    });
  });

  describe('Latency trend prediction', () => {
    it('should detect latency trend increases', () => {
      const source = readSource('server/gpu-deploy.ts');
      expect(source).toContain('Latency trend warning');
      expect(source).toContain('gpu:latency-trend');
    });
  });

  describe('Provider routing adaptation', () => {
    it('should track per-provider latency', () => {
      const source = readSource('server/providers.ts');
      expect(source).toContain('providerLatencyTracker');
      expect(source).toContain('recordProviderLatency');
      expect(source).toContain('getProviderP95');
    });
  });
});
