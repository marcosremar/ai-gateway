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

    it('flushDeploySettings should be exported from deploy-settings', () => {
      const source = readSource('src/gateway/providers/gpu/deploy-settings.ts');
      expect(source).toContain('export async function flushDeploySettings');
    });
  });
});
