/**
 * Wave 3 — Web UI, Image Builder, Build & Infra/Cost (IDs 901-1000).
 *
 * Continuation of `10-web-infra.test.ts` (wave 1) and `10-web-infra-w2.test.ts`
 * (wave 2). This wave centralizes divergent stage/phase color maps into pure
 * helpers, extracts framework-free navigation + latency-suffix + object-URL
 * logic out of `.tsx` components, and adds bounded-concurrency / terminal-status
 * helpers to the image builder.
 *
 * The opt vitest config has NO jsdom / `document` global, so only pure TS logic
 * is exercised here (inputs injected). React `.tsx`/hooks, YAML (Helm,
 * docker-security), HCL, and Dockerfiles are inspection-only and documented in
 * `docs/optimizations/implemented/10-web-infra-w3.md`.
 *
 * Covers: #924 #926 #933 #936 #950 #961 #951 #967 #970
 *
 * Run only this file:
 *   bunx vitest run --config vitest.opt.config.ts __tests__/opt/10-web-infra-w3.test.ts
 */
import { describe, it, expect } from 'vitest';

// ── Web: centralized stage + provider-phase registry (#924, #926, #933) ───────
import {
  stageColor,
  stageLabel,
  stageBadgeVariant,
  providerPhaseColor,
  providerPhaseLabel,
  STAGE_COLORS,
} from '../../web/src/lib/phase-colors';

// ── Web: framework-free navigation helpers (#936, #961) ───────────────────────
import {
  resolveRoute,
  routeToPath,
  normalizeHash,
  normalizePathname,
  ROUTE_REDIRECTS,
} from '../../web/src/lib/nav';

// ── Web: pure latency-suffix helper (#950) ────────────────────────────────────
import { latencySuffix, type ServiceStatsData } from '../../web/src/lib/service-stats';

// ── Web: object-URL leak helpers (#951) ───────────────────────────────────────
import { collectObjectUrls, revokeObjectUrls } from '../../web/src/lib/object-urls';

// ── Image builder: bounded concurrency + terminal status (#967, #970) ─────────
import { partitionForConcurrency, DEFAULT_BLOB_UPLOAD_CONCURRENCY } from '../../src/compute/image-builder/github-repo';
import { isTerminalBuildStatus, TERMINAL_BUILD_STATUSES } from '../../src/compute/image-builder/image-build-service';
import type { ImageBuildStatus } from '../../src/compute/image-builder/types';

// ══════════════════════════════════════════════════════════════════════════════
// #926 / #933 — single source of truth for stage colors / labels / variants
// ══════════════════════════════════════════════════════════════════════════════
describe('#926 stage color/label registry (phase-colors)', () => {
  it('returns the canonical accent for each pipeline stage', () => {
    expect(stageColor('stt')).toBe(STAGE_COLORS.stt);
    expect(stageColor('llm')).toBe(STAGE_COLORS.llm);
    expect(stageColor('tts')).toBe(STAGE_COLORS.tts);
  });

  it('maps non-pipeline stages (image, pipeline) to a shared emerald accent', () => {
    expect(stageColor('image')).toBe('#34d399');
    expect(stageColor('pipeline')).toBe('#34d399');
  });

  it('falls back to the muted token for unknown stages', () => {
    expect(stageColor('nope')).toBe('var(--color-text-muted)');
  });

  it('produces short uppercase labels with a sensible fallback', () => {
    expect(stageLabel('stt')).toBe('STT');
    expect(stageLabel('llm')).toBe('LLM');
    expect(stageLabel('image')).toBe('IMG');
    expect(stageLabel('custom')).toBe('CUSTOM'); // fallback = uppercase
  });

  it('maps stages to the correct StatusBadge variant', () => {
    expect(stageBadgeVariant('stt')).toBe('blue');
    expect(stageBadgeVariant('llm')).toBe('violet');
    expect(stageBadgeVariant('tts')).toBe('amber');
    expect(stageBadgeVariant('pipeline')).toBe('emerald');
    expect(stageBadgeVariant('image')).toBe('emerald');
    expect(stageBadgeVariant('???')).toBe('gray');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #924 — provider-phase color/label centralization (PipelineHealthCard)
// ══════════════════════════════════════════════════════════════════════════════
describe('#924 provider phase color/label', () => {
  it('treats active/ok/ready as the same green', () => {
    expect(providerPhaseColor('active')).toBe('#10b981');
    expect(providerPhaseColor('ok')).toBe('#10b981');
    expect(providerPhaseColor('ready')).toBe('#10b981');
  });

  it('colors degraded/error/benchmarking/repechage distinctly', () => {
    expect(providerPhaseColor('benchmarking')).toBe('#fbbf24');
    expect(providerPhaseColor('degraded')).toBe('#f97316');
    expect(providerPhaseColor('repechage')).toBe('#a78bfa');
    expect(providerPhaseColor('error')).toBe('#ef4444');
  });

  it('falls back to idle gray for unknown phases', () => {
    expect(providerPhaseColor('idle')).toBe('#52525b');
    // @ts-expect-error — exercising the runtime fallback path
    expect(providerPhaseColor('mystery')).toBe('#52525b');
  });

  it('shortens labels (benchmarking→bench…, repechage→retry)', () => {
    expect(providerPhaseLabel('benchmarking')).toBe('bench…');
    expect(providerPhaseLabel('repechage')).toBe('retry');
    expect(providerPhaseLabel('active')).toBe('active');
    // @ts-expect-error — runtime fallback
    expect(providerPhaseLabel('whatever')).toBe('idle');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #936 / #961 — pure route resolution + URL building
// ══════════════════════════════════════════════════════════════════════════════
describe('#936 nav: resolveRoute', () => {
  const ROUTES = new Set(['overview', 'config/apps', 'tools/playground', 'monitor/readiness']);

  it('prefers an exact hash match (/#/config/apps)', () => {
    expect(resolveRoute('/', '#/config/apps', ROUTES)).toBe('config/apps');
  });

  it('matches an exact pathname', () => {
    expect(resolveRoute('/tools/playground', '', ROUTES)).toBe('tools/playground');
  });

  it('redirects renamed/removed pages', () => {
    expect(resolveRoute('/config/profiles', '', ROUTES)).toBe('config/apps');
    expect(resolveRoute('/config/providers', '', ROUTES)).toBe('config/apps');
    expect(resolveRoute('/tools/pipeline', '', ROUTES)).toBe('tools/playground');
  });

  it('matches nested sub-routes by prefix (edit pages)', () => {
    expect(resolveRoute('/config/apps/edit/abc123', '', ROUTES)).toBe('config/apps');
  });

  it('falls back to overview for unknown paths', () => {
    expect(resolveRoute('/totally/unknown', '', ROUTES)).toBe('overview');
    expect(resolveRoute('/', '', ROUTES)).toBe('overview');
  });

  it('tolerates trailing slashes and bare # hashes', () => {
    expect(resolveRoute('/config/apps/', '', ROUTES)).toBe('config/apps');
    expect(resolveRoute('/', '#config/apps', ROUTES)).toBe('config/apps');
  });

  it('only redirects to a target that is actually a valid route', () => {
    const tiny = new Set(['overview']); // config/apps not present
    expect(resolveRoute('/config/profiles', '', tiny)).toBe('overview');
    // sanity: the redirect table still maps it
    expect(ROUTE_REDIRECTS['config/profiles']).toBe('config/apps');
  });
});

describe('#961 nav: routeToPath + normalizers', () => {
  it('maps overview → / and others → /<id>', () => {
    expect(routeToPath('overview')).toBe('/');
    expect(routeToPath('config/apps')).toBe('/config/apps');
  });

  it('round-trips a non-overview route through path→resolve', () => {
    const ROUTES = new Set(['overview', 'config/apps']);
    const path = routeToPath('config/apps'); // "/config/apps"
    expect(resolveRoute(path, '', ROUTES)).toBe('config/apps');
  });

  it('normalizeHash strips #/ and #', () => {
    expect(normalizeHash('#/config/apps')).toBe('config/apps');
    expect(normalizeHash('#config/apps')).toBe('config/apps');
    expect(normalizeHash('')).toBe('');
  });

  it('normalizePathname strips leading + trailing slashes', () => {
    expect(normalizePathname('/config/apps/')).toBe('config/apps');
    expect(normalizePathname('/')).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #950 — pure latency suffix
// ══════════════════════════════════════════════════════════════════════════════
describe('#950 service-stats: latencySuffix', () => {
  const stats: ServiceStatsData = {
    stats: { 'llm::groq': { avgMs: 120, samples: 9 }, 'stt::gpu': { avgMs: 80, samples: 4 } },
    coldStart: { provider: 'gpu', coldTtfbMs: 12_000, warmTtfbAvgMs: 400 },
  };

  it('returns empty string with no stats', () => {
    expect(latencySuffix('llm', 'groq', null)).toBe('');
    expect(latencySuffix('llm', 'groq', undefined)).toBe('');
  });

  it('emits ~Nms for a known stage::provider', () => {
    expect(latencySuffix('llm', 'groq', stats)).toBe(' · ~120ms');
  });

  it('adds GPU cold-start seconds derived from coldTtfbMs', () => {
    expect(latencySuffix('stt', 'gpu', stats)).toBe(' · ~80ms · cold: 12s');
  });

  it('uses the fixed ~10s serverless cold-start note for modal', () => {
    // no avgMs entry for tts::modal → only the cold note shows
    expect(latencySuffix('tts', 'modal', stats)).toBe(' · cold: ~10s');
    expect(latencySuffix('tts', 'modal-moss', stats)).toBe(' · cold: ~10s');
  });

  it('returns empty for an unknown provider with no cold start', () => {
    const noCold: ServiceStatsData = { stats: {}, coldStart: null };
    expect(latencySuffix('llm', 'fireworks', noCold)).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #951 — object-URL leak tracking
// ══════════════════════════════════════════════════════════════════════════════
describe('#951 object-urls: collect + revoke', () => {
  it('collects distinct truthy audioUrls', () => {
    const urls = collectObjectUrls([
      { audioUrl: 'blob:a' },
      { audioUrl: undefined },
      { audioUrl: 'blob:b' },
      { audioUrl: 'blob:a' }, // dup
      {},
    ]);
    expect(urls.sort()).toEqual(['blob:a', 'blob:b']);
  });

  it('returns an empty list when there is nothing to revoke', () => {
    expect(collectObjectUrls([])).toEqual([]);
    expect(collectObjectUrls([{}, { audioUrl: undefined }])).toEqual([]);
  });

  it('revokes each distinct URL exactly once via the injected revoker', () => {
    const seen: string[] = [];
    revokeObjectUrls(
      [{ audioUrl: 'blob:x' }, { audioUrl: 'blob:x' }, { audioUrl: 'blob:y' }],
      (u) => seen.push(u),
    );
    expect(seen.sort()).toEqual(['blob:x', 'blob:y']);
  });

  it('never throws if the revoker throws (best-effort cleanup)', () => {
    expect(() =>
      revokeObjectUrls([{ audioUrl: 'blob:z' }], () => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #967 — bounded-concurrency batching for blob uploads
// ══════════════════════════════════════════════════════════════════════════════
describe('#967 partitionForConcurrency', () => {
  it('splits into fixed-size batches preserving order', () => {
    expect(partitionForConcurrency([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns no batches for an empty input', () => {
    expect(partitionForConcurrency([], 4)).toEqual([]);
  });

  it('coerces size <= 0 to 1 (never empty/infinite batches)', () => {
    expect(partitionForConcurrency([1, 2], 0)).toEqual([[1], [2]]);
    expect(partitionForConcurrency([1, 2], -3)).toEqual([[1], [2]]);
  });

  it('flattens back to the original list regardless of batch size', () => {
    const items = Array.from({ length: 13 }, (_, i) => i);
    for (const size of [1, 3, 6, 100]) {
      expect(partitionForConcurrency(items, size).flat()).toEqual(items);
    }
  });

  it('exposes a sane default upload concurrency', () => {
    expect(DEFAULT_BLOB_UPLOAD_CONCURRENCY).toBeGreaterThan(0);
    expect(DEFAULT_BLOB_UPLOAD_CONCURRENCY).toBeLessThanOrEqual(20);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #970 — terminal build status predicate (restart-safe poller exit)
// ══════════════════════════════════════════════════════════════════════════════
describe('#970 isTerminalBuildStatus', () => {
  it('treats success/failed/cancelled as terminal', () => {
    expect(isTerminalBuildStatus('success')).toBe(true);
    expect(isTerminalBuildStatus('failed')).toBe(true);
    expect(isTerminalBuildStatus('cancelled')).toBe(true);
  });

  it('treats in-flight statuses as non-terminal', () => {
    const inFlight: ImageBuildStatus[] = ['pending', 'queued', 'building'];
    for (const s of inFlight) expect(isTerminalBuildStatus(s)).toBe(false);
  });

  it('the terminal set contains exactly the three terminal statuses', () => {
    expect([...TERMINAL_BUILD_STATUSES].sort()).toEqual(['cancelled', 'failed', 'success']);
  });
});
