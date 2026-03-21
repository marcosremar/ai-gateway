/**
 * Graceful Shutdown — Integration Tests
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

describe('Graceful Shutdown', () => {

  it('should stop all monitoring timers', () => {
    const source = readSource('../gateway-server.ts');
    const shutdownIdx = source.indexOf('async function gracefulShutdown');
    expect(shutdownIdx).toBeGreaterThan(0);
    // Read a large enough window to capture all cleanup calls
    const shutdownBody = source.slice(shutdownIdx, shutdownIdx + 5000);

    expect(shutdownBody).toContain('stopGpuMonitoring');
    expect(shutdownBody).toContain('stopOrphanSweep');
    expect(shutdownBody).toContain('stopProviderWarmup');
    expect(shutdownBody).toContain('stopLatencyScheduler');
  });

  it('should stop standby monitor', () => {
    const source = readSource('../gateway-server.ts');
    const shutdownIdx = source.indexOf('async function gracefulShutdown');
    const shutdownBody = source.slice(shutdownIdx, shutdownIdx + 5000);
    expect(shutdownBody).toContain('stopStandbyMonitor');
  });

  it('should stop modal keepalive timer', () => {
    const source = readSource('../gateway-server.ts');
    const shutdownIdx = source.indexOf('async function gracefulShutdown');
    const shutdownBody = source.slice(shutdownIdx, shutdownIdx + 5000);
    expect(shutdownBody).toContain('stopModalKeepalive');
  });

  it('should flush deploy settings', () => {
    const source = readSource('../gateway-server.ts');
    const shutdownIdx = source.indexOf('async function gracefulShutdown');
    const shutdownBody = source.slice(shutdownIdx, shutdownIdx + 5000);
    expect(shutdownBody).toContain('flushDeploySettings');
  });

  it('should close latency DB', () => {
    const source = readSource('../gateway-server.ts');
    const shutdownIdx = source.indexOf('async function gracefulShutdown');
    const shutdownBody = source.slice(shutdownIdx, shutdownIdx + 5000);
    expect(shutdownBody).toContain('closeLatencyDb');
  });

  it('should disconnect Prisma', () => {
    const source = readSource('../gateway-server.ts');
    const shutdownIdx = source.indexOf('async function gracefulShutdown');
    const shutdownBody = source.slice(shutdownIdx, shutdownIdx + 5000);
    expect(shutdownBody).toContain('prisma.$disconnect');
  });

  describe('Exported cleanup functions', () => {
    it('stopModalKeepalive should be exported from ai-handlers', () => {
      const source = readSource('server/ai-handlers.ts');
      expect(source).toContain('export function stopModalKeepalive');
    });

    it('closeLatencyDb should be exported from latency-db', () => {
      const source = readSource('server/latency-db.ts');
      expect(source).toContain('export function closeLatencyDb');
    });

    it('flushDeploySettings should be exported from deploy-settings', () => {
      const source = readSource('src/gpu-providers/deploy-settings.ts');
      expect(source).toContain('export function flushDeploySettings');
    });

    it('stopStandbyMonitor should be exported from gpu-standby', () => {
      const source = readSource('server/gpu-standby.ts');
      expect(source).toContain('export function stopStandbyMonitor');
    });
  });
});
