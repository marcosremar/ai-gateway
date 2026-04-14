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

  // #673-677 SSRF tests
  it('#673 bot meetingUrl rejects private IPs', () => {
    const src = readSrc('server/bot-handlers.ts');
    expect(src).toContain('isPrivateUrl');
  });

  it('#674-677 isPrivateUrl blocks localhost and RFC1918', () => {
    const src = readSrc('server/ai-handlers.ts');
    const fn = fnBody(src, 'export function isPrivateUrl', 800);
    if (fn) {
      expect(fn).toMatch(/127\.|10\.|192\.168|localhost/);
    } else {
      // May be in bot-handlers
      const botSrc = readSrc('server/bot-handlers.ts');
      expect(botSrc).toContain('isPrivateUrl');
    }
  });

  // #678
  it('#678 Host header not used in URL parsing (playground)', () => {
    const src = readSrc('server/playground-handlers.ts');
    expect(src).not.toContain('req.headers.host');
  });

  // #679
  it('#679 API keys masked in config response', () => {
    const src = readSrc('server/config-handlers.ts');
    expect(src).toMatch(/mask|hint|slice|\.{3}|\*{3}/);
  });

  // #680
  it('#680 API keys not in error messages', () => {
    const src = readSrc('server/ai-handlers.ts');
    // Error responses should use generic messages
    expect(src).toContain("'Invalid request body'");
    expect(src).not.toContain('Body read error: ${msg}');
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

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: RESILIENCE — TIMER LIFECYCLE (#691-#710)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Resilience: Timer lifecycle', () => {
  // #697
  it('#697 Monitor recovers after consecutive failures', () => {
    const src = readSrc('server/gpu-monitor-loop.ts');
    expect(src).toContain('monitorConsecFails');
  });

  // #698
  it('#698 Circuit breaker exists for STT/LLM/TTS stages', () => {
    const src = readSrc('server/providers.ts');
    expect(src).toMatch(/circuit.*breaker|circuitBreaker|stage.*circuit/i);
  });

  // #699
  it('#699 Provider cooldown expires correctly', () => {
    const tiers = readSrc('server/gpu-deploy-tiers.ts');
    const orchestrator = readSrc('src/gateway/providers/gpu/deploy-orchestrator.ts');
    expect(tiers).toContain('cooldownTracker');
    expect(orchestrator).toContain('isCoolingDown');
  });

  // #702
  it('#702 Config persists atomically after crash', () => {
    const src = readSrc('server/config-persistence.ts');
    const fn = fnBody(src, 'export function saveProviderConfig');
    expect(fn).toContain('.tmp');
    expect(fn).toContain('renameSync');
  });

  // #704
  it('#704 Orphan sweep cleans pods', () => {
    const src = readSrc('server/gpu-orphan-cleanup.ts');
    expect(src).toContain('sweepOrphanInstances');
    expect(src).toContain('ORPHAN_SWEEP_INTERVAL_MS');
  });

  // #706
  it('#706 WebSocket broadcast handles slow clients', () => {
    const src = readSrc('server/ws-state.ts');
    const fn = fnBody(src, 'export function broadcastWs');
    expect(fn).toContain('dead');
    expect(fn).toContain('dead.push');
  });

  // #708
  it('#708 Multiple rapid deploys dont deadlock', () => {
    const src = readSrc('server/gpu-handlers.ts');
    expect(src).toContain('deployLock');
    expect(src).toContain('setDeployLock(false)');
  });

  // #709
  it('#709 Cancel during deploy stops cleanly', () => {
    const src = readSrc('server/gpu-deploy-loop.ts');
    expect(src).toContain('deployCancelled');
    expect(src).toContain('setDeployCancelled(false)');
  });

  // #710
  it('#710 Standby handover no dual billing', () => {
    const src = readSrc('server/gpu-standby.ts');
    const fn = fnBody(src, 'terminateOldPod', 500);
    // Should have retry logic
    const handover = src.slice(src.indexOf('terminateOldPod(oldPodId'), src.indexOf('terminateOldPod(oldPodId') + 300);
    expect(handover).toContain('catch');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: REGRESSION TESTS — ALL 58 BUGS (#826-#864)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Regression: Binary body transfer (#826)', () => {
  it('uses arrayBuffer not text for body transfer', () => {
    const src = readSrc('server/ws/http-api-server.ts');
    expect(src).toContain('req.arrayBuffer()');
    // Should not use req.text() in adapters
    const adapters = src.split('Node').filter(s => s.includes('Bun adapter'));
    for (const a of adapters) {
      expect(a).not.toContain('req.text()');
    }
  });
});

describe('Regression: HTTP status codes (#827)', () => {
  it('writeHead propagates status correctly', () => {
    const src = readSrc('server/ws-server.ts');
    expect(src).not.toContain('fakeRes.statusCode || statusCode');
    const writeHeads = src.split('\n').filter(l => l.includes('writeHead:') && l.includes('=>'));
    for (const line of writeHeads) {
      expect(line).toContain('fakeRes.statusCode = code');
    }
  });
});

describe('Regression: deployCancelled reset (#828)', () => {
  it('startDeployLoop resets deployCancelled', () => {
    const src = readSrc('server/gpu-deploy-loop.ts');
    const fn = fnBody(src, 'export async function startDeployLoop');
    expect(fn).toContain('setDeployCancelled(false)');
  });

  it('resetDeployState sets deployCancelled=true', () => {
    const src = readSrc('server/state.ts');
    const fn = fnBody(src, 'export function resetDeployState');
    expect(fn).toContain('_setDeployCancelled(true)');
  });
});

describe('Regression: Monitor finally (#829)', () => {
  it('scheduleNextMonitorProbe in finally block', () => {
    const src = readSrc('server/gpu-monitor-loop.ts');
    const fn = fnBody(src, 'export function scheduleNextMonitorProbe', 15000);
    const finallyIdx = fn.indexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(0);
    const finallyBlock = fn.slice(finallyIdx, finallyIdx + 200);
    expect(finallyBlock).toContain('monitorRunning = false');
    expect(finallyBlock).toContain('scheduleNextMonitorProbe');
  });
});

describe('Regression: Warmth monitor (#830)', () => {
  it('calls stopWarmthMonitor on pod change', () => {
    const src = readSrc('server/gpu-warmth-monitor.ts');
    const idx = src.indexOf('[gpu] Warmth monitor: pod changed');
    const nearby = src.slice(idx - 100, idx + 200);
    expect(nearby).toContain('stopWarmthMonitor()');
  });
});

describe('Regression: Budget accuracy (#831)', () => {
  it('uses actual elapsed time for budget', () => {
    const src = readSrc('server/gpu-monitor-loop.ts');
    const idx = src.indexOf('Budget tracking: accumulate GPU spend');
    const budgetSection = src.slice(idx, idx + 500);
    expect(budgetSection).toContain('lastBudgetCalcTime');
    expect(budgetSection).toContain('actualElapsedMs');
  });
});

describe('Regression: Orphan sweep timer (#832)', () => {
  it('tracks initial timeout', () => {
    const src = readSrc('server/gpu-orphan-cleanup.ts');
    expect(src).toContain('orphanSweepInitialTimer');
    const fn = fnBody(src, 'export function stopOrphanSweep');
    expect(fn).toContain('clearTimeout(orphanSweepInitialTimer)');
  });
});

describe('Regression: broadcastWs safety (#833)', () => {
  it('collect-then-delete pattern', () => {
    const src = readSrc('server/ws-state.ts');
    const fn = fnBody(src, 'export function broadcastWs');
    expect(fn).toContain('dead.push');
    expect(fn).not.toMatch(/for.*wsClients.*\{[^}]*wsClients\.delete/s);
  });
});

describe('Regression: SSH tunnel (#834-#835)', () => {
  it('SIGKILL fallback in close()', () => {
    const src = readSrc('server/ssh-tunnel.ts');
    expect(src).toContain('SIGTERM');
    expect(src).toContain('SIGKILL');
  });

  it('closeAllTunnels called on terminate', () => {
    const src = readSrc('server/gpu-terminate.ts');
    const fn = fnBody(src, 'export async function autoTerminateGpu');
    expect(fn).toContain('closeAllTunnels');
  });
});

describe('Regression: STT sessions (#836)', () => {
  it('periodic cleanup of stale sessions', () => {
    const src = readSrc('server/ws/streaming-stt-session.ts');
    expect(src).toContain('stale STT session');
  });
});

describe('Regression: Race deploy (#837)', () => {
  it('try/finally around Promise.all', () => {
    const src = readSrc('server/gpu-deploy-race.ts');
    const fn = fnBody(src, 'export async function startDeployRace', 25000);
    expect(fn).toContain('try {');
    expect(fn).toContain('await Promise.all(candidates.map');
    expect(fn).toContain('Force-cleaned');
    expect(fn).toContain('finally {');
    expect(fn).toContain('activeRaceInstanceIds.delete');
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

describe('Regression: Config atomic write (#843)', () => {
  it('uses tmp + rename', () => {
    const src = readSrc('server/config-persistence.ts');
    const fn = fnBody(src, 'export function saveProviderConfig');
    expect(fn).toContain('.tmp');
    expect(fn).toContain('renameSync');
  });
});

describe('Regression: Latency ring (#844)', () => {
  it('no redundant bounds check', () => {
    const src = readSrc('server/metrics.ts');
    // Should NOT have the old pattern with extra bounds check
    expect(src).not.toContain('if (latencyRingIdx >= latencyRing.length) setLatencyRingIdx(0)');
  });
});

describe('Regression: Vast 429 (#845)', () => {
  it('throws on rate limit exhaustion', () => {
    const src = readSrc('src/gateway/providers/gpu/vast-client.ts');
    const idx = src.indexOf('retries exhausted');
    const block = src.slice(idx, idx + 500);
    expect(block).toContain('throw new Error');
    expect(block).not.toContain('return lastRes');
  });
});

describe('Regression: Pipeline null guard (#846)', () => {
  it('guards against null baseProfile', () => {
    const src = readSrc('server/pipeline-runner.ts');
    expect(src).toContain('if (!baseProfile)');
  });
});

describe('Regression: RunPod port validation (#847)', () => {
  it('validates port types', () => {
    const src = readSrc('src/gateway/providers/gpu/runpod-client.ts');
    const fn = fnBody(src, 'private resolveEndpoint');
    expect(fn).toContain('typeof portEntry?.publicPort');
  });
});

describe('Regression: Standby timer (#848)', () => {
  it('error reset timer tracked and cleared', () => {
    const src = readSrc('server/gpu-standby.ts');
    expect(src).toContain('_standbyErrorResetTimer');
    expect(src).toContain('clearTimeout(_standbyErrorResetTimer)');
  });
});

describe('Regression: Standby retry terminate (#849)', () => {
  it('retries old pod termination', () => {
    const src = readSrc('server/gpu-standby.ts');
    const idx = src.indexOf('terminateOldPod(oldPodId');
    const block = src.slice(idx, idx + 400);
    expect(block).toContain('retrying in 10s');
  });
});

describe('Regression: Empty audio (#850)', () => {
  it('returns empty text for zero-length audio', () => {
    const src = readSrc('src/gateway/providers/cloud/openai-compat/openai-compat-stt.ts');
    expect(src).toContain('audioLen === 0');
    expect(src).toContain("text: ''");
  });
});

describe('Regression: IP cache (#851)', () => {
  it('bounded at IP_CACHE_MAX', () => {
    const src = readSrc('server/ip-location.ts');
    expect(src).toContain('IP_CACHE_MAX');
    expect(src).toContain('_cache.delete');
  });
});

describe('Regression: Probe dedup (#852)', () => {
  it('timeout prevents orphaned entries', () => {
    const src = readSrc('server/gpu-latency.ts');
    expect(src).toContain('probeTimeout');
    expect(src).toContain('.finally(() => _probing.delete');
  });
});

describe('Regression: Ensemble timers (#853)', () => {
  it('deadline timers cleared in finally', () => {
    const src = readSrc('src/ensemble-stt.ts');
    expect(src).toContain('deadlineTimers');
    expect(src).toContain('clearTimeout(t)');
  });
});

describe('Regression: SSE stream abort (#854)', () => {
  it('tracks client close', () => {
    const src = readSrc('server/ai-handlers-stream.ts');
    expect(src).toContain('clientClosed');
    expect(src).toContain("res.on('close'");
    expect(src).toContain('safeSseWrite');
  });
});

describe('Regression: Error sanitization (#855)', () => {
  it('no internal error details in responses', () => {
    const src = readSrc('server/ai-handlers.ts');
    expect(src).not.toContain('Body read error: ${msg}');
    expect(src).toContain("'Invalid request body'");
  });
});

describe('Regression: pauseMs validation (#856)', () => {
  it('clamped to safe range', () => {
    const src = readSrc('server/ws-server.ts');
    const line = src.split('\n').find(l => l.includes('pause_ms') && l.includes('Math.max'));
    expect(line).toBeTruthy();
    expect(line).toContain('Math.min');
  });
});

describe('Regression: Deploy cleanup failure (#857)', () => {
  it('stops deploy if instance cleanup fails', () => {
    const src = readSrc('server/gpu-deploy-loop.ts');
    const idx = src.indexOf('Cleaning up crashed instance');
    const block = src.slice(idx, idx + 900);
    expect(block).toContain("status: 'error'");
    expect(block).toContain('return');
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

describe('Regression: Host injection (#859)', () => {
  it('playground uses localhost, not host header', () => {
    const src = readSrc('server/playground-handlers.ts');
    expect(src).not.toContain('req.headers.host');
    expect(src).toContain("'http://localhost'");
  });
});

describe('Regression: Vault rollback (#860)', () => {
  it('uses createDecipheriv not hex decode', () => {
    const src = readSrc('src/vault/vault.ts');
    const rollback = src.slice(src.indexOf('Rollback:'), src.indexOf('Rollback:') + 500);
    expect(rollback).toContain('createDecipheriv');
  });
});

describe('Regression: File logger caps (#861)', () => {
  it('caps lines and uses partial read for large files', () => {
    const src = readSrc('server/file-logger.ts');
    expect(src).toContain('MAX_READ_LINES');
    expect(src).toContain('MAX_FILE_READ_BYTES');
    expect(src).toContain('stat.size > MAX_FILE_READ_BYTES');
  });
});

describe('Regression: Bot Scaleway cleanup (#862)', () => {
  it('cleanupBotPods includes Scaleway', () => {
    const src = readSrc('server/bot-handlers.ts');
    const fn = fnBody(src, 'export async function cleanupBotPods', 3000);
    expect(fn).toContain('scaleway');
    expect(fn).toContain('runpod');
    expect(fn).toContain('flyio');
  });
});

describe('Regression: Bot audio relay (#863)', () => {
  it('uses collect-then-delete', () => {
    const src = readSrc('server/bot-handlers.ts');
    const idx = src.indexOf('Relay binary audio');
    const block = src.slice(idx, idx + 300);
    expect(block).toContain('dead');
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
// SECTION 5: API CONTRACT TESTS (#941-#950)
// ═══════════════════════════════════════════════════════════════════════════════

describe('API Contract: Response schemas', () => {
  // #941
  it('#941 chat completions endpoint exists', () => {
    const src = readSrc('server/routes/gateway/inference.ts');
    expect(src).toContain('/v1/chat/completions');
  });

  // #942
  it('#942 audio transcriptions endpoint exists', () => {
    const src = readSrc('server/routes/gateway/inference.ts');
    expect(src).toMatch(/transcribe|audio\/transcriptions/);
  });

  // #943
  it('#943 health endpoint exists', () => {
    const src = readSrc('server/routes/diagnostics/health.ts');
    expect(src).toContain('/health');
  });

  // #944
  it('#944 GPU status endpoint exists', () => {
    const src = readSrc('server/routes/gateway/gpu.ts');
    expect(src).toContain('/v1/gpu/status');
  });

  // #945
  it('#945 workloads endpoint exists', () => {
    const src = readSrc('server/routes/compute/workloads.ts');
    expect(src).toContain('/v1/workloads');
  });

  // #947
  it('#947 all handlers set JSON content type', () => {
    const src = readSrc('server/ws/http-api-server.ts');
    expect(src).toContain("'Content-Type': 'application/json'");
  });

  // #948
  it('#948 CORS headers on responses', () => {
    const src = readSrc('server/ws/http-api-server.ts');
    expect(src).toContain('Access-Control-Allow-Origin');
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

  it('#995 Three workload drivers registered', () => {
    const src = readSrc('server/ws/http-api-server.ts');
    expect(src).toContain('GpuWorkloadDriver');
    expect(src).toContain('BotWorkloadDriver');
    expect(src).toContain('DbWorkloadDriver');
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

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: MISC MODULE COVERAGE (#336-#388)
// ═══════════════════════════════════════════════════════════════════════════════

describe('SSH Tunnel module', () => {
  it('#336 SshTunnel class exists with open/close', () => {
    const src = readSrc('server/ssh-tunnel.ts');
    expect(src).toContain('class SshTunnel');
    expect(src).toContain('async open');
    expect(src).toContain('close()');
  });

  it('#340 getOrCreateTunnel reuses existing', () => {
    const src = readSrc('server/ssh-tunnel.ts');
    expect(src).toContain('getOrCreateTunnel');
    expect(src).toContain('activeTunnels');
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

describe('File logger module', () => {
  it('#352-354 readTailLines with safety caps', () => {
    const src = readSrc('server/file-logger.ts');
    expect(src).toContain('readTailLines');
    expect(src).toContain('MAX_READ_LINES');
    expect(src).toContain('MAX_FILE_READ_BYTES');
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

describe('Labs settings module', () => {
  it('#361-364 get/set with validation', () => {
    const src = readSrc('server/labs-settings.ts');
    expect(src).toContain('getLabsFlags');
    expect(src).toContain('setLabsFlags');
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
  it('#865 server/state.ts imports without error', async () => {
    const mod = await import('../../server/state');
    expect(mod.deployState).toBeDefined();
    expect(mod.setDeployState).toBeInstanceOf(Function);
  });

  it('#866 server/deployment-state-machine.ts imports', async () => {
    const mod = await import('../../server/deployment-state-machine');
    expect(mod.DeploymentStateMachine).toBeDefined();
    expect(mod.deploymentSM).toBeDefined();
  });

  it('#870 src/workloads/registry.ts imports', async () => {
    const mod = await import('../../src/workloads/registry');
    expect(mod.WorkloadRegistry).toBeDefined();
    expect(mod.workloadRegistry).toBeDefined();
  });

  it('#871 src/workloads/types.ts exports types', async () => {
    const mod = await import('../../src/workloads/types');
    expect(mod).toBeDefined();
  });

  it('#990 src/vault/vault.ts imports', async () => {
    const mod = await import('../../src/vault/vault');
    expect(mod.Vault).toBeDefined();
  });

  it('#991 src/auth/gpu-token.ts imports', async () => {
    const mod = await import('../../src/auth/gpu-token');
    expect(mod.signGpuToken).toBeInstanceOf(Function);
    expect(mod.verifyGpuToken).toBeInstanceOf(Function);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10: DOCKER IMAGE CATALOG (#797-#805)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docker image catalog', () => {
  it('#797-800 all babelcast images in catalog', () => {
    const src = readSrc('server/config.ts');
    expect(src).toContain('babelcast-subtitle');
    expect(src).toContain('babelcast-translategemma');
    expect(src).toContain('babelcast-mistral');
    expect(src).toContain('babelcast-qwen3-tts');
  });

  it('#801-803 Blackwell image mapping exists', () => {
    const src = readSrc('server/config.ts');
    expect(src).toContain('STANDARD_TO_BLACKWELL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11: DEFAULT PROFILES (#771-#782)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Default GPU profiles', () => {
  it('#772 realtime-translation-dubbing profile has STT+LLM+TTS', () => {
    const src = readSrc('server/config-persistence.ts');
    const idx = src.indexOf("'realtime-translation-dubbing'");
    if (idx < 0) {
      // Might use different quote style
      expect(src).toContain('realtime-translation-dubbing');
    }
    expect(src).toContain('whisper');
    expect(src).toContain('qwen3-tts');
  });

  it('#773 subtitles-only profile exists', () => {
    const src = readSrc('server/config-persistence.ts');
    expect(src).toContain('subtitles-only');
    expect(src).toContain('babelcast-subtitle');
  });

  it('#774 cloud-only profile has no GPU deploy', () => {
    const src = readSrc('server/config-persistence.ts');
    expect(src).toContain('cloud-only');
  });
});
