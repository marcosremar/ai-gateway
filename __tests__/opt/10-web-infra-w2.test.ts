/**
 * Optimization suite 10 — WAVE 2.
 *
 * Continuation of `10-web-infra.test.ts`. Wave 1 covered #940/#952/#942/#972/
 * #966/#975/#968 + feature-flag numeric NaN guard. This wave adds the NEXT batch
 * of safe, localized fixes from docs/optimizations/10-web-build-infra-cost.md:
 *
 *   - #971  Blackwell arch-variant tag mapping (image-build-service)
 *   - #974  pickWorkflowRun — match our generated build run, not an unrelated one
 *   - #973  pruneCatalogRecords — TTL + hard-cap catalog eviction
 *   - #969  generated workflow pins actions to SHAs (generateWorkflow output)
 *   - #945  computeStageLatencies / computeProviderTrends extracted + pure
 *   - #946  sparklinePoints — Math.max hoisted out of the per-point map
 *   - (flags) parseEnvFlagValue — tolerant boolean tokens + NaN-guarded numbers
 *   - (browser) joinCdnUrl / normalizeCdnBase — no double-slash at the seam
 *
 * Unit-only, no network, no DOM. Pure functions are imported via relative paths
 * (the opt vitest config has no jsdom/document global, so `.tsx`/React hooks,
 * YAML, HCL, Dockerfiles and next.config remain inspection-only).
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  tagSuffixForPlatforms,
  resolveImageTag,
  nextBuildPollDelayMs,
} from '../../src/compute/image-builder/image-build-service';

import {
  pickWorkflowRun,
  BUILD_WORKFLOW_NAME,
  PINNED_ACTIONS,
  generateWorkflow,
} from '../../src/compute/image-builder/github-repo';

import {
  pruneCatalogRecords,
  DEFAULT_MAX_CATALOG_RECORDS,
  DEFAULT_CATALOG_TTL_MS,
} from '../../src/compute/image-builder/image-catalog';
import type { ImageBuildRecord, ImageBuildStatus } from '../../src/compute/image-builder/types';

import {
  computeStageLatencies,
  computeProviderTrends,
  sparklinePoints,
  type LatencyLogEntry,
} from '../../web/src/lib/metrics';

import { parseEnvFlagValue, featureFlags } from '../../src/feature-flags';

import { joinCdnUrl, normalizeCdnBase } from '../../src/browser/cdn-config';

// ── #971: Blackwell arch-variant tag mapping ─────────────────────────────────

describe('image-build-service: tagSuffixForPlatforms (#971)', () => {
  it('returns no suffix for ordinary platforms', () => {
    expect(tagSuffixForPlatforms('linux/amd64')).toBe('');
    expect(tagSuffixForPlatforms('linux/amd64,linux/arm64')).toBe('');
    expect(tagSuffixForPlatforms(undefined)).toBe('');
  });

  it('detects a Blackwell target (marker / sm_120) case-insensitively', () => {
    expect(tagSuffixForPlatforms('linux/amd64+blackwell')).toBe('blackwell');
    expect(tagSuffixForPlatforms('linux/amd64,BLACKWELL')).toBe('blackwell');
    expect(tagSuffixForPlatforms('sm_120')).toBe('blackwell');
    expect(tagSuffixForPlatforms('sm120')).toBe('blackwell');
  });
});

describe('image-build-service: resolveImageTag (#971)', () => {
  it('leaves a non-Blackwell tag unchanged', () => {
    expect(resolveImageTag('latest', 'linux/amd64')).toBe('latest');
    expect(resolveImageTag('v2', 'linux/amd64')).toBe('v2');
    expect(resolveImageTag(undefined, 'linux/amd64')).toBe('latest');
  });

  it('maps latest → blackwell for a Blackwell build', () => {
    expect(resolveImageTag('latest', 'blackwell')).toBe('blackwell');
    expect(resolveImageTag(undefined, 'sm_120')).toBe('blackwell');
  });

  it('suffixes a custom tag and is idempotent', () => {
    expect(resolveImageTag('v2', 'blackwell')).toBe('v2-blackwell');
    expect(resolveImageTag('v2-blackwell', 'blackwell')).toBe('v2-blackwell');
    expect(resolveImageTag('blackwell', 'blackwell')).toBe('blackwell');
  });
});

// ── #974: pick the right workflow run ────────────────────────────────────────

describe('github-repo: pickWorkflowRun (#974)', () => {
  const mk = (over: Record<string, unknown>) => ({
    id: 1, status: 'queued', conclusion: null, html_url: 'x', name: 'Other', ...over,
  });

  it('returns null for an empty / non-array list', () => {
    expect(pickWorkflowRun([])).toBeNull();
    expect(pickWorkflowRun(undefined as unknown as [])).toBeNull();
  });

  it('prefers the run matching the build workflow name over the newest', () => {
    const runs = [
      mk({ id: 10, name: 'CI Tests' }),
      mk({ id: 11, name: BUILD_WORKFLOW_NAME }),
    ];
    expect(pickWorkflowRun(runs)?.id).toBe(11);
  });

  it('matches by workflow file path when the name differs', () => {
    const runs = [
      mk({ id: 20, name: 'Lint', path: '.github/workflows/lint.yml' }),
      mk({ id: 21, name: 'renamed', path: '.github/workflows/docker-build.yml' }),
    ];
    expect(pickWorkflowRun(runs)?.id).toBe(21);
  });

  it('falls back to the newest run when nothing identifies the build', () => {
    const runs = [mk({ id: 30, name: 'A' }), mk({ id: 31, name: 'B' })];
    expect(pickWorkflowRun(runs)?.id).toBe(30);
  });
});

// ── #973: catalog eviction / retention ───────────────────────────────────────

describe('image-catalog: pruneCatalogRecords (#973)', () => {
  const now = 1_000_000_000_000;
  const rec = (id: string, status: ImageBuildStatus, ageMs: number): ImageBuildRecord => ({
    id, name: 'n', tag: 'latest', image: '', repoUrl: '', owner: 'o', repoName: 'r',
    status, createdAt: now - ageMs, updatedAt: now - ageMs, completedAt: now - ageMs,
    platforms: 'linux/amd64',
  });

  it('hard-caps to maxRecords (newest-first preserved)', () => {
    const records = Array.from({ length: 5 }, (_, i) => rec(`b${i}`, 'success', i * 1000));
    const pruned = pruneCatalogRecords(records, 3, DEFAULT_CATALOG_TTL_MS, now);
    expect(pruned).toHaveLength(3);
    expect(pruned.map(r => r.id)).toEqual(['b0', 'b1', 'b2']);
  });

  it('evicts terminal records older than the TTL', () => {
    const records = [
      rec('fresh', 'success', 1_000),
      rec('stale', 'success', DEFAULT_CATALOG_TTL_MS + 5_000),
    ];
    const pruned = pruneCatalogRecords(records, 100, DEFAULT_CATALOG_TTL_MS, now);
    expect(pruned.map(r => r.id)).toEqual(['fresh']);
  });

  it('never TTL-evicts in-flight records regardless of age', () => {
    const records = [rec('building', 'building', DEFAULT_CATALOG_TTL_MS * 10)];
    const pruned = pruneCatalogRecords(records, 100, DEFAULT_CATALOG_TTL_MS, now);
    expect(pruned.map(r => r.id)).toEqual(['building']);
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_MAX_CATALOG_RECORDS).toBe(100);
    expect(DEFAULT_CATALOG_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

// ── #969: generated workflow pins actions to SHAs ────────────────────────────

describe('github-repo: generateWorkflow pins actions to SHAs (#969)', () => {
  const wf = generateWorkflow('img', 'linux/amd64');

  it('uses no floating @vN action tags', () => {
    // e.g. `uses: actions/checkout@v4` — every `uses:` should reference a 40-hex SHA.
    const usesLines = wf.split('\n').filter(l => l.trim().startsWith('uses:'));
    expect(usesLines.length).toBeGreaterThanOrEqual(6);
    for (const line of usesLines) {
      expect(line).toMatch(/uses:\s+\S+@[0-9a-f]{40}/);
      expect(line).not.toMatch(/@v\d+(\.\d+)*\s*$/);
    }
  });

  it('embeds the pinned checkout + build-push SHAs from PINNED_ACTIONS', () => {
    expect(wf).toContain(PINNED_ACTIONS.checkout);
    expect(wf).toContain(PINNED_ACTIONS.buildPush);
    // sanity: each pinned ref is action@<40-hex>
    for (const ref of Object.values(PINNED_ACTIONS)) {
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });
});

// ── #945: stage latency + provider trend math (pure) ─────────────────────────

describe('metrics: computeStageLatencies (#945)', () => {
  const e = (over: Partial<LatencyLogEntry>): LatencyLogEntry => ({
    stage: 'stt', provider: 'groq', latencyMs: 100, timestamp: 0, success: true, ...over,
  });

  it('ignores failed entries', () => {
    const out = computeStageLatencies([
      e({ latencyMs: 100, timestamp: 0 }),
      e({ latencyMs: 999, timestamp: 1000, success: false }),
    ]);
    expect(out.stt.samples).toBe(1);
    // the sole surviving sample is the first → counts as a cold start.
    expect(out.stt.cold).toBe(100);
    expect(out.stt.warm).toBeNull();
  });

  it('splits cold (>60s gap) vs warm and averages each', () => {
    const out = computeStageLatencies([
      e({ latencyMs: 500, timestamp: 0 }),            // first → cold
      e({ latencyMs: 100, timestamp: 1_000 }),        // warm (1s gap)
      e({ latencyMs: 200, timestamp: 2_000 }),        // warm
      e({ latencyMs: 600, timestamp: 200_000 }),      // cold (>60s gap)
    ]);
    expect(out.stt.cold).toBe(550);   // (500 + 600) / 2
    expect(out.stt.warm).toBe(150);   // (100 + 200) / 2
    expect(out.stt.samples).toBe(4);
    expect(out.stt.provider).toBe('groq');
  });

  it('buckets multiple stages independently', () => {
    const out = computeStageLatencies([
      e({ stage: 'stt', latencyMs: 100, timestamp: 0 }),
      e({ stage: 'llm', latencyMs: 300, timestamp: 0 }),
    ]);
    expect(Object.keys(out).sort()).toEqual(['llm', 'stt']);
    expect(out.llm.cold).toBe(300);
  });
});

describe('metrics: computeProviderTrends (#945)', () => {
  it('windows the last N successful latencies per provider', () => {
    const entries: LatencyLogEntry[] = [];
    for (let i = 0; i < 25; i++) {
      entries.push({ stage: 'stt', provider: 'groq', latencyMs: i, timestamp: i, success: true });
    }
    const trends = computeProviderTrends(entries, 20);
    expect(trends.groq).toHaveLength(20);
    expect(trends.groq[0]).toBe(5);   // dropped first 5
    expect(trends.groq.at(-1)).toBe(24);
  });

  it('omits failed samples from the trend', () => {
    const trends = computeProviderTrends([
      { stage: 'stt', provider: 'groq', latencyMs: 1, timestamp: 0, success: true },
      { stage: 'stt', provider: 'groq', latencyMs: 9, timestamp: 1, success: false },
    ]);
    expect(trends.groq).toEqual([1]);
  });
});

// ── #946: sparkline points (Math.max hoisted) ────────────────────────────────

describe('metrics: sparklinePoints (#946)', () => {
  it('returns empty string for <2 points (nothing to draw)', () => {
    expect(sparklinePoints([])).toBe('');
    expect(sparklinePoints([5])).toBe('');
  });

  it('produces one "x,y" pair per data point', () => {
    const pts = sparklinePoints([1, 2, 3]);
    expect(pts.split(' ')).toHaveLength(3);
    expect(pts).toMatch(/^[\d.]+,[\d.]+( [\d.]+,[\d.]+)*$/);
  });

  it('maps the max value to the top of the chart and is monotonic in x', () => {
    const w = 38, h = 14, pad = 1;
    const pts = sparklinePoints([0, 100], w, h, pad).split(' ').map(p => p.split(',').map(Number));
    // x spans pad..(pad+width); y for the max (100) is the top (pad).
    expect(pts[0][0]).toBeCloseTo(pad);
    expect(pts[1][0]).toBeCloseTo(pad + w);
    expect(pts[1][1]).toBeCloseTo(pad);          // max → top (smallest y)
    expect(pts[0][1]).toBeGreaterThan(pts[1][1]); // lower value → larger y
  });
});

// ── feature-flags: tolerant env parsing ──────────────────────────────────────

describe('feature-flags: parseEnvFlagValue (tolerant boolean + NaN-guarded number)', () => {
  it('parses truthy boolean tokens case-insensitively / trimmed', () => {
    for (const t of ['true', 'TRUE', ' True ', '1', 'yes', 'on', 'Y']) {
      expect(parseEnvFlagValue(t, false)).toBe(true);
    }
  });

  it('parses falsy boolean tokens', () => {
    for (const t of ['false', 'FALSE', '0', 'no', 'off', '']) {
      expect(parseEnvFlagValue(t, true)).toBe(false);
    }
  });

  it('falls back to the default for an unrecognized boolean token', () => {
    expect(parseEnvFlagValue('maybe', true)).toBe(true);
    expect(parseEnvFlagValue('maybe', false)).toBe(false);
  });

  it('NaN-guards numbers and uses verbatim strings', () => {
    expect(parseEnvFlagValue('0.25', 0.8)).toBe(0.25);
    expect(parseEnvFlagValue('abc', 0.8)).toBe(0.8);
    expect(parseEnvFlagValue('gpt-4o', 'default')).toBe('gpt-4o');
  });

  it('returns the default when raw is undefined', () => {
    expect(parseEnvFlagValue(undefined, true)).toBe(true);
    expect(parseEnvFlagValue(undefined, 7)).toBe(7);
  });
});

describe('feature-flags: define() honors tolerant boolean env overrides', () => {
  const ENV = 'TEST_OPT10W2_BOOL_FLAG';
  afterEach(() => { delete process.env[ENV]; });

  it('treats "TRUE" (mixed case) as enabled (regression on === "true")', () => {
    process.env[ENV] = 'TRUE';
    featureFlags.define('opt10w2-bool', { description: 'b', defaultValue: false, envVar: ENV });
    expect(featureFlags.isEnabled('opt10w2-bool')).toBe(true);
  });

  it('treats "off" as disabled', () => {
    process.env[ENV] = 'off';
    featureFlags.define('opt10w2-bool-2', { description: 'b', defaultValue: true, envVar: ENV });
    expect(featureFlags.isEnabled('opt10w2-bool-2')).toBe(false);
  });
});

// ── browser cdn-config: URL joining ──────────────────────────────────────────

describe('cdn-config: joinCdnUrl / normalizeCdnBase', () => {
  it('joins without a double slash at the seam', () => {
    expect(joinCdnUrl('https://cdn.example.com/ai', 'browser.js')).toBe('https://cdn.example.com/ai/browser.js');
    expect(joinCdnUrl('https://cdn.example.com/ai/', '/browser.js')).toBe('https://cdn.example.com/ai/browser.js');
    expect(joinCdnUrl('https://cdn.example.com/ai//', '//browser.js')).toBe('https://cdn.example.com/ai/browser.js');
  });

  it('preserves the scheme slashes', () => {
    expect(joinCdnUrl('https://cdn.example.com', 'a/b.js')).toContain('https://');
  });

  it('returns the base alone for an empty path', () => {
    expect(joinCdnUrl('https://cdn.example.com/ai/', '')).toBe('https://cdn.example.com/ai');
  });

  it('normalizeCdnBase trims whitespace and trailing slashes', () => {
    expect(normalizeCdnBase('  https://cdn.example.com/ai///  ')).toBe('https://cdn.example.com/ai');
    expect(normalizeCdnBase('https://cdn.example.com')).toBe('https://cdn.example.com');
  });
});
