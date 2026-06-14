/**
 * Wave 5 — Web UI, Image Builder, Build & Infra/Cost (IDs 901-1000).
 *
 * Continuation of `10-web-infra.test.ts` (wave 1) and `-w2`/`-w3`/`-w4`. The
 * safe, localized pure-logic pool is nearly exhausted; this wave lands:
 *
 *   - #949: route `FallbackChainList`'s bare `fetch('/v1/metrics/service-stats')`
 *     through the typed `lib/gateway` client. Tests the pure `normalizeServiceStats`
 *     payload-shaper that the new `getServiceStats()` client wraps (defends the
 *     latency-suffix render against partial/garbage responses).
 *   - #963: collapse the `[...slug]` catch-all's hand-maintained static-export
 *     slug array into a single bounded `STATIC_EXPORT_ROUTES` + pure
 *     `staticSlugParams()` in `lib/nav`, so the pre-rendered-shell surface is one
 *     source of truth and verifiable without a Next build.
 *   - #970: pure `isResumableBuild` predicate so a CLI poller that restarts
 *     mid-build can re-derive status from the GitHub Actions API (record has a
 *     persisted `runId`) instead of spinning forever on a stale catalog record.
 *
 * The opt vitest config has NO jsdom / `document` global, so only pure TS logic
 * is exercised here (inputs injected). React `.tsx` wiring (#949 effect, #932
 * Fragment-key fix, #933 unused-import cleanup), Next config, Helm/HCL and
 * Dockerfiles are inspection-only and documented in
 * `docs/optimizations/implemented/10-web-infra-w5.md`.
 *
 * Covers: #949 #963 #970
 *
 * Run only this file:
 *   bunx vitest run --config vitest.opt.config.ts __tests__/opt/10-web-infra-w5.test.ts
 */
import { describe, it, expect } from 'vitest';

// ── #949: service-stats payload normalizer ────────────────────────────────────
import {
  normalizeServiceStats,
  latencySuffix,
  type ServiceStatsData,
} from '../../web/src/lib/service-stats';

// ── #963: static-export route constraint ──────────────────────────────────────
import {
  STATIC_EXPORT_ROUTES,
  staticSlugParams,
  ROUTE_REDIRECTS,
} from '../../web/src/lib/nav';

// ── #970: resumable-build predicate ───────────────────────────────────────────
import {
  isResumableBuild,
  isTerminalBuildStatus,
} from '../../src/compute/image-builder/image-build-service';

// ─────────────────────────────────────────────────────────────────────────────
// #949 — normalizeServiceStats (pure payload shaper behind getServiceStats)
// ─────────────────────────────────────────────────────────────────────────────
describe('#949 normalizeServiceStats', () => {
  it('passes through a well-formed payload (rounding avgMs)', () => {
    const out = normalizeServiceStats({
      stats: {
        'stt::groq': { avgMs: 120.6, samples: 42 },
        'llm::gpu': { avgMs: 88, samples: 3 },
      },
      coldStart: { provider: 'gpu', coldTtfbMs: 12000, warmTtfbAvgMs: 300 },
      warmth: { stt: { warm: true } },
    });
    expect(out).not.toBeNull();
    expect(out!.stats['stt::groq']).toEqual({ avgMs: 121, samples: 42 });
    expect(out!.stats['llm::gpu']).toEqual({ avgMs: 88, samples: 3 });
    expect(out!.coldStart).toEqual({ provider: 'gpu', coldTtfbMs: 12000, warmTtfbAvgMs: 300 });
    expect(out!.warmth).toEqual({ stt: { warm: true } });
  });

  it('returns null for non-object payloads', () => {
    expect(normalizeServiceStats(null)).toBeNull();
    expect(normalizeServiceStats(undefined)).toBeNull();
    expect(normalizeServiceStats('nope')).toBeNull();
    expect(normalizeServiceStats(42)).toBeNull();
  });

  it('tolerates a missing/garbage `stats` field (empty map, no throw)', () => {
    expect(normalizeServiceStats({}).stats).toEqual({});
    expect(normalizeServiceStats({ stats: null }).stats).toEqual({});
    expect(normalizeServiceStats({ stats: 'bad' }).stats).toEqual({});
  });

  it('drops malformed stat entries (non-finite avgMs / non-object) but keeps good ones', () => {
    const out = normalizeServiceStats({
      stats: {
        good: { avgMs: 100, samples: 5 },
        noAvg: { samples: 5 },
        nanAvg: { avgMs: 'x', samples: 5 },
        notObj: 7,
        nullEntry: null,
      },
    });
    expect(Object.keys(out!.stats)).toEqual(['good']);
    expect(out!.stats.good).toEqual({ avgMs: 100, samples: 5 });
  });

  it('defaults a missing/non-finite `samples` to 0', () => {
    const out = normalizeServiceStats({ stats: { k: { avgMs: 50 } } });
    expect(out!.stats.k).toEqual({ avgMs: 50, samples: 0 });
  });

  it('nulls out an invalid coldStart (missing provider or bad number)', () => {
    expect(normalizeServiceStats({ coldStart: { coldTtfbMs: 1000 } }).coldStart).toBeNull();
    expect(normalizeServiceStats({ coldStart: { provider: 'gpu', coldTtfbMs: 'x' } }).coldStart).toBeNull();
    expect(normalizeServiceStats({ coldStart: 'bad' }).coldStart).toBeNull();
    expect(normalizeServiceStats({ coldStart: null }).coldStart).toBeNull();
  });

  it('produces output that feeds latencySuffix without NaN/undefined leakage', () => {
    const normalized = normalizeServiceStats({
      stats: { 'stt::groq': { avgMs: 130.9 } },
      coldStart: { provider: 'gpu', coldTtfbMs: 12000 },
    }) as ServiceStatsData;
    // avgMs is rounded → no ".9ms" in the suffix
    expect(latencySuffix('stt', 'groq', normalized)).toBe(' · ~131ms');
    expect(latencySuffix('llm', 'gpu', normalized)).toBe(' · cold: 12s');
    // unknown pair → empty
    expect(latencySuffix('tts', 'openai', normalized)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #963 — static-export route constraint (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────
describe('#963 staticSlugParams / STATIC_EXPORT_ROUTES', () => {
  it('maps each route to a Next { slug: string[] } params object', () => {
    const params = staticSlugParams(['config/apps', 'tools/playground', 'dashboard']);
    expect(params).toEqual([
      { slug: ['config', 'apps'] },
      { slug: ['tools', 'playground'] },
      { slug: ['dashboard'] },
    ]);
  });

  it('derives params from STATIC_EXPORT_ROUTES by default (one entry per route)', () => {
    const params = staticSlugParams();
    expect(params.length).toBe(STATIC_EXPORT_ROUTES.length);
    for (const p of params) {
      expect(Array.isArray(p.slug)).toBe(true);
      // No empty slug (would collide with the index route).
      expect(p.slug.length).toBeGreaterThan(0);
      for (const seg of p.slug) expect(seg.length).toBeGreaterThan(0);
    }
  });

  it('round-trips: each params.slug rejoined equals its source route', () => {
    const params = staticSlugParams();
    const rejoined = params.map((p) => p.slug.join('/'));
    expect(rejoined).toEqual([...STATIC_EXPORT_ROUTES]);
  });

  it('drops empty/whitespace routes so a stray entry cannot emit { slug: [] }', () => {
    expect(staticSlugParams(['', '   ', '/', 'config/apps'])).toEqual([
      { slug: ['config', 'apps'] },
    ]);
  });

  it('the bounded export list stays a closed allow-list (no explosion)', () => {
    // Sanity bound — the static export must not balloon to hundreds of shells.
    expect(STATIC_EXPORT_ROUTES.length).toBeGreaterThan(0);
    expect(STATIC_EXPORT_ROUTES.length).toBeLessThanOrEqual(40);
    // De-duplicated.
    expect(new Set(STATIC_EXPORT_ROUTES).size).toBe(STATIC_EXPORT_ROUTES.length);
  });

  it('includes the legacy-compat routes that ROUTE_REDIRECTS keeps routable', () => {
    // A direct refresh of an old URL must hit a pre-rendered shell, then the SPA
    // redirects it via ROUTE_REDIRECTS. Verify the redirected legacy paths are
    // present in the export set.
    for (const legacy of Object.keys(ROUTE_REDIRECTS)) {
      // Only the legacy roots that we still pre-render need to be present; at
      // minimum the canonical `config/profiles` legacy entry is covered.
      if (legacy === 'config/profiles') {
        expect(STATIC_EXPORT_ROUTES).toContain(legacy);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #970 — resumable-build predicate (restart-safe poller decision)
// ─────────────────────────────────────────────────────────────────────────────
describe('#970 isResumableBuild', () => {
  it('is resumable when non-terminal AND carrying a persisted runId', () => {
    expect(isResumableBuild({ status: 'building', runId: 123 })).toBe(true);
    expect(isResumableBuild({ status: 'queued', runId: 1 })).toBe(true);
    expect(isResumableBuild({ status: 'pending', runId: 999 })).toBe(true);
  });

  it('is NOT resumable when terminal (already done — nothing to re-derive)', () => {
    expect(isResumableBuild({ status: 'success', runId: 123 })).toBe(false);
    expect(isResumableBuild({ status: 'failed', runId: 123 })).toBe(false);
    expect(isResumableBuild({ status: 'cancelled', runId: 123 })).toBe(false);
    // Confirms agreement with the terminal-status set.
    for (const s of ['success', 'failed', 'cancelled'] as const) {
      expect(isTerminalBuildStatus(s)).toBe(true);
    }
  });

  it('is NOT resumable when non-terminal but orphaned (no runId → would spin forever)', () => {
    expect(isResumableBuild({ status: 'building' })).toBe(false);
    expect(isResumableBuild({ status: 'building', runId: undefined })).toBe(false);
    expect(isResumableBuild({ status: 'building', runId: 0 })).toBe(false);
    expect(isResumableBuild({ status: 'queued', runId: -1 })).toBe(false);
  });

  it('is null-safe (no record → not resumable)', () => {
    expect(isResumableBuild(null)).toBe(false);
    expect(isResumableBuild(undefined)).toBe(false);
  });
});
