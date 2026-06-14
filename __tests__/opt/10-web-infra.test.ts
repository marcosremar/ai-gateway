/**
 * Optimization suite 10 — Web UI, Image Builder, Build & Infra/Cost.
 *
 * Covers the PURE TS logic extracted/changed for the fixes implemented from
 * docs/optimizations/10-web-build-infra-cost.md:
 *
 *   - #940/#952  visibility-aware polling predicates (web/src/hooks/polling-logic)
 *   - #942       shared-WebSocket URL resolution + event reducer
 *                (web/src/hooks/gateway-ws-logic, mirrored in useGatewayWs)
 *   - (flags)    feature-flag numeric env parsing NaN guard (src/feature-flags)
 *   - #972       build-context size cap (src/compute/image-builder/github-repo)
 *   - #966/#975  generated build-workflow cache-from + concurrency group
 *   - #968       build-status poll backoff (image-build-service)
 *
 * Unit-only, no network, no DOM. The opt vitest config has no jsdom/document
 * global, so visibility logic is tested via the pure predicate (the `hidden`
 * flag is injected) rather than the React hook.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  shouldPoll,
  effectivePollInterval,
  gpuPollInterval,
  ACTIVE_GPU_STATUSES,
  FAST_GPU_INTERVAL_MS,
} from '../../web/src/hooks/polling-logic';

import {
  resolveGatewayWsUrl,
  reduceGatewayWsEvent,
  INITIAL_WS_STATE,
  type GatewayWsState,
} from '../../web/src/hooks/gateway-ws-logic';

import {
  assertBuildContextSize,
  maxBuildContextBytes,
  DEFAULT_MAX_BUILD_CONTEXT_BYTES,
  generateWorkflow,
  isSensitiveBuildPath,
} from '../../src/compute/image-builder/github-repo';

import { nextBuildPollDelayMs } from '../../src/compute/image-builder/image-build-service';

import { featureFlags } from '../../src/feature-flags';

// ── #940/#952: visibility-aware polling predicate ────────────────────────────

describe('polling-logic: shouldPoll gates on document.hidden (#940)', () => {
  it('fires a tick when the tab is visible', () => {
    expect(shouldPoll(false)).toBe(true);
  });

  it('skips a tick when the tab is hidden', () => {
    expect(shouldPoll(true)).toBe(false);
  });
});

describe('polling-logic: effectivePollInterval slows/pauses hidden tabs (#952)', () => {
  it('uses the foreground cadence when visible', () => {
    expect(effectivePollInterval(10_000, false)).toBe(10_000);
  });

  it('stops polling entirely (null) when hidden by default', () => {
    expect(effectivePollInterval(10_000, true)).toBeNull();
  });

  it('drops to the slow keepalive cadence when hidden and one is provided', () => {
    expect(effectivePollInterval(10_000, true, 60_000)).toBe(60_000);
  });
});

describe('polling-logic: gpuPollInterval fast-polls active transitions', () => {
  it('uses the fast interval for every active/transition status', () => {
    for (const status of ACTIVE_GPU_STATUSES) {
      expect(gpuPollInterval(status, 5_000)).toBe(FAST_GPU_INTERVAL_MS);
    }
  });

  it('uses the base interval for steady/unknown statuses', () => {
    expect(gpuPollInterval('ready', 5_000)).toBe(5_000);
    expect(gpuPollInterval(undefined, 5_000)).toBe(5_000);
  });
});

// ── #942: shared-WebSocket URL resolution ────────────────────────────────────

describe('gateway-ws-logic: resolveGatewayWsUrl (#942)', () => {
  it('returns null on HTTPS production (single Fly.io port)', () => {
    expect(
      resolveGatewayWsUrl({ hostname: 'app.example.com', protocol: 'https:', port: '443' }),
    ).toBeNull();
  });

  it('maps the Next dev port 3000 to the gateway WS port 4001', () => {
    expect(
      resolveGatewayWsUrl({ hostname: 'localhost', protocol: 'http:', port: '3000' }),
    ).toBe('ws://localhost:4001/');
  });

  it('uses port+1 for any other non-secure port', () => {
    expect(
      resolveGatewayWsUrl({ hostname: '127.0.0.1', protocol: 'http:', port: '4000' }),
    ).toBe('ws://127.0.0.1:4001/');
  });
});

// ── #942: WebSocket event reducer is pure and shared ─────────────────────────

describe('gateway-ws-logic: reduceGatewayWsEvent (#942)', () => {
  it('does not mutate the previous state (pure reducer)', () => {
    const prev: GatewayWsState = { ...INITIAL_WS_STATE };
    const frozen = JSON.stringify(prev);
    reduceGatewayWsEvent(prev, { type: 'unknown-event', foo: 1 });
    expect(JSON.stringify(prev)).toBe(frozen);
  });

  it('records the last event for every message type', () => {
    const msg = { type: 'pong', foo: 'bar' };
    const next = reduceGatewayWsEvent(INITIAL_WS_STATE, msg);
    expect(next.lastEvent).toBe(msg);
  });

  it('applies a gpu:status event into gpuStatus + readinessPhase + a transition', () => {
    const next = reduceGatewayWsEvent(INITIAL_WS_STATE, {
      type: 'gpu:status',
      gpuStatus: 'ready',
      tier: 'gpu',
      reason: 'boot complete',
      endpoint: 'http://x',
      gpuType: 'RTX 4090',
      modelWarmth: { stt: true, llm: true, tts: false },
      pipelineRouting: null,
      readiness: { phase: 'shadow', shadowRuns: 2 },
    });
    expect(next.gpuStatus?.gpuStatus).toBe('ready');
    expect(next.readinessPhase).toBe('shadow');
    expect(next.transitions).toHaveLength(1);
    expect(next.transitions[0]).toMatchObject({ phase: 'shadow', stage: 'all', detail: 'boot complete' });
  });

  it('caps the transitions ring buffer at 50 entries', () => {
    let state: GatewayWsState = { ...INITIAL_WS_STATE };
    for (let i = 0; i < 60; i++) {
      state = reduceGatewayWsEvent(state, {
        type: 'gpu:readiness',
        // alternate stage so every event is recorded as a transition
        stage: i % 2 === 0 ? 'stt' : 'llm',
        phase: `phase-${i}`,
      });
    }
    expect(state.transitions.length).toBe(50);
    // newest entry retained
    expect(state.transitions[state.transitions.length - 1].phase).toBe('phase-59');
  });

  it('tracks benchmark progress per stage during benchmarking', () => {
    const next = reduceGatewayWsEvent(INITIAL_WS_STATE, {
      type: 'gpu:readiness',
      stage: 'llm',
      phase: 'benchmarking',
      run: 3,
      totalRuns: 5,
      bestLatencyMs: 120,
      targetMs: 200,
    });
    expect(next.benchmarkProgress.llm).toMatchObject({ run: 3, totalRuns: 5, bestMs: 120, targetMs: 200 });
  });

  it('clears shadow progress on condemned / auto-recovery phases', () => {
    const withShadow = reduceGatewayWsEvent(INITIAL_WS_STATE, {
      type: 'gpu:readiness', stage: 'all', phase: 'shadow', shadowCompletedRuns: 1, shadowTotalRuns: 5,
    });
    expect(withShadow.shadowProgress).toEqual({ completed: 1, total: 5 });
    const cleared = reduceGatewayWsEvent(withShadow, {
      type: 'gpu:readiness', stage: 'all', phase: 'condemned',
    });
    expect(cleared.shadowProgress).toBeNull();
  });
});

// ── feature-flags: numeric env override NaN guard ────────────────────────────

describe('feature-flags: numeric env override falls back on unparseable values', () => {
  const ENV = 'TEST_OPT10_NUM_FLAG';
  afterEach(() => { delete process.env[ENV]; });

  it('falls back to the default when the env value is not a number', () => {
    process.env[ENV] = 'abc';
    featureFlags.define('opt10-num-flag', { description: 'n', defaultValue: 0.8, envVar: ENV });
    expect(featureFlags.get('opt10-num-flag', 0)).toBe(0.8);
  });

  it('honors a valid numeric env override', () => {
    process.env[ENV] = '0.25';
    featureFlags.define('opt10-num-flag-2', { description: 'n', defaultValue: 0.8, envVar: ENV });
    expect(featureFlags.get('opt10-num-flag-2', 0)).toBe(0.25);
  });

  it('uses the default when no env var is set', () => {
    featureFlags.define('opt10-num-flag-3', { description: 'n', defaultValue: 0.8, envVar: ENV });
    expect(featureFlags.get('opt10-num-flag-3', 0)).toBe(0.8);
  });
});

// ── #972: build-context size cap ─────────────────────────────────────────────

describe('image-builder: assertBuildContextSize caps total bytes (#972)', () => {
  it('returns the total when within budget', () => {
    expect(assertBuildContextSize([1024, 2048], 1024 * 1024)).toBe(3072);
  });

  it('throws a clear, actionable error when over the limit', () => {
    expect(() => assertBuildContextSize([30 * 1024 * 1024], 25 * 1024 * 1024)).toThrow(/exceeding the 25MB limit/);
    expect(() => assertBuildContextSize([30 * 1024 * 1024], 25 * 1024 * 1024)).toThrow(/Pre-bake/);
  });

  it('ignores negative / NaN file sizes rather than corrupting the sum', () => {
    expect(assertBuildContextSize([100, -5, NaN, 50], 1024)).toBe(150);
  });

  it('defaults to 25MB', () => {
    expect(DEFAULT_MAX_BUILD_CONTEXT_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('image-builder: maxBuildContextBytes env override', () => {
  const ENV = 'AI_GATEWAY_MAX_BUILD_CONTEXT_MB';
  beforeEach(() => { delete process.env[ENV]; });
  afterEach(() => { delete process.env[ENV]; });

  it('uses the default when unset', () => {
    expect(maxBuildContextBytes()).toBe(DEFAULT_MAX_BUILD_CONTEXT_BYTES);
  });

  it('honors a positive override (MB → bytes)', () => {
    process.env[ENV] = '100';
    expect(maxBuildContextBytes()).toBe(100 * 1024 * 1024);
  });

  it('ignores a non-positive / unparseable override', () => {
    process.env[ENV] = '0';
    expect(maxBuildContextBytes()).toBe(DEFAULT_MAX_BUILD_CONTEXT_BYTES);
    process.env[ENV] = 'lots';
    expect(maxBuildContextBytes()).toBe(DEFAULT_MAX_BUILD_CONTEXT_BYTES);
  });
});

describe('image-builder: isSensitiveBuildPath (still excludes secrets)', () => {
  it('excludes .env and key material', () => {
    expect(isSensitiveBuildPath('.env')).toBe(true);
    expect(isSensitiveBuildPath('certs/server.pem')).toBe(true);
    expect(isSensitiveBuildPath('.ssh/id_rsa')).toBe(true);
  });

  it('allows ordinary build files', () => {
    expect(isSensitiveBuildPath('Dockerfile')).toBe(false);
    expect(isSensitiveBuildPath('src/server.py')).toBe(false);
  });
});

// ── #966/#975: generated build workflow hardening ────────────────────────────

describe('image-builder: generateWorkflow cache + concurrency (#966/#975)', () => {
  const wf = generateWorkflow('my-img', 'linux/amd64');

  it('adds a concurrency group that cancels in-flight rebuilds (#975)', () => {
    expect(wf).toMatch(/concurrency:/);
    expect(wf).toMatch(/cancel-in-progress:\s*true/);
  });

  it('falls back to the previously pushed :latest as a layer cache source (#966)', () => {
    expect(wf).toMatch(/cache-from:/);
    expect(wf).toMatch(/type=gha/);
    expect(wf).toMatch(/type=registry,ref=/);
    expect(wf).toMatch(/:latest/);
  });

  it('interpolates the requested platforms', () => {
    expect(wf).toContain('platforms: linux/amd64');
  });
});

// ── #968: build-status poll backoff ──────────────────────────────────────────

describe('image-build-service: nextBuildPollDelayMs backoff (#968)', () => {
  it('returns the base delay on the first poll', () => {
    expect(nextBuildPollDelayMs(0)).toBe(15_000);
  });

  it('grows geometrically with attempts', () => {
    expect(nextBuildPollDelayMs(1)).toBe(Math.round(15_000 * 1.5));
    expect(nextBuildPollDelayMs(2)).toBe(Math.round(15_000 * 1.5 * 1.5));
    expect(nextBuildPollDelayMs(2)).toBeGreaterThan(nextBuildPollDelayMs(1));
  });

  it('caps at the max delay (60s) for large attempt counts', () => {
    expect(nextBuildPollDelayMs(50)).toBe(60_000);
  });

  it('never exceeds the cap and is always >= base', () => {
    for (let a = 0; a < 30; a++) {
      const d = nextBuildPollDelayMs(a);
      expect(d).toBeLessThanOrEqual(60_000);
      expect(d).toBeGreaterThanOrEqual(15_000);
    }
  });
});
