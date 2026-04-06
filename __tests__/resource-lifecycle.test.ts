/**
 * Resource Lifecycle Tests — validates fixes for GPU deploy resource leaks,
 * race conditions, orphan cleanup, and timer management.
 *
 * These are unit tests that verify the fix logic without needing live providers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── 1. deployCancelled reset ────────────────────────────────────────────────

describe('deployCancelled lifecycle', () => {
  it('resetDeployState sets deployCancelled to true', async () => {
    const source = (await import('fs')).readFileSync('server/state.ts', 'utf8');
    const resetFn = source.slice(source.indexOf('export function resetDeployState'), source.indexOf('export function resetDeployState') + 300);
    // resetDeployState must set deployCancelled = true to signal old deploy to stop
    expect(resetFn).toContain('deployCancelled = true');
  });

  it('startDeployLoop resets deployCancelled to false', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    // The fix: startDeployLoop must call setDeployCancelled(false) before starting
    const loopStart = source.indexOf('export async function startDeployLoop');
    const loopBody = source.slice(loopStart, loopStart + 500);
    expect(loopBody).toContain('setDeployCancelled(false)');
  });
});

// ── 2. Monitor timer resilience ─────────────────────────────────────────────

describe('monitor timer lifecycle', () => {
  it('scheduleNextMonitorProbe reschedules inside finally block', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    const fnStart = source.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = source.indexOf('\nexport ', fnStart + 50);
    const fnBody = source.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    // The finally block must contain both monitorRunning reset AND reschedule
    const finallyIdx = fnBody.indexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(0);
    const finallyBlock = fnBody.slice(finallyIdx, finallyIdx + 200);
    expect(finallyBlock).toContain('monitorRunning = false');
    expect(finallyBlock).toContain('scheduleNextMonitorProbe');
  });

  it('orphaned pod cleanup triggers when status=error and podId exists', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    const fnStart = source.indexOf('export function scheduleNextMonitorProbe');
    const fnBody = source.slice(fnStart, fnStart + 800);
    // Must check for error state with existing pod
    expect(fnBody).toContain("deployState.status === 'error'");
    expect(fnBody).toContain('deployState.podId');
    expect(fnBody).toContain('autoTerminateGpu');
  });
});

// ── 3. Warmth monitor cleanup ───────────────────────────────────────────────

describe('warmth monitor lifecycle', () => {
  it('calls stopWarmthMonitor when pod changes (not just null assignment)', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    const pollIdx = source.indexOf("'[gpu] Warmth monitor: pod changed or offline");
    expect(pollIdx).toBeGreaterThan(0);
    // Should call stopWarmthMonitor(), not just set warmthMonitorTimer = null
    const nearby = source.slice(pollIdx - 100, pollIdx + 200);
    expect(nearby).toContain('stopWarmthMonitor()');
    expect(nearby).not.toContain('warmthMonitorTimer = null');
  });
});

// ── 4. Budget tracking accuracy ─────────────────────────────────────────────

describe('budget tracking', () => {
  it('uses actual elapsed time instead of assumed monitorDelayMs', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    const budgetSection = source.slice(
      source.indexOf('Budget tracking: accumulate'),
      source.indexOf('Budget tracking: accumulate') + 500,
    );
    // Should use actual elapsed calculation, not monitorDelayMs
    expect(budgetSection).toContain('lastBudgetCalcTime');
    expect(budgetSection).toContain('actualElapsedMs');
    // Should NOT use monitorDelayMs directly for budget calculation
    expect(budgetSection).not.toContain('costPerHr * (monitorDelayMs /');
  });
});

// ── 5. Orphan sweep scheduling ──────────────────────────────────────────────

describe('orphan sweep lifecycle', () => {
  it('tracks initial sweep timeout to prevent double-scheduling', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    // Must have orphanSweepInitialTimer variable
    expect(source).toContain('orphanSweepInitialTimer');
    // startOrphanSweep must check both timers
    const fnStart = source.indexOf('export function startOrphanSweep');
    const fnBody = source.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain('orphanSweepInitialTimer');
    expect(fnBody).toContain('orphanSweepTimer');
  });

  it('stopOrphanSweep clears both timers', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    const fnStart = source.indexOf('export function stopOrphanSweep');
    const fnBody = source.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('clearTimeout(orphanSweepInitialTimer)');
    expect(fnBody).toContain('clearInterval(orphanSweepTimer)');
  });
});

// ── 6. WebSocket broadcast safety ───────────────────────────────────────────

describe('WebSocket broadcast', () => {
  it('does not mutate Set during iteration (collect-then-delete)', async () => {
    const source = (await import('fs')).readFileSync('server/ws-state.ts', 'utf8');
    const broadcastFn = source.slice(
      source.indexOf('export function broadcastWs'),
      source.indexOf('export function broadcastWs') + 400,
    );
    // Should collect dead clients, then delete in separate loop
    expect(broadcastFn).toContain('dead');
    expect(broadcastFn).toContain('dead.push');
    // Should NOT delete inside the for-of iteration
    expect(broadcastFn).not.toMatch(/for.*wsClients.*\{[^}]*wsClients\.delete/s);
  });
});

// ── 7. SSH tunnel lifecycle ─────────────────────────────────────────────────

describe('SSH tunnel lifecycle', () => {
  it('force-kills with SIGKILL after SIGTERM timeout', async () => {
    const source = (await import('fs')).readFileSync('server/ssh-tunnel.ts', 'utf8');
    const closeFn = source.slice(source.indexOf('close():'), source.indexOf('close():') + 300);
    expect(closeFn).toContain('SIGTERM');
    expect(closeFn).toContain('SIGKILL');
  });

  it('closeAllTunnels is called during autoTerminateGpu', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    const terminateFn = source.slice(
      source.indexOf('export async function autoTerminateGpu'),
      source.indexOf('export async function autoTerminateGpu') + 600,
    );
    expect(terminateFn).toContain('closeAllTunnels');
  });
});

// ── 8. STT session cleanup ──────────────────────────────────────────────────

describe('STT session cleanup', () => {
  it('has periodic cleanup interval for stale sessions', async () => {
    const source = (await import('fs')).readFileSync('server/ws-server.ts', 'utf8');
    // Should have a setInterval that cleans up stale STT sessions
    expect(source).toContain('stale STT session');
    expect(source).toContain('sttSessions.delete');
  });
});

// ── 9. Race deploy cleanup ──────────────────────────────────────────────────

describe('race deploy cleanup', () => {
  it('wraps Promise.all in try/finally for guaranteed cleanup', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    const raceStart = source.indexOf('export async function startDeployRace');
    const raceEnd = source.indexOf('\nexport ', raceStart + 100);
    const raceBody = source.slice(raceStart, raceEnd > 0 ? raceEnd : raceStart + 20000);
    // Must have try around Promise.all
    expect(raceBody).toContain('try {');
    expect(raceBody).toContain('await Promise.all(candidates.map');
    // Must have catch for force-cleanup
    expect(raceBody).toContain('Force-clean');
    // Must have finally to clear activeRaceInstanceIds
    expect(raceBody).toContain('finally {');
    expect(raceBody).toContain('activeRaceInstanceIds.delete');
  });
});

// ── 10. Transitions array efficiency ────────────────────────────────────────

describe('transitions array management', () => {
  it('uses splice (in-place) instead of slice (copy) for truncation', async () => {
    const source = (await import('fs')).readFileSync('server/state.ts', 'utf8');
    // Should use splice for in-place truncation
    expect(source).toContain('transitions.splice(0');
    // Should NOT use slice for truncation (creates unnecessary copy)
    expect(source).not.toContain('transitions = deployState.transitions.slice(-30)');
  });
});

// ── 11. Binary-safe body transfer ───────────────────────────────────────────

describe('Bun adapter binary safety', () => {
  it('uses arrayBuffer instead of text for body transfer', async () => {
    const source = (await import('fs')).readFileSync('server/ws-server.ts', 'utf8');
    // The main handler adapter must use arrayBuffer (binary-safe)
    expect(source).toContain('req.arrayBuffer()');
    // Should NOT use req.text() for body (corrupts binary data)
    const adapters = source.match(/Node.*Bun adapter[\s\S]{0,200}/g) || [];
    for (const adapter of adapters) {
      expect(adapter).not.toContain('req.text()');
    }
  });
});

// ── 12. HTTP status code propagation ────────────────────────────────────────

describe('HTTP status code propagation', () => {
  it('writeHead updates statusCode used by end()', async () => {
    const source = (await import('fs')).readFileSync('server/ws-server.ts', 'utf8');
    // All fakeRes adapters must use statusCode directly (not fakeRes.statusCode || statusCode)
    expect(source).not.toContain('fakeRes.statusCode || statusCode');
    // writeHead must sync fakeRes.statusCode (check full lines, not just the arrow)
    const writeHeadLines = source.split('\n').filter(l => l.includes('writeHead:') && l.includes('=>'));
    expect(writeHeadLines.length).toBeGreaterThan(0);
    for (const line of writeHeadLines) {
      expect(line).toContain('fakeRes.statusCode = code');
    }
  });
});
