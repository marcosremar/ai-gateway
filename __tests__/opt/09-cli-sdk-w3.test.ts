/**
 * Optimization suite 09 — CLI / SDK / DX — WAVE 3.
 *
 * Third batch of localized, low-risk fixes from docs/optimizations/09-cli-sdk-dx.md
 * NOT covered by waves 1-2. All backed by pure helpers in `cli/cli-helpers.ts` and
 * `src/sdk/client.ts` so they unit-test without importing `bin/ai-gateway.ts`
 * (which runs `main()` at module load).
 *
 *   CLI helpers (cli/cli-helpers.ts):
 *     - #801  global --json flag + stable JSON output      (hasJsonFlag, jsonOutput)
 *     - #803  per-subcommand --help / -h detection          (hasHelpFlag)
 *     - #811  group gpu subcommands by lifecycle            (groupGpuSubcommands)
 *     - #846  spot / interruptible savings %                (computeSpotSavings)
 *     - #847  per-request cost estimate                     (estimateChatCostUsd)
 *     - #855  config/whoami --json payload                  (buildConfigJson)
 *     - #856  gateway URL env precedence + provenance       (resolveGatewayUrlFromEnv)
 *     - #859  .env walk-up discovery description            (describeEnvDiscovery)
 *     - #860  warn when no key on a remote gateway          (needsApiKeyWarning, isLocalGatewayUrl)
 *
 *   SDK (src/sdk/client.ts + types.ts):
 *     - #824  GatewaySDK.fromEnv() / env baseUrl discovery  (fromEnv, resolveBaseUrlFromEnv)
 *     - #828  per-stage PipelineTiming (stt/llm/tts ms)     (pipeline timing parse)
 *     - #830  awaitable, idempotent close()                 (close, isClosed)
 *     - #837  X-Request-ID generation + lastRequestId()     (generateRequestId, header)
 *     - #838  parse Prometheus metrics → typed JSON         (parseMetrics, metricsJson)
 *     - #885  exported retryable-error predicate            (isRetryableNetworkError)
 *
 * Unit-only — no network. `fetch` is mocked for the live SDK tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  hasJsonFlag,
  jsonOutput,
  hasHelpFlag,
  groupGpuSubcommands,
  computeSpotSavings,
  estimateChatCostUsd,
  buildConfigJson,
  resolveGatewayUrlFromEnv,
  describeEnvDiscovery,
  ENV_WALK_UP_LEVELS,
  needsApiKeyWarning,
  isLocalGatewayUrl,
} from '../../cli/cli-helpers';
import {
  GatewaySDK,
  resolveBaseUrlFromEnv,
  parseMetrics,
  generateRequestId,
  isRetryableNetworkError,
} from '../../src/sdk/client';

// ── #801: global --json flag + output ─────────────────────────────────────────

describe('hasJsonFlag (#801)', () => {
  it('detects --json anywhere in argv', () => {
    expect(hasJsonFlag(['gpu', 'status', '--json'])).toBe(true);
    expect(hasJsonFlag(['--json', 'balance'])).toBe(true);
  });
  it('returns false when absent', () => {
    expect(hasJsonFlag(['gpu', 'status'])).toBe(false);
    expect(hasJsonFlag([])).toBe(false);
  });
});

describe('jsonOutput (#801)', () => {
  it('pretty-prints with 2-space indentation', () => {
    expect(jsonOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it('normalises top-level undefined to null', () => {
    expect(jsonOutput(undefined)).toBe('null');
  });
  it('round-trips back to the original value', () => {
    const v = { url: 'http://x', n: 3, nested: { ok: true } };
    expect(JSON.parse(jsonOutput(v))).toEqual(v);
  });
});

// ── #803: per-subcommand --help / -h ──────────────────────────────────────────

describe('hasHelpFlag (#803)', () => {
  it('detects --help and -h', () => {
    expect(hasHelpFlag(['balance', '--help'])).toBe(true);
    expect(hasHelpFlag(['config', '-h'])).toBe(true);
  });
  it('returns false for a normal invocation', () => {
    expect(hasHelpFlag(['whoami'])).toBe(false);
    expect(hasHelpFlag(['ping', '5'])).toBe(false);
  });
});

// ── #811: group gpu subcommands by lifecycle ──────────────────────────────────

describe('groupGpuSubcommands (#811)', () => {
  it('buckets known subcommands into the right groups', () => {
    const g = groupGpuSubcommands(['status', 'deploy', 'offers', 'ssh', 'readiness']);
    expect(g.Lifecycle).toEqual(['status', 'deploy']);
    expect(g.Cost).toEqual(['offers']);
    expect(g.Dev).toEqual(['ssh']);
    expect(g.Advanced).toEqual(['readiness']); // unknown → Advanced, not dropped
  });
  it('keeps every input command somewhere (nothing dropped)', () => {
    const input = ['status', 'list', 'offers', 'best', 'patch', 'finetune', 'jobs', 'snapshot'];
    const g = groupGpuSubcommands(input);
    const flat = [...g.Lifecycle, ...g.Cost, ...g.Dev, ...g.Advanced].sort();
    expect(flat).toEqual([...input].sort());
  });
});

// ── #846: spot / interruptible savings ────────────────────────────────────────

describe('computeSpotSavings (#846)', () => {
  it('computes the % savings when spot is cheaper', () => {
    const r = computeSpotSavings(1.0, 0.6);
    expect(r).not.toBeNull();
    expect(r!.savingsPct).toBe(40);
    expect(r!.spotPerHr).toBe(0.6);
  });
  it('returns null when spot is missing/zero or not cheaper', () => {
    expect(computeSpotSavings(1.0, 0)).toBeNull();
    expect(computeSpotSavings(1.0, undefined)).toBeNull();
    expect(computeSpotSavings(1.0, 1.2)).toBeNull(); // spot pricier → ignore
    expect(computeSpotSavings(undefined, 0.5)).toBeNull();
  });
});

// ── #847: per-request cost estimate ───────────────────────────────────────────

describe('estimateChatCostUsd (#847)', () => {
  it('multiplies token usage by per-1M pricing', () => {
    // 1000 in @ $5/1M + 500 out @ $15/1M = 0.005 + 0.0075 = 0.0125
    const cost = estimateChatCostUsd(
      { promptTokens: 1000, completionTokens: 500 },
      { input: 5, output: 15 },
    );
    expect(cost).toBeCloseTo(0.0125, 6);
  });
  it('returns null when usage or pricing is unavailable', () => {
    expect(estimateChatCostUsd(undefined, { input: 5, output: 15 })).toBeNull();
    expect(estimateChatCostUsd({ promptTokens: 10 }, undefined)).toBeNull();
    expect(estimateChatCostUsd({ promptTokens: 10, completionTokens: 5 }, {})).toBeNull();
  });
  it('counts only the side with a known rate', () => {
    // output rate only → input contributes 0
    const cost = estimateChatCostUsd({ promptTokens: 1000, completionTokens: 1000 }, { output: 10 });
    expect(cost).toBeCloseTo(0.01, 6);
  });
});

// ── #855: config / whoami --json payload ──────────────────────────────────────

describe('buildConfigJson (#855)', () => {
  it('builds a structured identity/connectivity payload', () => {
    const o = buildConfigJson({
      url: 'http://localhost:4000',
      urlSource: 'PORT',
      keySource: 'AIGW_APP_KEY',
      keyMasked: 'sk-12345…cdef',
      connected: true,
      userId: 'alice',
    });
    expect(o).toEqual({
      url: 'http://localhost:4000',
      urlSource: 'PORT',
      keySource: 'AIGW_APP_KEY',
      key: 'sk-12345…cdef',
      connected: true,
      userId: 'alice',
    });
  });
  it('omits userId when not provided and defaults urlSource/connected', () => {
    const o = buildConfigJson({ url: 'http://x', keySource: 'none', keyMasked: '(not set)' });
    expect(o.userId).toBeUndefined();
    expect(o.urlSource).toBe('default');
    expect(o.connected).toBe(false);
  });
});

// ── #856: gateway URL env precedence + provenance ─────────────────────────────

describe('resolveGatewayUrlFromEnv (#856)', () => {
  it('prefers AI_GATEWAY_URL over GATEWAY_URL and PORT', () => {
    expect(resolveGatewayUrlFromEnv({ AI_GATEWAY_URL: 'http://a', GATEWAY_URL: 'http://b', PORT: '9000' }))
      .toEqual({ url: 'http://a', source: 'AI_GATEWAY_URL' });
  });
  it('falls back to GATEWAY_URL, then PORT', () => {
    expect(resolveGatewayUrlFromEnv({ GATEWAY_URL: 'http://b' })).toEqual({ url: 'http://b', source: 'GATEWAY_URL' });
    expect(resolveGatewayUrlFromEnv({ PORT: '9012' })).toEqual({ url: 'http://localhost:9012', source: 'PORT' });
  });
  it('uses the default when nothing is set or PORT is non-numeric', () => {
    expect(resolveGatewayUrlFromEnv({})).toEqual({ url: 'http://localhost:4000', source: 'default' });
    expect(resolveGatewayUrlFromEnv({ PORT: 'abc' })).toEqual({ url: 'http://localhost:4000', source: 'default' });
  });
});

// ── #859: .env walk-up discovery description ──────────────────────────────────

describe('describeEnvDiscovery (#859)', () => {
  it('names a found .env path', () => {
    expect(describeEnvDiscovery('/repo/.env')).toBe('Loaded .env from /repo/.env');
  });
  it('states the search depth when none found', () => {
    const msg = describeEnvDiscovery();
    expect(msg).toContain(String(ENV_WALK_UP_LEVELS));
    expect(msg).toContain('parent');
  });
});

// ── #860: warn when no API key on a remote gateway ────────────────────────────

describe('needsApiKeyWarning (#860)', () => {
  it('warns for a remote gateway with no key', () => {
    expect(needsApiKeyWarning({ key: '', isLocal: false })).toBe(true);
  });
  it('does NOT warn for localhost, or when a key is set', () => {
    expect(needsApiKeyWarning({ key: '', isLocal: true })).toBe(false);
    expect(needsApiKeyWarning({ key: 'k', isLocal: false })).toBe(false);
  });
});

describe('isLocalGatewayUrl (#860)', () => {
  it('recognises localhost / 127.0.0.1 / ::1', () => {
    expect(isLocalGatewayUrl('http://localhost:4000')).toBe(true);
    expect(isLocalGatewayUrl('http://127.0.0.1:9000')).toBe(true);
    expect(isLocalGatewayUrl('http://[::1]:4000')).toBe(true);
  });
  it('treats remote / malformed URLs as non-local', () => {
    expect(isLocalGatewayUrl('https://gw.example.com')).toBe(false);
    expect(isLocalGatewayUrl('not a url')).toBe(false);
  });
});

// ── #824: SDK env baseUrl discovery + fromEnv ─────────────────────────────────

describe('resolveBaseUrlFromEnv (#824)', () => {
  it('mirrors the CLI precedence', () => {
    expect(resolveBaseUrlFromEnv({ AI_GATEWAY_URL: 'http://a' })).toBe('http://a');
    expect(resolveBaseUrlFromEnv({ GATEWAY_URL: 'http://b' })).toBe('http://b');
    expect(resolveBaseUrlFromEnv({ PORT: '9012' })).toBe('http://localhost:9012');
    expect(resolveBaseUrlFromEnv({})).toBe('http://localhost:4000');
  });
});

describe('GatewaySDK.fromEnv (#824)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('constructs zero-config from the environment', () => {
    delete process.env.AI_GATEWAY_URL;
    delete process.env.GATEWAY_URL;
    process.env.PORT = '9999';
    const gw = GatewaySDK.fromEnv();
    expect(gw).toBeInstanceOf(GatewaySDK);
  });
  it('lets an explicit override win over env discovery', () => {
    process.env.AI_GATEWAY_URL = 'http://from-env:1';
    const gw = GatewaySDK.fromEnv({ baseUrl: 'http://override:2' });
    expect(gw).toBeInstanceOf(GatewaySDK);
    // The override is used (no throw on a valid URL); a deeper assertion lives in
    // the live-fetch test below where we observe the requested URL.
  });
});

// ── #885: exported retryable-error predicate ──────────────────────────────────

describe('isRetryableNetworkError (#885)', () => {
  it('treats connection-level failures as retryable', () => {
    expect(isRetryableNetworkError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableNetworkError(new Error('ECONNREFUSED 127.0.0.1:4000'))).toBe(true);
    expect(isRetryableNetworkError(new Error('getaddrinfo ENOTFOUND host'))).toBe(true);
  });
  it('does NOT retry timeouts or generic HTTP errors', () => {
    const abort = new DOMException('aborted', 'AbortError');
    expect(isRetryableNetworkError(abort)).toBe(false);
    expect(isRetryableNetworkError(new Error('HTTP 500: boom'))).toBe(false);
  });
});

// ── #838: parse Prometheus metrics → typed JSON ───────────────────────────────

describe('parseMetrics (#838)', () => {
  it('parses bare and labelled samples, skipping comments', () => {
    const text = [
      '# HELP gw_requests_total Total requests',
      '# TYPE gw_requests_total counter',
      'gw_requests_total 42',
      'gw_latency_ms{stage="stt",provider="groq"} 123.5',
      '',
      'gw_up 1',
    ].join('\n');
    const samples = parseMetrics(text);
    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual({ name: 'gw_requests_total', labels: {}, value: 42 });
    expect(samples[1]).toEqual({ name: 'gw_latency_ms', labels: { stage: 'stt', provider: 'groq' }, value: 123.5 });
    expect(samples[2].name).toBe('gw_up');
  });
  it('handles +Inf / NaN values and skips garbage lines', () => {
    const samples = parseMetrics('gw_max +Inf\ngarbage line here\ngw_nan NaN');
    expect(samples.find(s => s.name === 'gw_max')!.value).toBe(Infinity);
    expect(Number.isNaN(samples.find(s => s.name === 'gw_nan')!.value)).toBe(true);
    expect(samples.find(s => s.name === 'garbage')).toBeUndefined();
  });
});

// ── #837: request-id generation ───────────────────────────────────────────────

describe('generateRequestId (#837)', () => {
  it('produces a non-empty unique id each call', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).toBeTruthy();
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
  });
});

// ── Live SDK behaviour (mocked fetch): #837 / #828 / #830 / #824 ──────────────

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('GatewaySDK live behaviour (mocked fetch)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#837 sends an X-Request-ID header and exposes lastRequestId()', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ voices: [] }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    expect(gw.lastRequestId()).toBeUndefined();
    await gw.listVoices();
    const [, init] = fetchMock.mock.calls[0];
    const sentId = (init.headers as Record<string, string>)['X-Request-ID'];
    expect(sentId).toBeTruthy();
    expect(gw.lastRequestId()).toBe(sentId);
  });

  it('#837 request-id emission can be disabled via config', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ voices: [] }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000', requestId: false });
    await gw.listVoices();
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['X-Request-ID']).toBeUndefined();
    expect(gw.lastRequestId()).toBeUndefined();
  });

  it('#828 surfaces per-stage pipeline timings', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      transcription: 'bonjour',
      response: 'hello',
      audio_base64: '',
      content_type: 'audio/wav',
      timing: { total_ms: 900, used_gpu: true, stt_ms: 200, llm_ms: 300, tts_ms: 400 },
    }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const r = await gw.pipeline(new Uint8Array([1, 2, 3]));
    expect(r.timing.totalMs).toBe(900);
    expect(r.timing.sttMs).toBe(200);
    expect(r.timing.llmMs).toBe(300);
    expect(r.timing.ttsMs).toBe(400);
    expect(r.timing.usedGpu).toBe(true);
  });

  it('#828 leaves per-stage fields undefined when the gateway omits them', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      transcription: 't', response: 'r', audio_base64: '', content_type: 'audio/wav',
      timing: { total_ms: 100, used_gpu: false },
    }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const r = await gw.pipeline(new Uint8Array([0]));
    expect(r.timing.sttMs).toBeUndefined();
    expect(r.timing.llmMs).toBeUndefined();
  });

  it('#830 close() is awaitable and idempotent', async () => {
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    expect(gw.isClosed()).toBe(false);
    await gw.close();
    await gw.close(); // idempotent — no throw
    expect(gw.isClosed()).toBe(true);
  });

  it('#824 fromEnv override targets the override URL', async () => {
    const savedUrl = process.env.AI_GATEWAY_URL;
    process.env.AI_GATEWAY_URL = 'http://from-env:1';
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ voices: [] }));
      const gw = GatewaySDK.fromEnv({ baseUrl: 'http://override:2' });
      await gw.listVoices();
      const [calledUrl] = fetchMock.mock.calls[0];
      expect(String(calledUrl)).toContain('http://override:2');
    } finally {
      if (savedUrl === undefined) delete process.env.AI_GATEWAY_URL;
      else process.env.AI_GATEWAY_URL = savedUrl;
    }
  });

  it('#838 metricsJson() parses the /metrics text response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('gw_up 1\ngw_lat{stage="llm"} 12', { status: 200 }),
    );
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    const samples = await gw.metricsJson();
    expect(samples).toHaveLength(2);
    expect(samples[1]).toEqual({ name: 'gw_lat', labels: { stage: 'llm' }, value: 12 });
  });
});
