/**
 * fast-serve profile — Phase 1.
 *
 * Scope:
 *   - DEFAULT_APPS exposes the fast-serve app with offloadOnIdle=true.
 *   - registerFastServeProfile() is a no-op when the env flag is unset.
 *   - registerFastServeProfile() registers a hyperstack pool config when
 *     AI_GATEWAY_FAST_SERVE === 'true'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setCalls: any[] = [];
vi.mock('../server/standby-pool', () => ({
  setStandbyPoolConfig: (cfg: any) => {
    setCalls.push(cfg);
  },
}));

describe('fast-serve profile', () => {
  beforeEach(() => {
    setCalls.length = 0;
    delete process.env.AI_GATEWAY_FAST_SERVE;
  });
  afterEach(() => {
    delete process.env.AI_GATEWAY_FAST_SERVE;
  });

  it('DEFAULT_APPS contains fast-serve with offloadOnIdle=true', async () => {
    const { DEFAULT_APPS } = await import('../server/config-persistence');
    const app = DEFAULT_APPS.find((a) => a.id === 'fast-serve');
    expect(app).toBeDefined();
    expect(app!.gpuDeploy?.offloadOnIdle).toBe(true);
    expect(app!.gpuDeploy?.hibernateOnIdle).toBe(false);
    expect(app!.gpuDeploy?.gpuTypes).toContain('NVIDIA L40');
    expect(app!.loadBalanceStrategy).toBe('least-latency');
  });

  it('registerFastServeProfile is a no-op when env unset', async () => {
    const { registerFastServeProfile } = await import('../server/fast-serve-init');
    registerFastServeProfile();
    expect(setCalls.length).toBe(0);
  });

  it('registerFastServeProfile registers pool config when env=true', async () => {
    process.env.AI_GATEWAY_FAST_SERVE = 'true';
    const { registerFastServeProfile } = await import('../server/fast-serve-init');
    registerFastServeProfile();
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]).toMatchObject({
      profile: 'fast-serve',
      tier: 'hyperstack',
      minStandby: 2,
      maxStandby: 4,
      offloadOnIdle: true,
      dockerImage: 'marcosremar/babelcast-subtitle:latest',
    });
    expect(setCalls[0].gpuTypes).toEqual(['NVIDIA L40']);
  });

  it('registerFastServeProfile ignores non-"true" env values', async () => {
    process.env.AI_GATEWAY_FAST_SERVE = '1';
    const { registerFastServeProfile } = await import('../server/fast-serve-init');
    registerFastServeProfile();
    expect(setCalls.length).toBe(0);
  });
});
