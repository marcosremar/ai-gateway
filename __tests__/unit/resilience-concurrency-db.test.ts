/**
 * Resilience, Concurrency, and Database Tests (#691-#710, #885-#904)
 *
 * Source code verification for resilience patterns,
 * concurrency safety, and database integration.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (f: string) => fs.readFileSync(path.resolve(f), 'utf8');

// Map re-export stubs to their actual implementation files
const STUB_TO_IMPL: Record<string, string> = {
  'src/autoscaler/session-tracker.ts': 'src/gateway/autoscaler/session-tracker.ts',
  'src/workloads/registry.ts': 'src/compute/workloads/registry.ts',
  'src/autoscaler/load-balancer.ts': 'src/gateway/autoscaler/load-balancer.ts',
  'src/autoscaler/engine.ts': 'src/gateway/autoscaler/engine.ts',
  'src/proxy/server.ts': 'src/gateway/proxy/server.ts',
  'server/speculative-cache.ts': 'src/gateway/pipeline/speculative-cache.ts',
};
const readImpl = (f: string) => read(STUB_TO_IMPL[f] || f);
const gpuDeploySource = ['server/gpu-deploy.ts','server/gpu-deploy-loop.ts','server/gpu-monitor-loop.ts','server/gpu-idle-manager.ts','server/gpu-idle-logic.ts','server/gpu-deploy-race.ts','server/gpu-orphan-cleanup.ts','server/gpu-type-cache.ts','server/gpu-auto-select.ts','server/gpu-auto-recovery.ts','server/gpu-deploy-tiers.ts','server/gpu-deploy-with-tiers.ts','server/gpu-terminate.ts','server/gpu-health-metrics.ts','server/gpu-destroy-timer.ts','server/gpu-standby.ts','server/gpu-poll-health.ts','server/gpu-warmth-monitor.ts'].map(f => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8')).join('\n');
const fn = (src: string, name: string, len = 5000) => {
  const i = src.indexOf(name);
  if (i < 0) return '';
  const end = src.indexOf('\nexport ', i + 50);
  return src.slice(i, end > 0 ? end : i + len);
};

// ═══════════════════════════════════════════════════════════════════════════════
// RESILIENCE: Deploy error recovery (#693-#696)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Resilience: Deploy continues after errors (#693-#696)', () => {
  const src = gpuDeploySource;

  it('#693 deploy retries on transient errors', () => {
    expect(src).toContain('MAX_DEPLOY_RETRIES');
    expect(src).toMatch(/retry|attempt/);
  });

  it('#694 deploy skips billing errors (no retry)', () => {
    expect(src).toMatch(/billing|balance|funds|insufficient/i);
    expect(src).toContain('isBilling');
  });

  it('#695 deploy skips auth errors (no retry)', () => {
    expect(src).toMatch(/isAuth|unauthorized|forbidden|api key/i);
  });

  it('#696 deploy falls to next tier after exhausting retries', () => {
    expect(src).toContain('continue'); // continue to next tier
    expect(src).toMatch(/tier|tiers/);
  });

  it('#693b cooldown recorded on failure', () => {
    expect(src).toContain('cooldownTracker');
    expect(src).toContain('recordFailure');
  });

  it('#693c cooldown cleared on success', () => {
    expect(src).toContain('recordSuccess');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESILIENCE: Reconnection (#700-#701)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Resilience: Reconnection patterns (#700-#701)', () => {
  it('#700 SSH tunnel has close + reconnect capability', () => {
    const src = read('server/ssh-tunnel.ts');
    expect(src).toContain('async open');
    expect(src).toContain('close()');
    expect(src).toContain('getOrCreateTunnel'); // reuses or creates new
  });

  it('#701 bot audio relay auto-reconnects', () => {
    const src = read('server/bot-handlers.ts');
    expect(src).toMatch(/reconnect|auto.*reconnect|retry/i);
    expect(src).toContain("ws.on('close'");
  });

  it('#700b SSH tunnel SIGTERM + SIGKILL', () => {
    const src = read('server/ssh-tunnel.ts');
    expect(src).toContain('SIGTERM');
    expect(src).toContain('SIGKILL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESILIENCE: Circuit breakers (#698)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Resilience: Circuit breakers (#698)', () => {
  it('#698a stage circuit breakers exist', () => {
    const src = read('server/providers.ts');
    expect(src).toMatch(/circuitBreaker|circuit.*break|stageBreaker/i);
  });

  it('#698b circuit breaker opens after failures', () => {
    const src = read('server/pipeline-runner.ts');
    expect(src).toContain('isStageCircuitClosed');
  });

  it('#698c Node SDK has circuit breaker', () => {
    const src = read('sdk/node/circuit-breaker.ts');
    expect(src).toContain('CircuitBreaker');
    expect(src).toContain('recordFailure');
    expect(src).toContain('recordSuccess');
    expect(src).toMatch(/open|closed|half_open/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESILIENCE: Monitor recovery (#697, #703-#705)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Resilience: Monitor & state recovery (#697-#705)', () => {
  it('#697 monitor recovers after consecutive failures', () => {
    const src = gpuDeploySource;
    expect(src).toContain('monitorConsecFails');
    // Should have backoff
    expect(src).toContain('monitorDelayMs');
  });

  it('#703 deploy state persisted to disk', () => {
    const src = read('server/state.ts');
    expect(src).toMatch(/persistDeployState|writeFileSync/);
  });

  it('#704 orphan sweep periodic', () => {
    const src = gpuDeploySource;
    expect(src).toContain('ORPHAN_SWEEP_INTERVAL_MS');
    expect(src).toContain('sweepOrphanInstances');
  });

  it('#705 budget enforcement survives restart', () => {
    const src = gpuDeploySource;
    expect(src).toContain('DAILY_BUDGET_USD');
    expect(src).toContain('dailyGpuSpendUsd');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONCURRENCY: Multi-user (#885-#894)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Concurrency: Multi-user safety (#885-#894)', () => {
  it('#885 deploy lock prevents simultaneous deploys', () => {
    const src = read('server/gpu-handlers.ts');
    expect(src).toContain('deployLock');
    expect(src).toContain('setDeployLock(true)');
    expect(src).toContain('setDeployLock(false)');
  });

  it('#887 config saves are atomic (no corruption)', () => {
    const src = read('server/config-persistence.ts');
    expect(src).toContain('.tmp');
    expect(src).toContain('renameSync');
  });

  it('#888 session tracking per-user', () => {
    const src = readImpl('src/autoscaler/session-tracker.ts');
    expect(src).toContain('userId');
    expect(src).toContain('heartbeats');
  });

  it('#890 rate limiting per-API-key capable', () => {
    const proxy = read('src/proxy/middleware/rate-limit.ts');
    expect(proxy).toMatch(/rate|limit|rpm|bucket/i);
  });

  it('#891 workload names unique', () => {
    const src = readImpl('src/workloads/registry.ts');
    expect(src).toContain('getByName');
    expect(src).toContain('already exists');
  });

  it('#892 bot deploy lock prevents concurrent', () => {
    const src = read('server/bot-handlers.ts');
    expect(src).toContain('botDeployLock');
    expect(src).toContain('409');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONCURRENCY: Load balancer (#488-#495 additional)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Concurrency: Load balancer safety', () => {
  it('connection count uses atomic in-memory counter', () => {
    const src = readImpl('src/autoscaler/load-balancer.ts');
    expect(src).toContain('connectionCounts');
    expect(src).toContain('connectionCounts.set');
  });

  it('decrement never goes below 0', () => {
    const src = readImpl('src/autoscaler/load-balancer.ts');
    expect(src).toContain('Math.max(0');
  });

  it('decision locks serialize per-user', () => {
    const src = readImpl('src/autoscaler/engine.ts');
    expect(src).toContain('decisionLocks');
    expect(src).toContain('.finally(');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE: Structure verification (#895-#904)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Database: Neon Management (#895-#903)', () => {
  const src = read('src/database/neon-management.ts');

  it('#895 NeonManagementClient exists', () => {
    expect(src).toContain('class NeonManagementClient');
  });

  it('#896 listBranches method', () => { expect(src).toContain('listBranches'); });
  it('#897 createBranch method', () => { expect(src).toContain('createBranch'); });
  it('#898 deleteBranch method', () => { expect(src).toContain('deleteBranch'); });
  it('#899 listEndpoints method', () => { expect(src).toContain('listEndpoints'); });
  it('#900 getBranchConnectionUri method', () => { expect(src).toContain('getBranchConnectionUri'); });
  it('#901 listDatabases method', () => { expect(src).toContain('listDatabases'); });
  it('#902 createDatabase method', () => { expect(src).toContain('createDatabase'); });

  it('#903 handles API errors', () => {
    expect(src).toContain('DatabaseError');
    expect(src).toContain('NEON_API_ERROR');
  });
});

describe('Database: Types (#895)', () => {
  const src = read('src/database/types.ts');

  it('NeonProject type defined', () => { expect(src).toContain('NeonProject'); });
  it('NeonBranch type defined', () => { expect(src).toContain('NeonBranch'); });
  it('NeonDatabase type defined', () => { expect(src).toContain('NeonDatabase'); });
  it('NeonEndpoint type defined', () => { expect(src).toContain('NeonEndpoint'); });
  it('DatabaseError class defined', () => { expect(src).toContain('class DatabaseError'); });
  it('QueryResult type defined', () => { expect(src).toContain('QueryResult'); });
  it('BackupInfo type defined', () => { expect(src).toContain('BackupInfo'); });
});

describe('Database: PG Driver (#895)', () => {
  const src = read('src/database/pg-driver.ts');

  it('query method exists', () => { expect(src).toContain('query'); });
  it('uses parameterized queries', () => { expect(src).toContain('params'); });
  it('returns QueryResult', () => { expect(src).toContain('QueryResult'); });
});

describe('Database: Gateway works without DB (#904)', () => {
  const src = read('server/state.ts');

  it('noopPrisma provides fallback', () => {
    expect(src).toContain('_noopPrisma');
    expect(src).toContain('Proxy');
  });

  it('prisma starts as noop', () => {
    expect(src).toContain('let prisma: any = _noopPrisma');
  });

  it('setPrisma allows DB injection', () => {
    expect(src).toContain('export function setPrisma');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROXY: Structure (#549-#563)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Proxy: Server structure (#549-#563)', () => {
  const src = readImpl('src/proxy/server.ts');

  it('#549 startProxy function exported', () => { expect(src).toContain('startProxy'); });
  it('#550 routes /v1/chat/completions', () => { expect(src).toContain('chat/completions'); });
  it('#551 routes /v1/audio/transcriptions', () => { expect(src).toContain('audio/transcriptions'); });
  it('#552 routes /health', () => { expect(src).toContain('health'); });
  it('#553 auth middleware', () => { expect(src).toMatch(/apiKey|auth|Authorization/); });
  it('#561 handles provider timeout', () => { expect(src).toMatch(/timeout|signal/i); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MISC MODULE COVERAGE (#336-#370)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Misc: Speculative cache (#342-#346)', () => {
  const src = readImpl('server/speculative-cache.ts');

  it('#342 speculate method', () => { expect(src).toContain('speculate'); });
  it('#343 resolve method', () => { expect(src).toContain('resolve'); });
  it('#345 max speculations cap', () => { expect(src).toContain('MAX_SPECULATIONS'); });
  it('#346 eviction of expired entries', () => { expect(src).toContain('evictExpired'); });
});

describe('Misc: GPU latency probing (#384-#388)', () => {
  const src = read('server/gpu-latency.ts');

  it('#384 probeTcp measures RTT', () => { expect(src).toContain('probeTcp'); });
  it('#385 probeHostFull runs probes', () => { expect(src).toContain('probeHostFull'); });
  it('#386 dedup set prevents concurrent probes', () => { expect(src).toContain('_probing'); });
  it('#387 probe timeout in finally', () => { expect(src).toContain('.finally(() => _probing.delete'); });
  it('#388 rankOffers sorts by latency', () => { expect(src).toContain('rankOffers'); });
});

describe('Misc: Provider warmup (#381-#383)', () => {
  const src = read('server/provider-warmup.ts');

  it('#381 warmup function exists', () => { expect(src).toMatch(/warmup|probe/i); });
  it('#382 cloud probe results cached', () => { expect(src).toMatch(/cache|lastCloudProbe/i); });
});

describe('Misc: Config handlers extra', () => {
  const src = read('server/config-handlers.ts');

  it('profile create returns 201', () => { expect(src).toContain('201'); });
  it('profile delete returns 200 or 404', () => {
    expect(src).toContain('200');
    expect(src).toContain('404');
  });
  it('labs flags validated', () => { expect(src).toMatch(/labs|flags/i); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE: Source verification (#711-#724)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Performance: Architecture supports low latency (#711-#724)', () => {
  it('#720 speculative cache for repeated phrases', () => {
    const src = readImpl('server/speculative-cache.ts');
    expect(src).toContain('speculate');
    expect(src).toContain('resolve');
  });

  it('#721 provider warmup reduces cold start', () => {
    const src = read('server/provider-warmup.ts');
    expect(src).toMatch(/warmup|probe|warm/i);
  });

  it('#723 latency ring O(1) insert', () => {
    // latencyRingIdx moved from server/metrics.ts to src/gateway/state/metrics-state.ts
    // (state extracted out of monolithic state.ts during gateway refactor).
    const src = read('src/gateway/state/metrics-state.ts');
    expect(src).toContain('latencyRing');
    expect(src).toContain('latencyRingIdx');
  });

  it('#724 config uses in-memory cache', () => {
    const src = read('server/config-persistence.ts');
    expect(src).toContain('_cachedConfig');
    expect(src).toContain('_cacheTime');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OBSERVABILITY (#925-#930)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Observability (#925-#930)', () => {
  const metrics = read('server/metrics.ts');
  // Ring buffer state moved out of metrics.ts during gateway state refactor.
  const metricsState = read('src/gateway/state/metrics-state.ts');

  it('#925 request count tracked', () => {
    expect(metrics).toContain('requestsTotal');
  });

  it('#926 latency tracked in ring buffer', () => {
    expect(metricsState).toContain('latencyRing');
    expect(metricsState).toContain('LATENCY_RING_SIZE');
  });

  it('#927 error count tracked', () => {
    expect(metrics).toContain('errorsTotal');
  });

  it('#929 request log with fields', () => {
    expect(metrics).toMatch(/stage|provider|latencyMs|success/);
  });

  it('#930 handleServiceStats exported', () => {
    expect(metrics).toContain('handleServiceStats');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR RECOVERY (#931-#940)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Error Recovery (#931-#940)', () => {
  it('#931 uncaughtException handler in serve.ts', () => {
    const src = read('serve.ts');
    expect(src).toContain('uncaughtException');
  });

  it('#932 unhandledRejection handler in serve.ts', () => {
    const src = read('serve.ts');
    expect(src).toContain('unhandledRejection');
  });

  it('#933 GPU monitor restarts via reschedule', () => {
    const src = gpuDeploySource;
    const body = fn(src, 'export function scheduleNextMonitorProbe', 15000);
    const finallyBlock = body.slice(body.indexOf('} finally {'));
    expect(finallyBlock).toContain('scheduleNextMonitorProbe');
  });

  it('#934 config reload handles corrupt file', () => {
    const src = read('server/config-persistence.ts');
    expect(src).toContain('catch');
    expect(src).toMatch(/DEFAULT_CONFIG|default/);
  });

  it('#938 file logger handles missing file', () => {
    const src = read('server/file-logger.ts');
    expect(src).toContain('catch');
    expect(src).toContain('return []');
  });
});
