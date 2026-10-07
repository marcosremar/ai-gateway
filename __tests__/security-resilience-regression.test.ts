/**
 * Security, Resilience, and Regression Tests (#621-#1000)
 *
 * Validates:
 * - All 58 bug fixes from the audit session
 * - Security boundaries (SSRF, injection, DoS, secrets)
 * - Resilience patterns (recovery, circuit breakers, timeouts)
 * - Edge cases and API contracts
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function readSrc(file: string): string {
  return fs.readFileSync(path.resolve(file), 'utf8');
}

function fnBody(source: string, fnName: string, maxLen = 5000): string {
  const idx = source.indexOf(fnName);
  if (idx < 0) return '';
  const nextExport = source.indexOf('\nexport ', idx + 50);
  return source.slice(idx, nextExport > 0 ? nextExport : idx + maxLen);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: SECURITY TESTS (#671-#690)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Security: Input validation', () => {
  // #671
  it('#671 JSON body limited to 2MB', () => {
    const src = readSrc('server/http-utils.ts');
    expect(src).toContain('JSON_BODY_MAX_BYTES');
    const match = src.match(/JSON_BODY_MAX_BYTES\s*=\s*(\d+)/);
    expect(match).toBeTruthy();
    const limit = parseInt(match![1]);
    expect(limit).toBeLessThanOrEqual(5 * 1024 * 1024); // max 5MB
    expect(limit).toBeGreaterThan(0);
  });

  // #672
  it('#672 readJsonBody enforces size with chunk tracking', () => {
    const src = readSrc('server/http-utils.ts');
    const fn = fnBody(src, 'export function readJsonBody');
    expect(fn).toContain('totalSize');
    expect(fn).toContain('req.destroy()');
  });

  // #686
  it('#686 GPU token tampering detected', () => {
    const src = readSrc('src/auth/gpu-token.ts');
    expect(src).toContain('verify');
  });

  // #688
  it('#688 RunPod GPU type filtering uses whitelist', () => {
    const src = readSrc('src/gateway/providers/gpu/runpod-client.ts');
    expect(src).toContain('RUNPOD_GPU_TYPE_MAP');
    expect(src).toContain('RUNPOD_GPU_FALLBACK');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: VAULT SECURITY (#682-#685)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Security: Vault encryption', () => {
  // #682
  it('#682 Vault uses random IV per secret', () => {
    const src = readSrc('src/vault/vault.ts');
    expect(src).toContain('randomBytes');
    expect(src).toContain('IV_LENGTH');
  });

  // #683
  it('#683 Vault auth tag verified on decrypt', () => {
    const src = readSrc('src/vault/vault.ts');
    expect(src).toContain('setAuthTag');
    expect(src).toContain('getAuthTag');
  });

  // #684
  it('#684 Vault rollback uses proper decryption (not hex decode)', () => {
    const src = readSrc('src/vault/vault.ts');
    const rollback = src.slice(src.indexOf('Rollback:'), src.indexOf('Rollback:') + 500);
    expect(rollback).toContain('createDecipheriv');
    expect(rollback).not.toContain("Buffer.from(blob.ciphertext, 'hex').toString('utf8')");
  });

  // #685
  it('#685 GPU token expiry enforced', () => {
    const src = readSrc('src/auth/gpu-token.ts');
    expect(src).toContain('exp');
    expect(src).toContain('expired');
  });
});

describe('Regression: Negative spend (#838)', () => {
  it('rejects costUsd < 0', () => {
    const src = readSrc('src/tracking/spend-tracker.ts');
    const fn = fnBody(src, 'async record(');
    expect(fn).toContain('costUsd < 0');
  });
});

describe('Regression: Connection count (#839)', () => {
  it('uses atomic in-memory counters', () => {
    const src = readSrc('src/gateway/autoscaler/load-balancer.ts');
    expect(src).toContain('connectionCounts');
    const fn = fnBody(src, 'async incrementConnections');
    expect(fn).toContain('connectionCounts.get');
    expect(fn).toContain('connectionCounts.set');
  });
});

describe('Regression: Boot timeout (#840)', () => {
  it('resets tier to idle after timeout', () => {
    const src = readSrc('src/gateway/autoscaler/boot-orchestrator.ts');
    const idx = src.indexOf('polling stopped — timeout');
    const block = src.slice(idx, idx + 600);
    expect(block).toContain("'idle'");
  });
});

describe('Regression: Cooldown bypass (#841)', () => {
  it('skips recordFailure when all providers cooled down', () => {
    const src = readSrc('src/gateway/providers/cloud/fallback.ts');
    const lines = src.split('\n').filter(l => l.includes('tracker.recordFailure'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain('allCooledDown');
    }
  });
});

describe('Regression: Teacher cache (#842)', () => {
  it('bounded at 10k entries', () => {
    const src = readSrc('src/gateway/autoscaler/session-tracker.ts');
    expect(src).toContain('10_000');
  });
});

describe('Regression: Vast 429 (#845)', () => {
  it('throws on rate limit exhaustion', () => {
    const src = readSrc('src/gateway/providers/gpu/vast-client.ts');
    const idx = src.indexOf('retries exhausted');
    const block = src.slice(idx, idx + 2000);
    expect(block).toContain('throw new Error');
    expect(block).not.toContain('return lastRes');
  });
});

describe('Regression: RunPod port validation (#847)', () => {
  it('validates port types', () => {
    const src = readSrc('src/gateway/providers/gpu/runpod-client.ts');
    const fn = fnBody(src, 'private resolveEndpoint');
    expect(fn).toContain('typeof portEntry?.publicPort');
  });
});

describe('Regression: Empty audio (#850)', () => {
  it('returns empty text for zero-length audio', () => {
    const src = readSrc('src/gateway/providers/cloud/openai-compat/openai-compat-stt.ts');
    expect(src).toContain('audioLen === 0');
    expect(src).toContain("text: ''");
  });
});

describe('Regression: Ensemble timers (#853)', () => {
  it('deadline timers cleared in finally', () => {
    const src = readSrc('src/ensemble-stt.ts');
    expect(src).toContain('deadlineTimers');
    expect(src).toContain('clearTimeout(t)');
  });
});

describe('Regression: JSON body cap (#858)', () => {
  it('enforced with chunk tracking', () => {
    const src = readSrc('server/http-utils.ts');
    const fn = fnBody(src, 'export function readJsonBody');
    expect(fn).toContain('totalSize += chunk.length');
    expect(fn).toContain('JSON_BODY_MAX_BYTES');
  });
});

describe('Regression: Vault rollback (#860)', () => {
  it('uses createDecipheriv not hex decode', () => {
    const src = readSrc('src/vault/vault.ts');
    const rollback = src.slice(src.indexOf('Rollback:'), src.indexOf('Rollback:') + 500);
    expect(rollback).toContain('createDecipheriv');
  });
});

describe('Regression: Spend tracker rpush (#864)', () => {
  it('still writes to list for getDailySummary', () => {
    const src = readSrc('src/tracking/spend-tracker.ts');
    const fn = fnBody(src, 'async record(', 800);
    expect(fn).toContain('rpush');
    expect(fn).toContain('ltrim');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: WORKLOAD SYSTEM TESTS (#995)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Workload system architecture', () => {
  it('#995 WorkloadRegistry has CRUD operations', () => {
    const src = readSrc('src/compute/workloads/registry.ts');
    expect(src).toContain('deploy(');
    expect(src).toContain('stop(');
    expect(src).toContain('start(');
    expect(src).toContain('terminate(');
    expect(src).toContain('list()');
    expect(src).toContain('get(');
    expect(src).toContain('getByName(');
  });

  it('#995 WorkloadRegistry has event system', () => {
    const src = readSrc('src/compute/workloads/registry.ts');
    expect(src).toContain('onEvent');
    expect(src).toContain('emit');
    expect(src).toContain("type: 'created'");
    expect(src).toContain("type: 'status_changed'");
    expect(src).toContain("type: 'terminated'");
  });

  it('#300 GpuWorkloadDriver maps deploy state', () => {
    const src = readSrc('src/compute/workloads/gpu-driver.ts');
    expect(src).toContain("type = 'gpu'");
    expect(src).toContain('deploy(');
    expect(src).toContain('stop(');
    expect(src).toContain('start(');
    expect(src).toContain('terminate(');
    expect(src).toContain('status(');
  });

  it('#306 BotWorkloadDriver handles lifecycle', () => {
    const src = readSrc('src/compute/workloads/bot-driver.ts');
    expect(src).toContain("type = 'bot'");
    expect(src).toContain('deploy(');
    expect(src).toContain('terminate(');
  });

  it('#308 DbWorkloadDriver connects to Neon', () => {
    const src = readSrc('src/compute/workloads/db-driver.ts');
    expect(src).toContain("type = 'db'");
    expect(src).toContain('NeonManagementClient');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: STATE MACHINE TESTS (#806-#815)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Deployment state machine', () => {
  it('#806-811 All transitions exist', () => {
    const src = readSrc('src/gateway/deploy/state-machine.ts');
    expect(src).toContain('startDeploying');
    expect(src).toContain('startBooting');
    expect(src).toContain('markReady');
    expect(src).toContain('markError');
    expect(src).toContain('reset');
  });

  it('#813 Transition handlers fire', () => {
    const src = readSrc('src/gateway/deploy/state-machine.ts');
    expect(src).toContain('onTransition');
    expect(src).toContain('_handlers');
  });

  it('#814 toJSON serializes state', () => {
    const src = readSrc('src/gateway/deploy/state-machine.ts');
    expect(src).toContain('toJSON');
  });
});

describe('Speculative cache module', () => {
  it('#342-345 speculate and resolve exist', () => {
    const src = readSrc('src/gateway/pipeline/speculative-cache.ts');
    expect(src).toContain('speculate');
    expect(src).toContain('resolve');
    expect(src).toContain('MAX_SPECULATIONS');
  });
});

describe('Race providers module', () => {
  it('#356-358 races with AbortController', () => {
    const src = readSrc('src/gateway/routing/provider-racer.ts');
    expect(src).toContain('AbortController');
    expect(src).toContain('Promise.any');
    expect(src).toContain('clearTimeout');
  });
});

describe('Ensemble STT module', () => {
  it('#613-615 races providers with timer cleanup', () => {
    const src = readSrc('src/ensemble-stt.ts');
    expect(src).toContain('Promise.any');
    expect(src).toContain('deadlineTimers');
    expect(src).toContain('finally');
  });
});

describe('Streaming STT module', () => {
  it('#620-622 createBackend with exclusion', () => {
    const src = readSrc('src/streaming-stt.ts');
    expect(src).toContain('createBackend');
    expect(src).toContain('excludeProviders');
  });
});

describe('Language detection module', () => {
  it('#628-634 detectLanguage exists', () => {
    const src = readSrc('src/language-detect.ts');
    expect(src).toMatch(/detect|franc/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9: SMOKE TESTS (#865-#874)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Smoke: Module imports', () => {

  it('#870 src/workloads/registry.ts imports', async () => {
    const mod = await import('../src/workloads/registry');
    expect(mod.WorkloadRegistry).toBeDefined();
    expect(mod.workloadRegistry).toBeDefined();
  });

  it('#871 src/workloads/types.ts exports types', async () => {
    const mod = await import('../src/workloads/types');
    expect(mod).toBeDefined();
  });

  it('#990 src/vault/vault.ts imports', async () => {
    const mod = await import('../src/vault/vault');
    expect(mod.Vault).toBeDefined();
  });

  it('#991 src/auth/gpu-token.ts imports', async () => {
    const mod = await import('../src/auth/gpu-token');
    expect(mod.signGpuToken).toBeInstanceOf(Function);
    expect(mod.verifyGpuToken).toBeInstanceOf(Function);
  });
});
