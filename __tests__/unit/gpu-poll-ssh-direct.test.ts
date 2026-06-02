import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const stateObj = {
    status: 'idle',
    deployId: 'test-deploy-id',
    podId: '',
    endpoint: '',
    gpuType: '',
    dockerImage: '',
    message: '',
    step: '',
    stepDetail: '',
    startedAt: 0,
    retryCount: 0,
    provider: '',
    alert: '',
    alertLevel: 'info',
    sshHost: '',
    sshPort: 0,
    lastLogs: '',
    deployDurationMs: 0,
    costPerHr: 0,
    providerMeta: {},
    transitions: [],
    readinessProbe: 'ssh' as const,
    deployCancelled: false,
  };
  const setDeployStateMock = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(stateObj, patch);
  });
  return { stateObj, setDeployStateMock };
});

vi.mock('../../server/state', () => ({
  get deployState() { return mocks.stateObj; },
  setDeployState: mocks.setDeployStateMock,
  deployCancelled: false,
  setLastRequestTime: vi.fn(),
  updateGpuModelWarmth: vi.fn(),
}));

vi.mock('../../server/ws-state', () => ({
  broadcastWs: vi.fn(),
}));

vi.mock('../../server/providers', () => ({
  registry: {},
}));

vi.mock('../../src/gpu-providers/deploy-settings', () => ({
  getDeployTimeoutMin: vi.fn(() => 45),
  getDeployTimeoutMinForProvider: vi.fn(() => 45),
}));

vi.mock('../../src/gateway/providers/gpu/docker-manifest', () => ({
  validateDockerContractManifest: vi.fn(async () => null),
  defaultApiPathsForCapabilities: vi.fn(() => []),
}));

vi.mock('../../src/gpu-providers/runpod-client', () => ({
  RunpodClient: class {
    providerId = 'runpod';
    bootTimeSecs = 120;
    discoverInstance = vi.fn(async () => null);
    createInstance = vi.fn(async () => ({}));
    startInstance = vi.fn(async () => {});
    stopInstance = vi.fn(async () => {});
    deleteInstance = vi.fn(async () => {});
    getInstanceStatus = vi.fn(async () => 'running');
    listInstances = vi.fn(async () => []);
    resolveInstanceEndpoint = vi.fn(async () => null);
  },
}));

import { pollHealthUntilReady } from '../../server/gpu-poll-health';
import type { GpuProviderClient } from '../../src/gpu-providers/types';

function makeProvider(): GpuProviderClient {
  return {
    providerId: 'vast',
    bootTimeSecs: 10,
    discoverInstance: vi.fn(async () => null),
    createInstance: vi.fn(async () => ({} as any)),
    startInstance: vi.fn(async () => {}),
    stopInstance: vi.fn(async () => {}),
    deleteInstance: vi.fn(async () => {}),
    getInstanceStatus: vi.fn(async () => 'running'),
    listInstances: vi.fn(async () => []),
    resolveInstanceEndpoint: vi.fn(async () => null),
  };
}

describe('pollHealthUntilReady — Vast SSH readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.stateObj, {
      status: 'idle',
      message: '',
      step: '',
      stepDetail: '',
      sshHost: '',
      sshPort: 0,
      readinessProbe: 'ssh',
    });
  });

  it('does not treat a direct HTTP endpoint as direct SSH', async () => {
    const provider = makeProvider();

    const result = await pollHealthUntilReady(
      provider,
      'vast',
      'fake-api-key',
      'inst-123',
      'http://2.2.2.2:28000',
      Date.now(),
      undefined,
      { provider: 'vast', hostIp: '2.2.2.2' },
      [],
      [],
      false,
      false,
    );

    expect(result.result).toBe('timeout');
    expect(provider.getInstanceStatus).not.toHaveBeenCalled();
    expect(mocks.stateObj.message).toMatch(/direct SSH was not resolved/);
  });

  it('rejects Vast SSH proxy before running readiness probes', async () => {
    const provider = makeProvider();

    const result = await pollHealthUntilReady(
      provider,
      'vast',
      'fake-api-key',
      'inst-123',
      '',
      Date.now(),
      undefined,
      { provider: 'vast', sshHost: 'ssh8.vast.ai', sshPort: 14150 },
      [],
      [],
      false,
      false,
    );

    expect(result.result).toBe('timeout');
    expect(provider.getInstanceStatus).not.toHaveBeenCalled();
    expect(mocks.stateObj.message).toMatch(/not direct/);
  });
});
