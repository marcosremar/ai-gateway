/**
 * Unit tests for server/lightning-handlers.ts
 *
 * Covers:
 *  - handleLightningSessionStart — increments activeSessions, clears idle timer
 *  - handleLightningSessionEnd — decrements activeSessions, schedules idle stop at 0,
 *                                clamps to 0, skips stop when sessions remain open
 *  - handleLightningStatus — returns status + activeSessions, 500 on client error
 *  - handleLightningStart — calls start() + waitForRunning(), 500 on error
 *  - handleLightningStop — clears idle timer, calls stop(), 500 on error
 *  - Idle timer: fires stop() after IDLE_TIMEOUT_MS; skips if session reopened first
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted shared client mock ────────────────────────────────────────────────

const mockClientState = vi.hoisted(() => ({
  getStatus:      vi.fn(),
  start:          vi.fn(),
  stop:           vi.fn(),
  waitForRunning: vi.fn(),
}));

// Mock the lightning-client module. LightningAIClient must be a regular function
// (not an arrow function) so it can be used as a constructor with `new`.
vi.mock('../../src/cpu-providers/lightning-client', () => ({
  loadLightningConfig: vi.fn().mockReturnValue({
    apiKey:       'key',
    projectId:    'proj',
    cloudspaceId: 'cs',
    sshUser:      's_cs',
  }),
  // Regular (non-arrow) function so `new LightningAIClient()` works
  LightningAIClient: vi.fn(function () { return mockClientState; }),
}));

// Static import — module state persists across tests in this file.
// We drain `activeSessions` to 0 in beforeEach via the helper below.
import {
  handleLightningSessionStart,
  handleLightningSessionEnd,
  handleLightningStatus,
  handleLightningStart,
  handleLightningStop,
} from '../../server/lightning-handlers';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(): Request {
  return new Request('http://localhost', { method: 'POST' });
}

/** Drain activeSessions back to 0 so each test starts clean. */
async function drainSessions(): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    const res = await handleLightningSessionEnd(makeRequest());
    const data = await res.json() as { activeSessions: number };
    if (data.activeSessions === 0) return;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();

  // Reset mock defaults
  mockClientState.getStatus.mockResolvedValue({ phase: 'CLOUD_SPACE_INSTANCE_STATE_RUNNING' });
  mockClientState.start.mockResolvedValue(undefined);
  mockClientState.stop.mockResolvedValue(undefined);
  mockClientState.waitForRunning.mockResolvedValue({ phase: 'CLOUD_SPACE_INSTANCE_STATE_RUNNING' });

  // Clear any timers from previous test, then ensure sessions are at 0
  vi.clearAllTimers();
  await drainSessions();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ── handleLightningSessionStart ───────────────────────────────────────────────

describe('handleLightningSessionStart', () => {
  it('returns ok:true and activeSessions=1 on first open', async () => {
    const res = await handleLightningSessionStart(makeRequest());
    const data = await res.json() as any;
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.activeSessions).toBe(1);
  });

  it('increments counter on successive calls', async () => {
    await handleLightningSessionStart(makeRequest());
    const res = await handleLightningSessionStart(makeRequest());
    const data = await res.json() as any;
    expect(data.activeSessions).toBe(2);
  });

  it('cancels the pending idle timer when a session reopens', async () => {
    // Open then close to arm the idle timer
    await handleLightningSessionStart(makeRequest());
    await handleLightningSessionEnd(makeRequest());

    // Reopen — should cancel the pending stop
    await handleLightningSessionStart(makeRequest());

    // Advance past the idle timeout
    await vi.runAllTimersAsync();

    // stop() must NOT have been called (timer was cancelled)
    expect(mockClientState.stop).not.toHaveBeenCalled();
  });
});

// ── handleLightningSessionEnd ─────────────────────────────────────────────────

describe('handleLightningSessionEnd', () => {
  it('returns ok:true, activeSessions=0, and idleTimeoutMs when last session closes', async () => {
    await handleLightningSessionStart(makeRequest());
    const res = await handleLightningSessionEnd(makeRequest());
    const data = await res.json() as any;
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.activeSessions).toBe(0);
    expect(typeof data.idleTimeoutMs).toBe('number');
    expect(data.idleTimeoutMs).toBeGreaterThan(0);
  });

  it('clamps activeSessions to 0 when end is called without a prior start', async () => {
    // drainSessions already brought it to 0; call end again
    const res = await handleLightningSessionEnd(makeRequest());
    const data = await res.json() as any;
    expect(data.activeSessions).toBe(0);
  });

  it('does not schedule idle stop when sessions remain open', async () => {
    await handleLightningSessionStart(makeRequest());
    await handleLightningSessionStart(makeRequest());
    // Close one — still 1 active
    await handleLightningSessionEnd(makeRequest());

    await vi.runAllTimersAsync();
    expect(mockClientState.stop).not.toHaveBeenCalled();
  });

  it('schedules idle stop after last session closes', async () => {
    await handleLightningSessionStart(makeRequest());
    await handleLightningSessionEnd(makeRequest());

    // Timer armed; stop not yet called
    expect(mockClientState.stop).not.toHaveBeenCalled();

    // Advance past idle timeout (15 min)
    await vi.runAllTimersAsync();

    expect(mockClientState.stop).toHaveBeenCalledOnce();
  });

  it('skips stop() if a session reopens before the idle timer fires', async () => {
    await handleLightningSessionStart(makeRequest());
    await handleLightningSessionEnd(makeRequest());

    // Reopen before idle timeout
    await handleLightningSessionStart(makeRequest());

    await vi.runAllTimersAsync();

    expect(mockClientState.stop).not.toHaveBeenCalled();
  });

  it('skips stop() if the studio is not in RUNNING state when timer fires', async () => {
    mockClientState.getStatus.mockResolvedValue({ phase: 'CLOUD_SPACE_INSTANCE_STATE_STOPPED' });

    await handleLightningSessionStart(makeRequest());
    await handleLightningSessionEnd(makeRequest());
    await vi.runAllTimersAsync();

    expect(mockClientState.stop).not.toHaveBeenCalled();
  });

  it('swallows getStatus error inside idle timer without crashing', async () => {
    mockClientState.getStatus.mockRejectedValue(new Error('network error'));

    await handleLightningSessionStart(makeRequest());
    await handleLightningSessionEnd(makeRequest());

    // Timer fires — getStatus rejects; must not propagate
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
    expect(mockClientState.stop).not.toHaveBeenCalled();
  });

  it('decrements counter correctly across multiple open/close pairs', async () => {
    await handleLightningSessionStart(makeRequest());
    await handleLightningSessionStart(makeRequest());
    await handleLightningSessionStart(makeRequest());

    await handleLightningSessionEnd(makeRequest());
    const res = await handleLightningSessionEnd(makeRequest());
    const data = await res.json() as any;
    expect(data.activeSessions).toBe(1);
  });
});

// ── handleLightningStatus ─────────────────────────────────────────────────────

describe('handleLightningStatus', () => {
  it('returns status fields merged with activeSessions=0', async () => {
    const statusPayload = { phase: 'CLOUD_SPACE_INSTANCE_STATE_RUNNING', id: 'studio-1' };
    mockClientState.getStatus.mockResolvedValue(statusPayload);

    const res = await handleLightningStatus(makeRequest());
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.phase).toBe('CLOUD_SPACE_INSTANCE_STATE_RUNNING');
    expect(data.activeSessions).toBe(0);
  });

  it('includes activeSessions count when sessions are open', async () => {
    await handleLightningSessionStart(makeRequest());
    const res = await handleLightningStatus(makeRequest());
    const data = await res.json() as any;
    expect(data.activeSessions).toBe(1);
  });

  it('returns 500 when getStatus throws', async () => {
    mockClientState.getStatus.mockRejectedValue(new Error('API down'));

    const res = await handleLightningStatus(makeRequest());
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toMatch(/API down/);
  });
});

// ── handleLightningStart ──────────────────────────────────────────────────────

describe('handleLightningStart', () => {
  it('calls start() and waitForRunning(), returns ok:true with status', async () => {
    const runningStatus = { phase: 'CLOUD_SPACE_INSTANCE_STATE_RUNNING' };
    mockClientState.waitForRunning.mockResolvedValue(runningStatus);

    const res = await handleLightningStart(makeRequest());
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.phase).toBe('CLOUD_SPACE_INSTANCE_STATE_RUNNING');
    expect(mockClientState.start).toHaveBeenCalledOnce();
    expect(mockClientState.waitForRunning).toHaveBeenCalledOnce();
  });

  it('returns 500 when start() throws', async () => {
    mockClientState.start.mockRejectedValue(new Error('quota exceeded'));

    const res = await handleLightningStart(makeRequest());
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toMatch(/quota exceeded/);
  });

  it('returns 500 when waitForRunning() throws', async () => {
    mockClientState.waitForRunning.mockRejectedValue(new Error('timed out'));

    const res = await handleLightningStart(makeRequest());
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toMatch(/timed out/);
  });
});

// ── handleLightningStop ───────────────────────────────────────────────────────

describe('handleLightningStop', () => {
  it('calls stop() and returns ok:true', async () => {
    const res = await handleLightningStop(makeRequest());
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(mockClientState.stop).toHaveBeenCalledOnce();
  });

  it('cancels pending idle timer so stop() is called exactly once', async () => {
    // Arm idle timer
    await handleLightningSessionStart(makeRequest());
    await handleLightningSessionEnd(makeRequest());

    // Explicit stop — should clear the timer
    await handleLightningStop(makeRequest());
    expect(mockClientState.stop).toHaveBeenCalledOnce();

    // Advance past idle timeout — stop() must NOT fire again
    await vi.runAllTimersAsync();
    expect(mockClientState.stop).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when stop() throws', async () => {
    mockClientState.stop.mockRejectedValue(new Error('already stopped'));

    const res = await handleLightningStop(makeRequest());
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toMatch(/already stopped/);
  });
});
