/**
 * Unit tests for server/gpu-destroy-timer.ts
 *
 * Covers: scheduleAutoDestroy (writes persist file, arms timer, clears
 * existing timer), clearAutoDestroyTimer (clears timer + file),
 * and recoverPersistedDestroyTimer (missing file, stale podId, deadline
 * passed → immediate terminate, deadline future → re-arm timer).
 *
 * All filesystem, state, WebSocket, and terminate calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { fsState, stateRef, terminateMock, broadcastMock } = vi.hoisted(() => {
  const fsState = {
    fileExists: false,
    fileContent: '',
    writtenPath: '',
    writtenContent: '',
    shouldThrowRead: false,
    shouldThrowWrite: false,
    unlinkedPath: '',
    unlinkedCalled: false,
  };

  const stateRef = {
    podId: 'pod-abc',
    deployId: 'deploy-xyz',
    provider: 'runpod',
  };

  const terminateMock = { autoTerminateGpu: vi.fn().mockResolvedValue(undefined) };
  const broadcastMock = { broadcastWs: vi.fn() };

  return { fsState, stateRef, terminateMock, broadcastMock };
});

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn() }),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => fsState.fileExists),
  readFileSync: vi.fn(() => {
    if (fsState.shouldThrowRead) throw new Error('EACCES: permission denied');
    return fsState.fileContent;
  }),
  writeFileSync: vi.fn((p: string, content: string) => {
    if (fsState.shouldThrowWrite) throw new Error('ENOSPC: no space left on device');
    fsState.writtenPath = p;
    fsState.writtenContent = content;
  }),
  unlinkSync: vi.fn((p: string) => {
    fsState.unlinkedPath = p;
    fsState.unlinkedCalled = true;
    fsState.fileExists = false;
  }),
}));

vi.mock('../../server/state', () => ({
  get activeProvider() { return stateRef.provider; },
  deployState: {
    get podId() { return stateRef.podId; },
    get deployId() { return stateRef.deployId; },
  },
}));

vi.mock('../../server/ws-state', () => ({
  broadcastWs: (...args: unknown[]) => broadcastMock.broadcastWs(...args),
}));

// gpu-terminate is lazy-imported inside the timer callback — the vi.mock here
// ensures the dynamic import('...') call in the timer callback also gets the mock.
vi.mock('../../server/gpu-terminate', () => ({
  autoTerminateGpu: (...args: unknown[]) => terminateMock.autoTerminateGpu(...args),
}));

// ── Import under test (after all mocks) ───────────────────────────────────────

import {
  scheduleAutoDestroy,
  clearAutoDestroyTimer,
  recoverPersistedDestroyTimer,
} from '../../server/gpu-destroy-timer';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetState(podId = 'pod-abc', provider = 'runpod') {
  fsState.fileExists = false;
  fsState.fileContent = '';
  fsState.writtenPath = '';
  fsState.writtenContent = '';
  fsState.shouldThrowRead = false;
  fsState.shouldThrowWrite = false;
  fsState.unlinkedPath = '';
  fsState.unlinkedCalled = false;
  stateRef.podId = podId;
  stateRef.deployId = 'deploy-xyz';
  stateRef.provider = provider;
  terminateMock.autoTerminateGpu.mockClear();
  broadcastMock.broadcastWs.mockClear();
  vi.clearAllMocks();
}

function makePersistedTimer(opts: { podId?: string; provider?: string; deadlineMs?: number } = {}) {
  return JSON.stringify({
    podId: opts.podId ?? 'pod-abc',
    provider: opts.provider ?? 'runpod',
    deadlineMs: opts.deadlineMs ?? Date.now() + 60_000,
  });
}

// ── scheduleAutoDestroy ───────────────────────────────────────────────────────

describe('scheduleAutoDestroy', () => {
  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAutoDestroyTimer();
    vi.useRealTimers();
  });

  it('writes a persist file with podId, provider, and a future deadlineMs', () => {
    const before = Date.now();
    scheduleAutoDestroy(60_000);
    const after = Date.now();
    expect(fsState.writtenContent).not.toBe('');
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved.podId).toBe('pod-abc');
    expect(saved.provider).toBe('runpod');
    expect(saved.deadlineMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(saved.deadlineMs).toBeLessThanOrEqual(after + 60_000);
  });

  it('persist file path contains destroy_timer.json', () => {
    scheduleAutoDestroy(60_000);
    expect(fsState.writtenPath).toContain('destroy_timer.json');
  });

  it('persist file path contains .babelcast directory', () => {
    scheduleAutoDestroy(60_000);
    expect(fsState.writtenPath).toContain('.babelcast');
  });

  it('captures active provider at call time', () => {
    stateRef.provider = 'vast';
    scheduleAutoDestroy(60_000);
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved.provider).toBe('vast');
  });

  it('captures active podId at call time', () => {
    stateRef.podId = 'pod-999';
    scheduleAutoDestroy(60_000);
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved.podId).toBe('pod-999');
  });

  it('fires timer callback after the specified delay', async () => {
    scheduleAutoDestroy(30_000);
    expect(terminateMock.autoTerminateGpu).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(terminateMock.autoTerminateGpu).toHaveBeenCalledWith('auto_destroy');
  });

  it('timer callback broadcasts gpu:idle destroy event', async () => {
    scheduleAutoDestroy(30_000);
    await vi.runAllTimersAsync();
    expect(broadcastMock.broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gpu:idle', action: 'destroy' }),
    );
  });

  it('timer callback broadcasts with correct podId and provider', async () => {
    stateRef.podId = 'pod-fire';
    stateRef.provider = 'tensordock';
    scheduleAutoDestroy(30_000);
    await vi.runAllTimersAsync();
    expect(broadcastMock.broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({ podId: 'pod-fire', provider: 'tensordock' }),
    );
  });

  it('does not fire early before delay elapses', () => {
    scheduleAutoDestroy(60_000);
    vi.advanceTimersByTime(30_000);
    expect(terminateMock.autoTerminateGpu).not.toHaveBeenCalled();
  });

  it('handles write failure without throwing', () => {
    fsState.shouldThrowWrite = true;
    expect(() => scheduleAutoDestroy(60_000)).not.toThrow();
  });

  it('clears any previously scheduled timer before arming a new one', async () => {
    scheduleAutoDestroy(60_000); // first timer
    scheduleAutoDestroy(30_000); // replaces it
    await vi.runAllTimersAsync();
    // Only one termination call — the first timer was cleared
    expect(terminateMock.autoTerminateGpu).toHaveBeenCalledTimes(1);
  });
});

// ── clearAutoDestroyTimer ─────────────────────────────────────────────────────

describe('clearAutoDestroyTimer', () => {
  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prevents a scheduled timer from firing', async () => {
    scheduleAutoDestroy(30_000);
    clearAutoDestroyTimer();
    await vi.runAllTimersAsync();
    expect(terminateMock.autoTerminateGpu).not.toHaveBeenCalled();
  });

  it('removes the persisted deadline file when it exists', () => {
    fsState.fileExists = true;
    clearAutoDestroyTimer();
    expect(fsState.unlinkedCalled).toBe(true);
    expect(fsState.unlinkedPath).toContain('destroy_timer.json');
  });

  it('does not throw when no timer is scheduled', () => {
    expect(() => clearAutoDestroyTimer()).not.toThrow();
  });

  it('does not throw when no persist file exists', () => {
    fsState.fileExists = false;
    expect(() => clearAutoDestroyTimer()).not.toThrow();
  });

  it('can be called multiple times safely', () => {
    expect(() => {
      clearAutoDestroyTimer();
      clearAutoDestroyTimer();
      clearAutoDestroyTimer();
    }).not.toThrow();
  });
});

// ── recoverPersistedDestroyTimer ──────────────────────────────────────────────

describe('recoverPersistedDestroyTimer', () => {
  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAutoDestroyTimer();
    vi.useRealTimers();
  });

  it('does nothing when no persist file exists', async () => {
    fsState.fileExists = false;
    await recoverPersistedDestroyTimer();
    expect(terminateMock.autoTerminateGpu).not.toHaveBeenCalled();
  });

  it('removes file and does nothing when podId does not match active deployState', async () => {
    fsState.fileExists = true;
    fsState.fileContent = makePersistedTimer({ podId: 'pod-OTHER', deadlineMs: Date.now() + 60_000 });
    stateRef.podId = 'pod-abc'; // different
    await recoverPersistedDestroyTimer();
    expect(terminateMock.autoTerminateGpu).not.toHaveBeenCalled();
    expect(fsState.unlinkedCalled).toBe(true);
  });

  it('removes file and does nothing when active podId is empty', async () => {
    fsState.fileExists = true;
    fsState.fileContent = makePersistedTimer({ podId: 'pod-abc', deadlineMs: Date.now() + 60_000 });
    stateRef.podId = ''; // empty — no active pod
    await recoverPersistedDestroyTimer();
    expect(terminateMock.autoTerminateGpu).not.toHaveBeenCalled();
    expect(fsState.unlinkedCalled).toBe(true);
  });

  it('calls autoTerminateGpu immediately when deadline already passed', async () => {
    fsState.fileExists = true;
    fsState.fileContent = makePersistedTimer({
      podId: 'pod-abc',
      deadlineMs: Date.now() - 1000, // already expired
    });
    await recoverPersistedDestroyTimer();
    expect(terminateMock.autoTerminateGpu).toHaveBeenCalledWith('auto_destroy');
  });

  it('removes the persist file after immediate termination', async () => {
    fsState.fileExists = true;
    fsState.fileContent = makePersistedTimer({
      podId: 'pod-abc',
      deadlineMs: Date.now() - 5000,
    });
    await recoverPersistedDestroyTimer();
    expect(fsState.unlinkedCalled).toBe(true);
  });

  it('re-arms timer for remaining duration when deadline is in the future', async () => {
    const futureDeadline = Date.now() + 45_000;
    fsState.fileExists = true;
    fsState.fileContent = makePersistedTimer({ podId: 'pod-abc', deadlineMs: futureDeadline });
    await recoverPersistedDestroyTimer();
    // Timer should not have fired yet
    expect(terminateMock.autoTerminateGpu).not.toHaveBeenCalled();
    // Advance past the remaining time
    await vi.runAllTimersAsync();
    expect(terminateMock.autoTerminateGpu).toHaveBeenCalledWith('auto_destroy');
  });

  it('calls autoTerminateGpu exactly once when deadline has passed', async () => {
    fsState.fileExists = true;
    fsState.fileContent = makePersistedTimer({
      podId: 'pod-abc',
      deadlineMs: Date.now() - 1,
    });
    await recoverPersistedDestroyTimer();
    expect(terminateMock.autoTerminateGpu).toHaveBeenCalledTimes(1);
  });

  it('handles malformed JSON without throwing', async () => {
    fsState.fileExists = true;
    fsState.fileContent = '{ invalid json {{{';
    await expect(recoverPersistedDestroyTimer()).resolves.toBeUndefined();
    expect(terminateMock.autoTerminateGpu).not.toHaveBeenCalled();
  });

  it('handles read error without throwing', async () => {
    fsState.fileExists = true;
    fsState.shouldThrowRead = true;
    await expect(recoverPersistedDestroyTimer()).resolves.toBeUndefined();
    expect(terminateMock.autoTerminateGpu).not.toHaveBeenCalled();
  });

  it('handles deadline exactly at 0 remaining (boundary) as expired', async () => {
    // remaining = deadlineMs - Date.now() <= 0 → fires immediately
    fsState.fileExists = true;
    fsState.fileContent = makePersistedTimer({ podId: 'pod-abc', deadlineMs: Date.now() });
    await recoverPersistedDestroyTimer();
    // Exactly at boundary — remaining is 0, treated as expired
    expect(terminateMock.autoTerminateGpu).toHaveBeenCalledWith('auto_destroy');
  });
});
