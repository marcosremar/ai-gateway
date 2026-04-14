/**
 * Tests for types module.
 */

import { describe, it } from 'vitest';
import type { GatewayConfig } from '../../src/config';

describe('Types', () => {
  it('should compile GatewayConfig type', () => {
    const config: GatewayConfig = {
      port: 4000,
      hostname: '0.0.0.0',
      nodeEnv: 'test',
      gatewayApiKeys: ['sk-test'],
      rateLimitRpm: 100,
      proxyBodyReadTimeoutMs: 30000,
      proxyTotalTimeoutMs: 60000,
      idleTimeoutMin: 15,
      idleDestroyHours: 2,
      profile: false,
    };
    expect(config.port).toBe(4000);
  });
});
