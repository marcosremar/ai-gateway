/**
 * Graceful Shutdown — Integration Tests
 *
 * NOTE: gateway-server.ts was moved to the web app (web/).
 * Only the exported cleanup function checks remain.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

describe('Graceful Shutdown', () => {

  describe('Exported cleanup functions', () => {
    it('stopModalKeepalive should be exported from ai-handlers', () => {
      const source = readSource('../../../server/ai-handlers.ts');
      expect(source).toContain('export function stopModalKeepalive');
    });

    it('closeLatencyDb should be exported from latency-db', () => {
      const source = readSource('../../../server/latency-db.ts');
      expect(source).toContain('export function closeLatencyDb');
    });

    it('flushDeploySettings should be exported from deploy-settings', () => {
      const source = readSource('../../src/gpu-providers/deploy-settings.ts');
      expect(source).toContain('export function flushDeploySettings');
    });

    it('stopStandbyMonitor should be exported from gpu-standby', () => {
      const source = readSource('../../../server/gpu-standby.ts');
      expect(source).toContain('export function stopStandbyMonitor');
    });
  });
});
