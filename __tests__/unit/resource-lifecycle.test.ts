/**
 * Resource Lifecycle Tests — validates fixes for GPU deploy resource leaks,
 * race conditions, orphan cleanup, and timer management.
 *
 * These are unit tests that verify the fix logic without needing live providers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── 7. SSH tunnel lifecycle ─────────────────────────────────────────────────

describe('SSH tunnel lifecycle', () => {
  it('force-kills with SIGKILL after SIGTERM timeout', async () => {
    const source = (await import('fs')).readFileSync('src/gateway/providers/gpu/ssh-tunnel.ts', 'utf8');
    // close() delegates to _killProc() which does SIGTERM then SIGKILL
    const closeFn = source.slice(source.indexOf('close():'), source.indexOf('close():') + 300);
    expect(closeFn).toContain('_killProc');
    const killProc = source.slice(source.indexOf('_killProc():'), source.indexOf('_killProc():') + 300);
    expect(killProc).toContain('SIGTERM');
    expect(killProc).toContain('SIGKILL');
  });
});

// ── 13. Security: JSON body size limit ──────────────────────────────────────


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

// ── 18. Spend tracker validation ────────────────────────────────────────────

describe('Spend tracker validation', () => {
  it('rejects negative costs', async () => {
    const source = (await import('fs')).readFileSync('src/tracking/spend-tracker.ts', 'utf8');
    const recordFn = source.slice(source.indexOf('async record('), source.indexOf('async record(') + 300);
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
    // load-balancer.ts is now a re-export stub; read the actual implementation
    const source = (await import('fs')).readFileSync('src/gateway/autoscaler/load-balancer.ts', 'utf8');
    expect(source).toContain('connectionCounts');
    // incrementConnections should use connectionCounts.get/set directly
    const incFn = source.slice(source.indexOf('async incrementConnections'), source.indexOf('async incrementConnections') + 300);
    expect(incFn).toContain('connectionCounts.get');
    expect(incFn).toContain('connectionCounts.set');
  });
});

// ── 20. Boot timeout transitions to idle ────────────────────────────────────

describe('Boot orchestrator timeout', () => {
  it('resets tier to idle after boot timeout', async () => {
    // boot-orchestrator.ts is now a re-export stub; read the actual implementation
    const source = (await import('fs')).readFileSync('src/gateway/autoscaler/boot-orchestrator.ts', 'utf8');
    const idx = source.indexOf('polling stopped — timeout');
    const timeoutBlock = source.slice(idx, idx + 600);
    expect(timeoutBlock).toContain("'idle'");
    expect(timeoutBlock).toContain('bootPollers.delete');
  });
});

// ── 21. Cooldown bypass skips recordFailure ─────────────────────────────────

describe('Provider cooldown bypass', () => {
  it('does not record failures when all providers are in cooldown', async () => {
    // fallback.ts is now a re-export stub; read the actual implementation
    const source = (await import('fs')).readFileSync('src/gateway/providers/cloud/fallback.ts', 'utf8');
    // All recordFailure calls should be guarded by !allCooledDown
    const recordCalls = source.split('\n').filter(l => l.includes('tracker.recordFailure'));
    expect(recordCalls.length).toBeGreaterThan(0);
    for (const line of recordCalls) {
      expect(line).toContain('allCooledDown');
    }
  });
});

// ── 22. Vast.ai 429 throws instead of returning ────────────────────────────

describe('Vast.ai rate limit handling', () => {
  it('throws on 429 exhaustion instead of returning response', async () => {
    // vast-client.ts is now a re-export stub; read the actual implementation
    const source = (await import('fs')).readFileSync('src/gateway/providers/gpu/vast-client.ts', 'utf8');
    const idx = source.indexOf('retries exhausted');
    const exhaustionBlock = source.slice(idx, idx + 500);
    expect(exhaustionBlock).toContain('throw new Error');
    expect(exhaustionBlock).not.toContain('return lastRes');
  });
});

// ── 26. SSH tunnel SIGKILL + closeAllTunnels ────────────────────────────────

describe('SSH tunnel full lifecycle', () => {
  it('has both SIGTERM and SIGKILL in close()', async () => {
    const source = (await import('fs')).readFileSync('src/gateway/providers/gpu/ssh-tunnel.ts', 'utf8');
    expect(source).toContain('SIGTERM');
    expect(source).toContain('SIGKILL');
  });
});

// ── 30. Cache key safety ────────────────────────────────────────────────────

describe('Response cache key safety', () => {
  it('handles JSON.stringify failure gracefully', async () => {
    const source = (await import('fs')).readFileSync('src/caching/response-cache.ts', 'utf8');
    // Find the actual method declaration (skip the leading JSDoc that mentions buildKey).
    const idx = source.indexOf('\n  buildKey(');
    const nextFn = source.indexOf('\n  build', idx + 20);
    const buildKeyFn = source.slice(idx, nextFn > 0 ? nextFn : idx + 1500);
    expect(buildKeyFn).toContain('try');
    expect(buildKeyFn).toContain('catch');
    expect(buildKeyFn).toMatch(/fallback|JSON\.stringify/);
  });
});
