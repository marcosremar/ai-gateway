import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the logger before importing server modules
vi.mock('../src/logger', () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  }),
}));

// Mock ws-state
vi.mock('./ws-state', () => ({
  broadcastWs: vi.fn(),
  broadcastProviderStatus: vi.fn(),
}));

// Mock canary module
vi.mock('../src/canary', () => ({
  createCanaryDeploy: vi.fn(() => ({
    evaluate: vi.fn(() => ({ action: 'promote' })),
    promote: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Need to mock server/deploy-state-machine too
vi.mock('./deployment-state-machine', () => ({
  deploymentSM: {
    markReady: vi.fn(),
    startBooting: vi.fn(),
    transition: vi.fn(),
  },
}));

describe('canary timer leak on resetDeployState', () => {
  // NOTE: don't use vi.useFakeTimers() here. Fake timers replace clearInterval
  // with a fake implementation, which the spy on globalThis.clearInterval no
  // longer catches in vitest 4.x. Using real timers + a manual setInterval that
  // we clean up keeps the spy honest.
  const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

  beforeEach(() => {
    clearIntervalSpy.mockClear();
  });

  test('resetDeployState should clearInterval on existing canaryEvalTimer to prevent timer leak', async () => {
    // Dynamic import so mocks are set up first
    const stateMod = await import('../server/state');
    const { resetDeployState, deployState, setDeployState } = stateMod;
    // Clear the deploy-cancelled flag set by a previous test's resetDeployState —
    // setDeployState short-circuits non-idle patches when cancelled is true.
    if ((stateMod as any).setDeployCancelled) (stateMod as any).setDeployCancelled(false);

    // Simulate an active canary eval timer (set externally, as startCanaryIfEnabled would)
    const fakeTimerId = setInterval(() => {}, 60_000);
    setDeployState({ status: 'idle', canaryEvalTimer: fakeTimerId as unknown as ReturnType<typeof setInterval> | null });

    // Confirm the timer is set
    expect(deployState.canaryEvalTimer).toBe(fakeTimerId);

    // resetDeployState should clear the interval timer
    resetDeployState();

    // The canaryEvalTimer should be null
    expect(deployState.canaryEvalTimer).toBeNull();

    // clearInterval should have been called with the timer ID
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimerId);
  });

  test('resetDeployState should not call clearInterval when canaryEvalTimer is null', async () => {
    const { resetDeployState } = await import('../server/state');

    // deployState starts with canaryEvalTimer: null
    resetDeployState();

    // clearInterval should NOT have been called
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });
});
