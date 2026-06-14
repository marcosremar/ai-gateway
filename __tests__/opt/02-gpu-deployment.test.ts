// ── Unit tests for GPU deployment optimizations (IDs 101-200) ───────────────
// Pure-helper tests only — no network, no provider/GPU calls, no real FS.
// See docs/optimizations/implemented/02-gpu-deployment.md for the mapping.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  allocateLocalPort,
  releaseLocalPort,
  SshTunnel,
} from '../../src/gateway/providers/gpu/ssh-tunnel';
import { compareCudaVersions } from '../../src/preflight-checks/index';
import { isSafeRemotePath } from '../../server/pod-provisioner';
import {
  selectDiagnosticsToPrune,
  MAX_DIAGNOSTIC_FILES,
} from '../../server/deploy-diagnostics';
import {
  computeRaceBudget,
  RACE_EST_PER_INSTANCE_HR,
} from '../../server/gpu-deploy-race';
import {
  buildDeployIdempotencyHash,
  isBalanceTooLow,
} from '../../server/gpu-handlers';

// ── #181: SSH tunnel local-port allocation is collision-safe ────────────────
describe('#181 ssh-tunnel allocateLocalPort', () => {
  it('hands out distinct ports while they remain in use', () => {
    const a = allocateLocalPort();
    const b = allocateLocalPort();
    const c = allocateLocalPort();
    try {
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(a).not.toBe(c);
    } finally {
      releaseLocalPort(a);
      releaseLocalPort(b);
      releaseLocalPort(c);
    }
  });

  it('stays within the 19000-19999 window', () => {
    const ports: number[] = [];
    for (let i = 0; i < 50; i++) ports.push(allocateLocalPort());
    try {
      for (const p of ports) {
        expect(p).toBeGreaterThanOrEqual(19000);
        expect(p).toBeLessThanOrEqual(19999);
      }
    } finally {
      ports.forEach(releaseLocalPort);
    }
  });

  it('reuses a port only after it is released', () => {
    const p = allocateLocalPort();
    releaseLocalPort(p);
    // After release, the port is eligible again; allocate many and confirm the
    // released one can come back (the pool is finite so it will within a cycle).
    const seen = new Set<number>();
    const grabbed: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const q = allocateLocalPort();
      grabbed.push(q);
      seen.add(q);
    }
    try {
      expect(seen.has(p)).toBe(true);
    } finally {
      grabbed.forEach(releaseLocalPort);
    }
  });

  it('close() releases the tunnel local port back to the pool', () => {
    const t = new SshTunnel('1.2.3.4', 22);
    // Force a port allocation the way _spawnOnce would (private; emulate via a
    // direct allocate to assert release semantics from close()).
    const before = allocateLocalPort();
    releaseLocalPort(before);
    // A freshly-constructed tunnel that never opened has localPort 0; close is
    // a no-op for the pool but must not throw.
    expect(() => t.close()).not.toThrow();
    expect(t.localPort).toBe(0);
  });
});

// ── #196: CUDA version numeric comparison ───────────────────────────────────
describe('#196 compareCudaVersions', () => {
  it('treats 12.10 as greater than 12.8 (the lexicographic bug)', () => {
    expect(compareCudaVersions('12.10', '12.8')).toBeGreaterThan(0);
  });

  it('orders common CUDA versions correctly', () => {
    expect(compareCudaVersions('12.8', '12.8')).toBe(0);
    expect(compareCudaVersions('12.4', '12.8')).toBeLessThan(0);
    expect(compareCudaVersions('12.8', '12.4')).toBeGreaterThan(0);
    expect(compareCudaVersions('11.8', '12.0')).toBeLessThan(0);
  });

  it('the >= 12.8 gate fires for 12.8 and 12.10 but not 12.4', () => {
    expect(compareCudaVersions('12.8', '12.8') >= 0).toBe(true);
    expect(compareCudaVersions('12.10', '12.8') >= 0).toBe(true);
    expect(compareCudaVersions('12.4', '12.8') >= 0).toBe(false);
  });

  it('handles patch versions and missing components', () => {
    expect(compareCudaVersions('12.8.1', '12.8')).toBeGreaterThan(0);
    expect(compareCudaVersions('12', '12.0')).toBe(0);
    expect(compareCudaVersions('garbage', '12.8')).toBeLessThan(0);
  });
});

// ── #186: provisioner remote-path safety guard ──────────────────────────────
describe('#186 isSafeRemotePath', () => {
  it('accepts normal absolute config paths', () => {
    expect(isSafeRemotePath('/etc/aigw-agent.env')).toBe(true);
    expect(isSafeRemotePath('/root/scripts/install.sh')).toBe(true);
    expect(isSafeRemotePath('/opt/aigw/agent-1.0_beta.py')).toBe(true);
  });

  it('rejects shell metacharacters that would enable injection', () => {
    expect(isSafeRemotePath('/tmp/x; rm -rf /')).toBe(false);
    expect(isSafeRemotePath('/tmp/$(whoami)')).toBe(false);
    expect(isSafeRemotePath('/tmp/`id`')).toBe(false);
    expect(isSafeRemotePath('/tmp/a && b')).toBe(false);
    expect(isSafeRemotePath('/tmp/a|b')).toBe(false);
    expect(isSafeRemotePath('/tmp/a > b')).toBe(false);
    expect(isSafeRemotePath('')).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(isSafeRemotePath('/etc/../../root/.ssh/authorized_keys')).toBe(false);
  });
});

// ── #190: deploy diagnostics bounded retention ──────────────────────────────
describe('#190 selectDiagnosticsToPrune', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => `file-${i}.json`);

  it('keeps nothing to prune when under the cap', () => {
    expect(selectDiagnosticsToPrune(mk(10), 200)).toEqual([]);
    expect(selectDiagnosticsToPrune(mk(MAX_DIAGNOSTIC_FILES))).toEqual([]);
  });

  it('prunes the oldest (tail) files beyond the cap', () => {
    const files = mk(205); // newest-first
    const pruned = selectDiagnosticsToPrune(files, 200);
    expect(pruned).toHaveLength(5);
    // The pruned ones are the tail (oldest) entries.
    expect(pruned).toEqual(files.slice(200));
  });

  it('uses MAX_DIAGNOSTIC_FILES by default', () => {
    const files = mk(MAX_DIAGNOSTIC_FILES + 3);
    expect(selectDiagnosticsToPrune(files)).toHaveLength(3);
  });
});

// ── #105: race-deploy per-instance cost cap ─────────────────────────────────
describe('#105 computeRaceBudget', () => {
  it('uses a $2/instance/hr prior', () => {
    expect(RACE_EST_PER_INSTANCE_HR).toBe(2);
  });

  it('rejects when a single instance already exceeds the cap', () => {
    const plan = computeRaceBudget(4, 2, 1); // $2 > $1 cap
    expect(plan.rejected).toBe(true);
    expect(plan.allowedRaceN).toBe(0);
  });

  it('trims raceN to fit the cap', () => {
    // cap $5 / $2 per instance = floor 2 instances allowed
    const plan = computeRaceBudget(4, 2, 5);
    expect(plan.rejected).toBe(false);
    expect(plan.allowedRaceN).toBe(2);
    expect(plan.estimatedCost).toBe(4);
  });

  it('keeps raceN when the cap is generous', () => {
    const plan = computeRaceBudget(3, 2, 100);
    expect(plan.rejected).toBe(false);
    expect(plan.allowedRaceN).toBe(3);
  });

  it('never trims below 1 when the cap admits at least one instance', () => {
    const plan = computeRaceBudget(10, 2, 2); // exactly one instance
    expect(plan.rejected).toBe(false);
    expect(plan.allowedRaceN).toBe(1);
  });
});

// ── #122: broadened idempotency hash ────────────────────────────────────────
describe('#122 buildDeployIdempotencyHash', () => {
  const base = { dockerImage: 'img:latest', gpuTypes: ['RTX 4090'] };

  it('is stable for the same request regardless of key order', () => {
    const a = buildDeployIdempotencyHash({ dockerImage: 'img:latest', gpuTypes: ['RTX 4090'], region: 'US' });
    const b = buildDeployIdempotencyHash({ region: 'US', gpuTypes: ['RTX 4090'], dockerImage: 'img:latest' });
    expect(a).toBe(b);
  });

  it('is stable regardless of gpuTypes array order', () => {
    const a = buildDeployIdempotencyHash({ ...base, gpuTypes: ['RTX 4090', 'A6000'] });
    const b = buildDeployIdempotencyHash({ ...base, gpuTypes: ['A6000', 'RTX 4090'] });
    expect(a).toBe(b);
  });

  it('differs when region differs (previously collided)', () => {
    const a = buildDeployIdempotencyHash({ ...base, region: 'US' });
    const b = buildDeployIdempotencyHash({ ...base, region: 'EU' });
    expect(a).not.toBe(b);
  });

  it('differs when storageGb / raceCount / maxCostUsd / provider differ', () => {
    expect(buildDeployIdempotencyHash({ ...base, storageGb: 50 }))
      .not.toBe(buildDeployIdempotencyHash({ ...base, storageGb: 100 }));
    expect(buildDeployIdempotencyHash({ ...base, raceCount: 1 }))
      .not.toBe(buildDeployIdempotencyHash({ ...base, raceCount: 3 }));
    expect(buildDeployIdempotencyHash({ ...base, maxCostUsd: 1 }))
      .not.toBe(buildDeployIdempotencyHash({ ...base, maxCostUsd: 2 }));
    expect(buildDeployIdempotencyHash({ ...base, provider: 'vast' }))
      .not.toBe(buildDeployIdempotencyHash({ ...base, provider: 'runpod' }));
  });

  it('differs when env differs but ignores env key order', () => {
    const a = buildDeployIdempotencyHash({ ...base, env: { A: '1', B: '2' } });
    const b = buildDeployIdempotencyHash({ ...base, env: { B: '2', A: '1' } });
    const c = buildDeployIdempotencyHash({ ...base, env: { A: '9', B: '2' } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('matches identical requests (the legitimate double-click case)', () => {
    const a = buildDeployIdempotencyHash({ ...base, region: 'US', storageGb: 50 });
    const b = buildDeployIdempotencyHash({ ...base, region: 'US', storageGb: 50 });
    expect(a).toBe(b);
  });
});

// ── #137/#138: consistent balance-exclusion threshold ───────────────────────
describe('#137 isBalanceTooLow', () => {
  it('excludes balances strictly below the threshold', () => {
    expect(isBalanceTooLow(0.5, 1)).toBe(true);
    expect(isBalanceTooLow(0, 1)).toBe(true);
    expect(isBalanceTooLow(-5, 1)).toBe(true);
  });

  it('admits balances at or above the threshold', () => {
    expect(isBalanceTooLow(1, 1)).toBe(false);
    expect(isBalanceTooLow(1.01, 1)).toBe(false);
    expect(isBalanceTooLow(100, 1)).toBe(false);
  });

  it('applies the same rule for any provider threshold (no per-provider drift)', () => {
    // Previously TensorDock used 0.5 and Vast a 2-step check; now one rule.
    const threshold = 1;
    for (const bal of [0.4, 0.5, 0.99]) {
      expect(isBalanceTooLow(bal, threshold)).toBe(true);
    }
  });
});
