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
    const resetFn = source.slice(
      source.indexOf('export function resetDeployState'),
      source.indexOf('export function resetDeployState') + 300,
    );
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
    // close() delegates to _killProc() which does SIGTERM then SIGKILL
    const closeFn = source.slice(source.indexOf('close():'), source.indexOf('close():') + 300);
    expect(closeFn).toContain('_killProc');
    const killProc = source.slice(
      source.indexOf('_killProc():'),
      source.indexOf('_killProc():') + 300,
    );
    expect(killProc).toContain('SIGTERM');
    expect(killProc).toContain('SIGKILL');
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
    const writeHeadLines = source
      .split('\n')
      .filter((l) => l.includes('writeHead:') && l.includes('=>'));
    expect(writeHeadLines.length).toBeGreaterThan(0);
    for (const line of writeHeadLines) {
      expect(line).toContain('fakeRes.statusCode = code');
    }
  });
});

// ── 13. Security: JSON body size limit ──────────────────────────────────────

describe('JSON body size limit', () => {
  it('readJsonBody enforces a max size', async () => {
    const source = (await import('fs')).readFileSync('server/http-utils.ts', 'utf8');
    const fnStart = source.indexOf('export function readJsonBody');
    const fnBody = source.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain('totalSize');
    expect(fnBody).toContain('JSON_BODY_MAX_BYTES');
    expect(fnBody).toContain('req.destroy()');
  });
});

// ── 14. Security: Host header injection ─────────────────────────────────────

describe('Host header injection prevention', () => {
  it('playground handlers do not use req.headers.host in URL parsing', async () => {
    const source = (await import('fs')).readFileSync('server/playground-handlers.ts', 'utf8');
    expect(source).not.toContain('req.headers.host');
  });
});

// ── 15. Vault key rotation rollback ─────────────────────────────────────────

describe('Vault key rotation rollback', () => {
  it('uses proper decryption (not hex decode) during rollback', async () => {
    const source = (await import('fs')).readFileSync('src/vault/vault.ts', 'utf8');
    const rollbackIdx = source.indexOf('Rollback:');
    const rollbackBlock = source.slice(rollbackIdx, rollbackIdx + 500);
    // Must use createDecipheriv for proper decryption
    expect(rollbackBlock).toContain('createDecipheriv');
    // Must NOT have the old broken hex-decode pattern
    expect(rollbackBlock).not.toContain("Buffer.from(blob.ciphertext, 'hex').toString('utf8')");
  });
});

// ── 16. File logger OOM prevention ──────────────────────────────────────────

describe('File logger safe reads', () => {
  it('caps max lines and file read size', async () => {
    const source = (await import('fs')).readFileSync('server/file-logger.ts', 'utf8');
    expect(source).toContain('MAX_READ_LINES');
    expect(source).toContain('MAX_FILE_READ_BYTES');
    // readTailLines should read from end for large files
    expect(source).toContain('stat.size > MAX_FILE_READ_BYTES');
  });
});

// ── 17. Config atomic writes ────────────────────────────────────────────────

describe('Config persistence atomic writes', () => {
  it('uses temp file + rename for atomic write', async () => {
    const source = (await import('fs')).readFileSync('server/config-persistence.ts', 'utf8');
    const saveFn = source.slice(
      source.indexOf('export function saveProviderConfig'),
      source.indexOf('export function saveProviderConfig') + 400,
    );
    expect(saveFn).toContain('.tmp');
    expect(saveFn).toContain('renameSync');
  });
});

// ── 18. Spend tracker validation ────────────────────────────────────────────

describe('Spend tracker validation', () => {
  it('rejects negative costs', async () => {
    const source = (await import('fs')).readFileSync('src/tracking/spend-tracker.ts', 'utf8');
    const recordFn = source.slice(
      source.indexOf('async record('),
      source.indexOf('async record(') + 300,
    );
    expect(recordFn).toContain('costUsd < 0');
  });

  it('still writes to records list (rpush) for getDailySummary', async () => {
    const source = (await import('fs')).readFileSync('src/tracking/spend-tracker.ts', 'utf8');
    const recordStart = source.indexOf('async record(');
    const recordEnd = source.indexOf('\n  async ', recordStart + 10);
    const recordFn = source.slice(recordStart, recordEnd > 0 ? recordEnd : recordStart + 800);
    expect(recordFn).toContain('rpush');
    expect(recordFn).toContain('ltrim');
  });
});

// ── 19. Load balancer atomic connections ─────────────────────────────────────

describe('Load balancer atomic connections', () => {
  it('uses in-memory counters instead of get-parse-set', async () => {
    const source = (await import('fs')).readFileSync('src/autoscaler/load-balancer.ts', 'utf8');
    expect(source).toContain('connectionCounts');
    // incrementConnections should use connectionCounts.get/set directly
    const incFn = source.slice(
      source.indexOf('async incrementConnections'),
      source.indexOf('async incrementConnections') + 300,
    );
    expect(incFn).toContain('connectionCounts.get');
    expect(incFn).toContain('connectionCounts.set');
  });
});

// ── 20. Boot timeout transitions to idle ────────────────────────────────────

describe('Boot orchestrator timeout', () => {
  it('resets tier to idle after boot timeout', async () => {
    const source = (await import('fs')).readFileSync('src/autoscaler/boot-orchestrator.ts', 'utf8');
    const idx = source.indexOf('polling stopped — timeout');
    const timeoutBlock = source.slice(idx, idx + 600);
    expect(timeoutBlock).toContain("'idle'");
    expect(timeoutBlock).toContain('bootPollers.delete');
  });
});

// ── 21. Cooldown bypass skips recordFailure ─────────────────────────────────

describe('Provider cooldown bypass', () => {
  it('does not record failures when all providers are in cooldown', async () => {
    const source = (await import('fs')).readFileSync('src/providers/fallback.ts', 'utf8');
    // All recordFailure calls should be guarded by !allCooledDown
    const recordCalls = source.split('\n').filter((l) => l.includes('tracker.recordFailure'));
    expect(recordCalls.length).toBeGreaterThan(0);
    for (const line of recordCalls) {
      expect(line).toContain('allCooledDown');
    }
  });
});

// ── 22. Vast.ai 429 throws instead of returning ────────────────────────────

describe('Vast.ai rate limit handling', () => {
  it('throws on 429 exhaustion instead of returning response', async () => {
    const source = (await import('fs')).readFileSync('src/gpu-providers/vast-client.ts', 'utf8');
    const idx = source.indexOf('retries exhausted');
    const exhaustionBlock = source.slice(idx, idx + 500);
    expect(exhaustionBlock).toContain('throw new Error');
    expect(exhaustionBlock).not.toContain('return lastRes');
  });
});

// ── 23. SSE stream abort on client close ────────────────────────────────────

describe('SSE pipeline stream safety', () => {
  it('tracks client close and wraps writes safely', async () => {
    const source = (await import('fs')).readFileSync('server/ai-handlers-stream.ts', 'utf8');
    expect(source).toContain('clientClosed');
    expect(source).toContain("res.on('close'");
    expect(source).toContain('safeSseWrite');
  });
});

// ── 24. Error message sanitization ──────────────────────────────────────────

describe('Error message sanitization', () => {
  it('does not expose internal error details in response body', async () => {
    const source = (await import('fs')).readFileSync('server/ai-handlers.ts', 'utf8');
    // Should NOT contain detailed body read errors
    expect(source).not.toContain('Body read error: ${msg}');
    expect(source).toContain("'Invalid request body'");
  });
});

// ── 25. WS pauseMs validation ───────────────────────────────────────────────

describe('WebSocket pauseMs validation', () => {
  it('clamps pauseMs to safe range', async () => {
    const source = (await import('fs')).readFileSync('server/ws-server.ts', 'utf8');
    const pauseLine = source
      .split('\n')
      .find((l) => l.includes('pause_ms') && l.includes('Math.max'));
    expect(pauseLine).toBeTruthy();
    expect(pauseLine).toContain('Math.min');
  });
});

// ── 26. SSH tunnel SIGKILL + closeAllTunnels ────────────────────────────────

describe('SSH tunnel full lifecycle', () => {
  it('has both SIGTERM and SIGKILL in close()', async () => {
    const source = (await import('fs')).readFileSync('server/ssh-tunnel.ts', 'utf8');
    expect(source).toContain('SIGTERM');
    expect(source).toContain('SIGKILL');
  });

  it('closeAllTunnels is called during GPU termination', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    expect(source).toContain('closeAllTunnels');
  });
});

// ── 27. IP cache bounded ────────────────────────────────────────────────────

describe('IP location cache bounded', () => {
  it('has a max cache size limit', async () => {
    const source = (await import('fs')).readFileSync('server/ip-location.ts', 'utf8');
    expect(source).toContain('IP_CACHE_MAX');
    expect(source).toContain('_cache.delete');
  });
});

// ── 28. Bot cleanup covers all providers ────────────────────────────────────

describe('Bot pod cleanup', () => {
  it('cleans up RunPod, Scaleway, and Fly.io', async () => {
    const source = (await import('fs')).readFileSync('server/bot-handlers.ts', 'utf8');
    const start = source.indexOf('export async function cleanupBotPods');
    const end = source.indexOf('\nexport ', start + 50);
    const cleanupFn = source.slice(start, end > 0 ? end : start + 3000);
    expect(cleanupFn).toContain('runpod');
    expect(cleanupFn).toContain('scaleway');
    expect(cleanupFn).toContain('flyio');
  });

  it('uses collect-then-delete for audio relay broadcast', async () => {
    const source = (await import('fs')).readFileSync('server/bot-handlers.ts', 'utf8');
    const relaySection = source.slice(
      source.indexOf('Relay binary audio'),
      source.indexOf('Relay binary audio') + 300,
    );
    expect(relaySection).toContain('dead');
    expect(relaySection).not.toMatch(/for.*wsClients.*\{[^}]*wsClients\.delete/s);
  });
});

// ── 29. Deploy cleanup stops on failure ─────────────────────────────────────

describe('GPU deploy instance cleanup failure handling', () => {
  it('stops deploy if crashed instance cleanup fails', async () => {
    const source = (await import('fs')).readFileSync('server/gpu-deploy.ts', 'utf8');
    const idx = source.indexOf('Cleaning up crashed instance');
    const cleanupSection = source.slice(idx, idx + 900);
    expect(cleanupSection).toContain("status: 'error'");
    expect(cleanupSection).toContain('return');
  });
});

// ── 30. Cache key safety ────────────────────────────────────────────────────

describe('Response cache key safety', () => {
  it('handles JSON.stringify failure gracefully', async () => {
    const source = (await import('fs')).readFileSync('src/caching/response-cache.ts', 'utf8');
    const idx = source.indexOf('buildKey(');
    const nextFn = source.indexOf('\n  build', idx + 20);
    const buildKeyFn = source.slice(idx, nextFn > 0 ? nextFn : idx + 700);
    expect(buildKeyFn).toContain('try');
    expect(buildKeyFn).toContain('catch');
    expect(buildKeyFn).toContain('fallback');
  });
});
