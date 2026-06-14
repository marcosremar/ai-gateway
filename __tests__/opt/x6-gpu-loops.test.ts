/**
 * Optimization implementation tests — GPU loops / idle / cost cluster
 * (CROSS-OWNERSHIP harvest wave x6).
 *
 * Scope: SAFE, LOCALIZED pure helpers added to the gpu-loop/idle/cost files
 *   - server/gpu-cost-audit.ts      (#110, #535, #536, #109)
 *   - server/gpu-orphan-cleanup.ts  (#165, #273)
 *   - server/gpu-resume-manager.ts  (#162)
 *   - server/gpu-idle-manager.ts    (#111)
 *   - server/gpu-monitor-loop.ts    (#539, #549, #546)
 *
 * Unit-only: no network, no GPU, no real filesystem writes, no live timers.
 * Pure helpers are exercised directly; call-site wiring is verified by a
 * source-text assertion (same style as the existing wave suites). Modules are
 * loaded via dynamic import() in beforeEach (they define — but never start —
 * timers at module load), matching the established opt-test convention.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SERVER = (f: string) => path.resolve(__dirname, '../../server', f);
const src = (f: string) => readFileSync(SERVER(f), 'utf-8');

// ── #110 / #535 / #536 / #109 — cost-audit pure helpers + provider coverage ──
describe('gpu-cost-audit helpers (#110/#535/#536/#109)', () => {
  let ca: typeof import('../../server/gpu-cost-audit');
  beforeEach(async () => { ca = await import('../../server/gpu-cost-audit'); });

  it('#110 resolveAuditApiKey prefers a live deploy key, else falls back to env', () => {
    expect(ca.resolveAuditApiKey('live-key', 'env-key')).toBe('live-key');
    // empty/whitespace deploy key → env fallback (idle gateway still audits)
    expect(ca.resolveAuditApiKey('', 'env-key')).toBe('env-key');
    expect(ca.resolveAuditApiKey('   ', 'env-key')).toBe('env-key');
    expect(ca.resolveAuditApiKey(undefined, 'env-key')).toBe('env-key');
    // neither set → empty string (caller skips the provider)
    expect(ca.resolveAuditApiKey(undefined, undefined)).toBe('');
  });

  it('#535 isVolumeTracked trusts provider attachment metadata over name match', () => {
    // explicit attachment wins regardless of name
    expect(ca.isVolumeTracked({ name: 'image-named-vol', attachedPodIds: ['pod-1'] })).toBe(true);
    expect(ca.isVolumeTracked({ name: 'whatever', inUse: true })).toBe(true);
    // no attachment info → fall back to name-substring heuristic
    expect(ca.isVolumeTracked({ name: 'vol-pod-9', activePodId: 'pod-9' })).toBe(true);
    expect(ca.isVolumeTracked({ name: 'vol-standby-2', standbyPodId: 'standby-2' })).toBe(true);
    // image-named volume with no attachment + no matching pod → NOT tracked
    expect(ca.isVolumeTracked({ name: 'gemma-4b-cache', activePodId: 'pod-9' })).toBe(false);
  });

  it('#535 isVolumeTracked never marks every volume tracked when no pod active', () => {
    // empty active/standby + empty name must not match (guards ''.includes(''))
    expect(ca.isVolumeTracked({ name: '', activePodId: '', standbyPodId: '' })).toBe(false);
    expect(ca.isVolumeTracked({ name: 'anything', activePodId: '', standbyPodId: '' })).toBe(false);
  });

  it('#536 isStoppedPodStatus recognizes stopped/hibernated states across providers', () => {
    for (const s of ['exited', 'stopped', 'SHUTOFF', 'Hibernated', 'paused', 'suspended']) {
      expect(ca.isStoppedPodStatus(s)).toBe(true);
    }
    for (const s of ['running', 'active', 'booting', '', undefined]) {
      expect(ca.isStoppedPodStatus(s as string | undefined)).toBe(false);
    }
  });

  it('#536 instanceDiskGb reads top-level or providerMeta-nested disk size', () => {
    expect(ca.instanceDiskGb({ diskGb: 50 })).toBe(50);
    expect(ca.instanceDiskGb({ providerMeta: { diskGb: 80 } })).toBe(80);
    // top-level wins when both present
    expect(ca.instanceDiskGb({ diskGb: 50, providerMeta: { diskGb: 80 } })).toBe(50);
    // unknown → undefined so the default estimate applies
    expect(ca.instanceDiskGb({})).toBeUndefined();
    expect(ca.instanceDiskGb({ diskGb: 0 })).toBeUndefined();
  });

  it('#109/#536 auditGpuCosts now lists tensordock + hyperstack stopped pods', () => {
    const s = src('gpu-cost-audit.ts');
    // imports the extra provider clients
    expect(s).toMatch(/import\s*\{[^}]*tensordock[^}]*hyperstack[^}]*\}\s*from\s*'\.\/providers'/);
    // audits TensorDock & Hyperstack stopped instances via the shared helper
    expect(s).toMatch(/tensordock\.listInstances/);
    expect(s).toMatch(/hyperstack\.listInstances/);
    expect(s).toMatch(/provider:\s*'tensordock'/);
    expect(s).toMatch(/provider:\s*'hyperstack'/);
    // uses the new status + disk helpers, and the env-key resolver
    expect(s).toMatch(/isStoppedPodStatus\(/);
    expect(s).toMatch(/instanceDiskGb\(/);
    expect(s).toMatch(/resolveAuditApiKey\(/);
  });
});

// ── #165 / #273 — orphan-cleanup pure helpers + wiring ───────────────────────
describe('gpu-orphan-cleanup helpers (#165/#273)', () => {
  let oc: typeof import('../../server/gpu-orphan-cleanup');
  beforeEach(async () => { oc = await import('../../server/gpu-orphan-cleanup'); });

  it('#165 matchesGatewayPrefix matches every gateway prefix, not just the legacy one', () => {
    expect(oc.matchesGatewayPrefix('parle-autoscale-abc')).toBe(true);
    // the newer prefix that cleanupAllPods previously missed
    expect(oc.matchesGatewayPrefix('ai-gateway-xyz')).toBe(true);
    // third-party / empty names are left alone
    expect(oc.matchesGatewayPrefix('someones-vm')).toBe(false);
    expect(oc.matchesGatewayPrefix('')).toBe(false);
    expect(oc.matchesGatewayPrefix(undefined)).toBe(false);
  });

  it('#165 matchesGatewayPrefix uses the canonical GATEWAY_NAME_PREFIXES by default', () => {
    expect(oc.GATEWAY_NAME_PREFIXES).toContain(oc.POD_NAME_PREFIX);
    expect(oc.GATEWAY_NAME_PREFIXES).toContain('ai-gateway-');
    for (const p of oc.GATEWAY_NAME_PREFIXES) {
      expect(oc.matchesGatewayPrefix(`${p}123`)).toBe(true);
    }
  });

  it('#165 cleanupAllPods filters via matchesGatewayPrefix (call-site wiring)', () => {
    const s = src('gpu-orphan-cleanup.ts');
    expect(s).toMatch(/matchesGatewayPrefix\(inst\.instanceName\)/);
    // the old single-prefix filter must be gone from cleanupAllPods
    expect(s).not.toMatch(/\(inst\.instanceName \|\| ''\)\.startsWith\(POD_NAME_PREFIX\)/);
  });

  it('#273 extractInstanceIds matches only concrete provider id shapes', () => {
    expect(oc.extractInstanceIds('winner inst-35616469 ready')).toEqual(['inst-35616469']);
    expect(oc.extractInstanceIds('modal app ap-AbC123Z deployed')).toEqual(['ap-AbC123Z']);
    // long hex / uuid-like ids (>=24 chars)
    expect(oc.extractInstanceIds('pod 0123456789abcdef0123456789 up'))
      .toEqual(['0123456789abcdef0123456789']);
  });

  it('#273 extractInstanceIds does NOT scrape arbitrary lowercase words (the old bug)', () => {
    // The old regex `\b[a-z0-9]{8,}\b` would have matched these short words.
    expect(oc.extractInstanceIds('deploy completed successfully by marcosremar')).toEqual([]);
    expect(oc.extractInstanceIds('booting installing ready')).toEqual([]);
    expect(oc.extractInstanceIds('')).toEqual([]);
    expect(oc.extractInstanceIds(undefined)).toEqual([]);
  });

  it('#273 extractInstanceIds dedupes repeated ids', () => {
    expect(oc.extractInstanceIds('inst-1 then inst-1 again')).toEqual(['inst-1']);
  });

  it('#273 collectTrackedInstanceIds uses extractInstanceIds (call-site wiring)', () => {
    const s = src('gpu-orphan-cleanup.ts');
    expect(s).toMatch(/extractInstanceIds\(t\.detail\)/);
    // the old inline `detail.match(/<loose regex literal>/)` call site must be
    // gone — the helper matches via a variable (`detail.match(re)`), and the
    // loose regex is only quoted in the new helper's docstring now.
    expect(s).not.toMatch(/detail\.match\(\//);
  });
});

// ── #162 — resume fallback image resolution (fail loud, no silent default) ────
describe('gpu-resume-manager resolveFallbackImage (#162)', () => {
  let rm: typeof import('../../server/gpu-resume-manager');
  beforeEach(async () => { rm = await import('../../server/gpu-resume-manager'); });

  it('returns the original image when present (trimmed)', () => {
    expect(rm.resolveFallbackImage('marcosremar/ultravox-s2s:latest')).toBe('marcosremar/ultravox-s2s:latest');
    expect(rm.resolveFallbackImage('  my/img:tag  ')).toBe('my/img:tag');
  });

  it('throws rather than substituting an unrelated default when image is missing', () => {
    expect(() => rm.resolveFallbackImage('')).toThrow(/missing|wrong app|substitute/i);
    expect(() => rm.resolveFallbackImage('   ')).toThrow();
    expect(() => rm.resolveFallbackImage(undefined)).toThrow();
  });

  it('#162 fresh-deploy fallback uses resolveFallbackImage (call-site wiring)', () => {
    const s = src('gpu-resume-manager.ts');
    expect(s).toMatch(/resolveFallbackImage\(dockerImage\)/);
    // the silent hardcoded-default substitution must be gone as actual code:
    // `const image = dockerImage || '...'` (the old string is only quoted in
    // the new helper's docstring now).
    expect(s).not.toMatch(/const image = dockerImage \|\|/);
  });
});

// ── #111 — Hyperstack idle stops default to hibernate ────────────────────────
describe('gpu-idle-manager shouldDefaultHibernate (#111)', () => {
  let im: typeof import('../../server/gpu-idle-manager');
  beforeEach(async () => { im = await import('../../server/gpu-idle-manager'); });

  it('honors an explicit caller opt-in for any provider', () => {
    expect(im.shouldDefaultHibernate('runpod', true, {})).toBe(true);
    expect(im.shouldDefaultHibernate('vast', true, {})).toBe(true);
  });

  it('defaults Hyperstack to hibernate even without an explicit caller flag', () => {
    expect(im.shouldDefaultHibernate('hyperstack', false, {})).toBe(true);
  });

  it('lets the operator disable Hyperstack hibernate via env=0', () => {
    expect(im.shouldDefaultHibernate('hyperstack', false, { HYPERSTACK_HIBERNATE_ON_IDLE: '0' })).toBe(false);
    // any non-"0" value keeps the default-on behavior
    expect(im.shouldDefaultHibernate('hyperstack', false, { HYPERSTACK_HIBERNATE_ON_IDLE: '1' })).toBe(true);
  });

  it('never defaults non-Hyperstack providers to hibernate (plain stop)', () => {
    expect(im.shouldDefaultHibernate('runpod', false, {})).toBe(false);
    expect(im.shouldDefaultHibernate('vast', false, {})).toBe(false);
    expect(im.shouldDefaultHibernate('tensordock', false, {})).toBe(false);
  });

  it('#111 autoStopGpu threads shouldDefaultHibernate into pauseInstanceForIdle (wiring)', () => {
    const s = src('gpu-idle-manager.ts');
    expect(s).toMatch(/const allowHibernate = shouldDefaultHibernate\(provider, opts\.allowHibernate === true\)/);
    expect(s).toMatch(/allowHibernate,/);
  });
});

// ── #539 / #549 / #546 — monitor-loop budget helpers ─────────────────────────
describe('gpu-monitor-loop budget helpers (#539/#549/#546)', () => {
  let ml: typeof import('../../server/gpu-monitor-loop');
  beforeEach(async () => { ml = await import('../../server/gpu-monitor-loop'); });

  it('#539 budgetDayHoursRemaining honors a configurable reset hour (UTC)', () => {
    const at1230 = new Date('2026-06-14T12:30:00Z');
    // midnight-UTC reset (default) → 11.5h remaining
    expect(ml.budgetDayHoursRemaining(at1230, 0)).toBeCloseTo(11.5, 5);
    // reset at 06:00 UTC and it's already 12:30 → next boundary is tomorrow 06:00 → 17.5h
    expect(ml.budgetDayHoursRemaining(at1230, 6)).toBeCloseTo(17.5, 5);
    // reset at 18:00 UTC, it's 12:30 → 5.5h remaining
    expect(ml.budgetDayHoursRemaining(at1230, 18)).toBeCloseTo(5.5, 5);
  });

  it('#539 budgetDayHoursRemaining returns a full day when exactly on the boundary', () => {
    const atMidnight = new Date('2026-06-14T00:00:00Z');
    expect(ml.budgetDayHoursRemaining(atMidnight, 0)).toBeCloseTo(24, 5);
  });

  it('#539 computeBudgetForecast applies the configurable reset hour', () => {
    const at1230 = new Date('2026-06-14T12:30:00Z');
    // default (UTC midnight): 5 + 2*11.5 = 28 (matches existing #299 behavior)
    expect(ml.computeBudgetForecast(5, 2, at1230)).toBeCloseTo(28, 5);
    // reset at 18:00 UTC: 5 + 2*5.5 = 16
    expect(ml.computeBudgetForecast(5, 2, at1230, 18)).toBeCloseTo(16, 5);
  });

  it('#539 resolveBudgetResetHourUtc parses + clamps env, defaults to 0', () => {
    expect(ml.resolveBudgetResetHourUtc({})).toBe(0);
    expect(ml.resolveBudgetResetHourUtc({ BUDGET_DAY_RESET_HOUR_UTC: '6' })).toBe(6);
    expect(ml.resolveBudgetResetHourUtc({ BUDGET_DAY_RESET_HOUR_UTC: '30' })).toBe(23); // clamp high
    expect(ml.resolveBudgetResetHourUtc({ BUDGET_DAY_RESET_HOUR_UTC: '-5' })).toBe(0);  // clamp low
    expect(ml.resolveBudgetResetHourUtc({ BUDGET_DAY_RESET_HOUR_UTC: 'abc' })).toBe(0); // garbage
  });

  it('#549 budgetHardLimitRatio defaults to 0.95 (headroom) and clamps to (0,1]', () => {
    expect(ml.budgetHardLimitRatio({})).toBe(0.95);
    expect(ml.budgetHardLimitRatio({ BUDGET_HARD_LIMIT_RATIO: '0.9' })).toBe(0.9);
    expect(ml.budgetHardLimitRatio({ BUDGET_HARD_LIMIT_RATIO: '1' })).toBe(1);
    // out-of-range / garbage falls back to 1.0 (old behavior, never disables)
    expect(ml.budgetHardLimitRatio({ BUDGET_HARD_LIMIT_RATIO: '1.5' })).toBe(1.0);
    expect(ml.budgetHardLimitRatio({ BUDGET_HARD_LIMIT_RATIO: '0' })).toBe(1.0);
    expect(ml.budgetHardLimitRatio({ BUDGET_HARD_LIMIT_RATIO: 'x' })).toBe(1.0);
  });

  it('#549 hard-limit terminate uses budgetHardLimitRatio (call-site wiring)', () => {
    const s = src('gpu-monitor-loop.ts');
    expect(s).toMatch(/if \(pct >= budgetHardLimitRatio\(\)\)/);
    // the bare `pct >= 1.0` hard-kill condition must be gone
    expect(s).not.toMatch(/if \(pct >= 1\.0\) \{\s*\n\s*\/\/ HARD BUDGET/);
  });

  it('#546 shouldFireBudgetThreshold fires once per threshold per day, re-arms on a new day', () => {
    const fired = new Set<string>();
    // below threshold → no fire
    expect(ml.shouldFireBudgetThreshold(0.4, 0.5, '2026-06-14', fired)).toBe(false);
    // crosses 0.5 → fire (then caller records)
    expect(ml.shouldFireBudgetThreshold(0.6, 0.5, '2026-06-14', fired)).toBe(true);
    fired.add('2026-06-14:0.5');
    // same day, still above → does NOT re-fire
    expect(ml.shouldFireBudgetThreshold(0.7, 0.5, '2026-06-14', fired)).toBe(false);
    // new day → re-arms
    expect(ml.shouldFireBudgetThreshold(0.7, 0.5, '2026-06-15', fired)).toBe(true);
    // distinct thresholds tracked independently
    expect(ml.shouldFireBudgetThreshold(0.85, 0.8, '2026-06-14', fired)).toBe(true);
  });

  it('#539 monitor-loop forecast call threads the resolved reset hour (wiring)', () => {
    const s = src('gpu-monitor-loop.ts');
    expect(s).toMatch(/computeBudgetForecast\(\s*dailyGpuSpendUsd, deployState\.costPerHr, new Date\(\), resolveBudgetResetHourUtc\(\)/);
  });
});
