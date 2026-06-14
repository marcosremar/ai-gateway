/**
 * Wave 4 — Web UI, Build & Infra/Cost (IDs 901-1000).
 *
 * Continuation of `10-web-infra.test.ts` (wave 1), `-w2` (wave 2) and `-w3`
 * (wave 3). This wave:
 *   - #925: collapses GpuLiveStatus's 40-entry deploy-phase `PHASE_META` into a
 *     single shared `DEPLOY_PHASE_META` registry (color + label) in
 *     `lib/phase-colors`; the component keeps only its lucide icon map.
 *   - #948: extracts the Readiness section's adaptive poll-cadence decision into
 *     a pure `readinessPollInterval` so the React interval can read it from a
 *     ref instead of tearing down/rebuilding on every phase flip.
 *   - #935: adds explicit divider-vs-link nav predicates so divider entries no
 *     longer need a meaningless icon, and a `validRoutesFromNav` helper.
 *   - #1000: adds pure accessors over the Grafana dashboard's alert rules
 *     (error-rate / p95 / GPU-down / budget / memory / failover → Slack channels).
 *
 * The opt vitest config has NO jsdom / `document` global, so only pure TS logic
 * is exercised here (inputs injected). React `.tsx`/hooks, Next config, Helm/HCL
 * and Dockerfiles are inspection-only and documented in
 * `docs/optimizations/implemented/10-web-infra-w4.md`.
 *
 * Covers: #925 #948 #935 #1000
 *
 * Run only this file:
 *   bunx vitest run --config vitest.opt.config.ts __tests__/opt/10-web-infra-w4.test.ts
 */
import { describe, it, expect } from 'vitest';

// ── #925: shared deploy-phase registry ────────────────────────────────────────
import {
  DEPLOY_PHASE_META,
  deployPhaseColor,
  deployPhaseLabel,
  deployPhaseMeta,
} from '../../web/src/lib/phase-colors';

// ── #948: readiness adaptive poll cadence ─────────────────────────────────────
import {
  readinessPollInterval,
  hasActiveReadinessPhase,
  ACTIVE_READINESS_PHASES,
  READINESS_FAST_INTERVAL_MS,
  READINESS_IDLE_INTERVAL_MS,
} from '../../web/src/sections/readiness-logic';

// ── #935: nav divider-vs-link predicates ──────────────────────────────────────
import {
  isNavSection,
  isNavLink,
  validRoutesFromNav,
} from '../../web/src/lib/nav';

// ── #1000: Grafana alert-rule accessors ───────────────────────────────────────
import {
  getAlertRules,
  alertsBySeverity,
  alertNames,
  alertChannels,
  hasAlertForChannel,
} from '../../monitoring/grafana-dashboard';

// ─────────────────────────────────────────────────────────────────────────────
// #925 — single source of truth for deploy-phase color/label
// ─────────────────────────────────────────────────────────────────────────────
describe('#925 deploy-phase registry (DEPLOY_PHASE_META)', () => {
  it('maps known deploy phases to their canonical color + label', () => {
    expect(deployPhaseMeta('ready')).toEqual({ color: '#10b981', label: 'Ready' });
    expect(deployPhaseMeta('pulling_image')).toEqual({ color: '#38bdf8', label: 'Pulling Image' });
    expect(deployPhaseMeta('benchmarking')).toEqual({ color: '#38bdf8', label: 'Benchmarking' });
    expect(deployPhaseMeta('shadow')).toEqual({ color: '#a78bfa', label: 'Shadow Mode' });
  });

  it('color/label accessors agree with the registry', () => {
    for (const phase of Object.keys(DEPLOY_PHASE_META)) {
      expect(deployPhaseColor(phase)).toBe(DEPLOY_PHASE_META[phase].color);
      expect(deployPhaseLabel(phase)).toBe(DEPLOY_PHASE_META[phase].label);
    }
  });

  it('falls back to gray + echoes the raw phase for unknown phases', () => {
    expect(deployPhaseColor('totally_unknown')).toBe('#6b7280');
    expect(deployPhaseLabel('totally_unknown')).toBe('totally_unknown');
    expect(deployPhaseMeta('totally_unknown')).toEqual({
      color: '#6b7280',
      label: 'totally_unknown',
    });
  });

  it('covers the full deploy lifecycle (search → create → pull → ready) + failure phases', () => {
    for (const phase of [
      'searching_offers', 'queued', 'creating_pod', 'pulling_image',
      'starting_container', 'downloading_models', 'ready',
      'failed', 'condemned', 'degraded', 'error',
    ]) {
      expect(DEPLOY_PHASE_META[phase]).toBeDefined();
      // Every color is a hex value.
      expect(deployPhaseColor(phase)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #948 — readiness adaptive poll cadence (pure)
// ─────────────────────────────────────────────────────────────────────────────
describe('#948 readinessPollInterval', () => {
  const ready = {
    readinessState: {
      stt: { phase: 'ready' }, llm: { phase: 'ready' }, tts: { phase: 'ready' },
      shadowPhase: null,
    },
  };

  it('uses the idle cadence when nothing is transitioning', () => {
    expect(readinessPollInterval(ready)).toBe(READINESS_IDLE_INTERVAL_MS);
    expect(hasActiveReadinessPhase(ready)).toBe(false);
  });

  it('uses the fast cadence when any stage is in an active phase', () => {
    for (const phase of ACTIVE_READINESS_PHASES) {
      const state = {
        readinessState: {
          stt: { phase: 'ready' }, llm: { phase }, tts: { phase: 'ready' },
          shadowPhase: null,
        },
      };
      expect(hasActiveReadinessPhase(state)).toBe(true);
      expect(readinessPollInterval(state)).toBe(READINESS_FAST_INTERVAL_MS);
    }
  });

  it('uses the fast cadence while shadow mode is running even if all stages are ready', () => {
    const shadow = {
      readinessState: {
        stt: { phase: 'ready' }, llm: { phase: 'ready' }, tts: { phase: 'ready' },
        shadowPhase: 'running',
      },
    };
    expect(hasActiveReadinessPhase(shadow)).toBe(false);
    expect(readinessPollInterval(shadow)).toBe(READINESS_FAST_INTERVAL_MS);
  });

  it('is null-safe (no readiness state yet → idle cadence)', () => {
    expect(readinessPollInterval(null)).toBe(READINESS_IDLE_INTERVAL_MS);
    expect(readinessPollInterval(undefined)).toBe(READINESS_IDLE_INTERVAL_MS);
    expect(readinessPollInterval({})).toBe(READINESS_IDLE_INTERVAL_MS);
    expect(hasActiveReadinessPhase(null)).toBe(false);
  });

  it('honors custom fast/idle overrides', () => {
    expect(readinessPollInterval(ready, 500, 30_000)).toBe(30_000);
    const busy = {
      readinessState: { stt: { phase: 'benchmarking' }, llm: {}, tts: {}, shadowPhase: null },
    };
    expect(readinessPollInterval(busy, 500, 30_000)).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #935 — nav divider-vs-link predicates
// ─────────────────────────────────────────────────────────────────────────────
describe('#935 nav divider/link predicates', () => {
  const nav = [
    { id: 'overview' },
    { id: '_config', divider: true },
    { id: 'config/services' },
    { id: 'config/apps' },
    { id: '_tools', divider: true },
    { id: 'tools/playground' },
  ];

  it('classifies dividers vs links without relying on an icon', () => {
    expect(isNavSection({ id: '_config', divider: true })).toBe(true);
    expect(isNavSection({ id: 'overview' })).toBe(false);
    expect(isNavLink({ id: 'overview' })).toBe(true);
    expect(isNavLink({ id: '_config', divider: true })).toBe(false);
  });

  it('validRoutesFromNav collects only navigable link ids (drops dividers)', () => {
    const routes = validRoutesFromNav(nav);
    expect(routes.has('overview')).toBe(true);
    expect(routes.has('config/services')).toBe(true);
    expect(routes.has('tools/playground')).toBe(true);
    // Divider pseudo-ids are excluded.
    expect(routes.has('_config')).toBe(false);
    expect(routes.has('_tools')).toBe(false);
    expect(routes.size).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1000 — Grafana alert-rule accessors
// ─────────────────────────────────────────────────────────────────────────────
describe('#1000 Grafana alert rules', () => {
  it('ships real alert rules (not just panel thresholds)', () => {
    const rules = getAlertRules();
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const r of rules) {
      expect(typeof r.name).toBe('string');
      expect(typeof r.condition).toBe('string');
      expect(r.condition.length).toBeGreaterThan(0);
      expect(['critical', 'warning', 'info']).toContain(r.severity);
      expect(r.channel.startsWith('#')).toBe(true);
    }
  });

  it('covers the key SLO breaches (error rate, latency, budget, GPU down)', () => {
    const names = alertNames().join(' | ').toLowerCase();
    expect(names).toContain('error rate');
    expect(names).toContain('latency');
    expect(names).toContain('budget');
    expect(names).toMatch(/gpu/);
  });

  it('routes critical alerts to a critical channel and exposes distinct channels', () => {
    const critical = alertsBySeverity('critical');
    expect(critical.length).toBeGreaterThan(0);
    for (const r of critical) expect(r.severity).toBe('critical');

    const channels = alertChannels();
    // De-duplicated.
    expect(new Set(channels).size).toBe(channels.length);
    expect(hasAlertForChannel('#alerts-critical')).toBe(true);
    expect(hasAlertForChannel('#nonexistent-channel')).toBe(false);
  });

  it('every alert has a non-empty `for` duration window', () => {
    for (const r of getAlertRules()) {
      expect(r.for).toMatch(/^\d+[smhd]$/);
    }
  });
});
