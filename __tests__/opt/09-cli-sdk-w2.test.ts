/**
 * Optimization suite 09 — CLI / SDK / DX — WAVE 2.
 *
 * Continuation of `09-cli-sdk.test.ts`. Covers a second batch of localized,
 * low-risk fixes from docs/optimizations/09-cli-sdk-dx.md NOT already done in
 * wave 1, all backed by pure helpers in `cli/cli-helpers.ts` / `src/sdk/`:
 *
 *   - #804  top-level --version / -v / -h dispatch        (parseTopLevelFlag)
 *   - #806  unknown / misspelled flag detection           (detectUnknownFlags)
 *   - #809/#852  gpu offers --sort                         (parseOffersSort, sortOffers)
 *   - #843  aggregate burn rate footer                     (sumBurnRate)
 *   - #854/#863  API-key source provenance + masking       (resolveKeySource, maskKey)
 *   - #857  whoami identity parsing                         (parseUserIdentity)
 *   - #858  gateway URL validation                          (validateGatewayUrl)
 *   - #898/#826  structured HTTP error parsing (CLI)        (parseHttpError, formatHttpError)
 *   - #816  overwrite guard for binary-output commands      (overwriteDecision)
 *   - #817  client-side upload size validation              (validateUploadSize)
 *   - #896  `--` separator for verbatim chat messages       (chatMessageArgsWithSeparator)
 *   - #845  configurable low-balance threshold              (resolveLowBalanceThreshold)
 *   - #815  `-o -` stdout target detection                  (isStdoutTarget)
 *   - #802/#818  quiet / NO_COLOR decorative suppression    (shouldSuppressDecorative)
 *   - #826  SDK GatewayError carries code/retryable         (parseGatewayErrorBody + live SDK)
 *   - #836  waitForGpu poll-param validation                (validatePollOptions)
 *   - #829  waitForGpu early-idle grace window              (classifyGpuPollState)
 *
 * Unit-only — no network. `fetch` is mocked for the SDK tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseTopLevelFlag,
  detectUnknownFlags,
  parseOffersSort,
  sortOffers,
  sumBurnRate,
  resolveKeySource,
  maskKey,
  parseUserIdentity,
  validateGatewayUrl,
  parseHttpError,
  formatHttpError,
  overwriteDecision,
  validateUploadSize,
  MAX_AUDIO_UPLOAD_BYTES,
  chatMessageArgsWithSeparator,
  resolveLowBalanceThreshold,
  DEFAULT_LOW_BALANCE_USD,
  isStdoutTarget,
  shouldSuppressDecorative,
} from '../../cli/cli-helpers';
import {
  GatewaySDK,
  parseGatewayErrorBody,
  validatePollOptions,
  classifyGpuPollState,
} from '../../src/sdk/client';
import { GatewayError } from '../../src/sdk/types';

// ── #804: top-level --version / -v / -h ───────────────────────────────────────

describe('parseTopLevelFlag (#804)', () => {
  it('recognizes --version / -v / -V as a first token', () => {
    expect(parseTopLevelFlag(['--version'])).toBe('version');
    expect(parseTopLevelFlag(['-v'])).toBe('version');
    expect(parseTopLevelFlag(['-V'])).toBe('version');
  });

  it('recognizes --help / -h as a first token', () => {
    expect(parseTopLevelFlag(['--help'])).toBe('help');
    expect(parseTopLevelFlag(['-h'])).toBe('help');
  });

  it('does NOT treat -v on a real command (tts -v voice) as version', () => {
    // -v is only version when it is args[0]; here it's args[1] of `tts`.
    expect(parseTopLevelFlag(['tts', '-v', 'Ryan'])).toBeUndefined();
    expect(parseTopLevelFlag(['chat', 'hi'])).toBeUndefined();
  });

  it('returns undefined for empty argv', () => {
    expect(parseTopLevelFlag([])).toBeUndefined();
  });
});

// ── #806: unknown flag detection ──────────────────────────────────────────────

describe('detectUnknownFlags (#806)', () => {
  const known = new Set(['-m', '--model', '--max-tokens', '--no-stream']);

  it('returns no unknowns when all flags are recognized', () => {
    const r = detectUnknownFlags(['hi', '-m', 'gpt', '--no-stream'], known);
    expect(r.unknown).toEqual([]);
    expect(r.suggestion).toBeUndefined();
  });

  it('collects an unknown flag and suggests the closest known one', () => {
    const r = detectUnknownFlags(['--maxtokens', '5'], known);
    expect(r.unknown).toEqual(['--maxtokens']);
    expect(r.suggestion).toBe('--max-tokens');
  });

  it('ignores negative numbers (values, not flags)', () => {
    const r = detectUnknownFlags(['-5', '--model', 'm'], known);
    expect(r.unknown).toEqual([]);
  });

  it('strips inline =value before matching', () => {
    expect(detectUnknownFlags(['--model=gpt'], known).unknown).toEqual([]);
    expect(detectUnknownFlags(['--modl=gpt'], known).unknown).toEqual(['--modl']);
  });

  it('ignores lone - and -- separators', () => {
    expect(detectUnknownFlags(['-', '--', 'msg'], known).unknown).toEqual([]);
  });
});

// ── #809 / #852: gpu offers --sort ────────────────────────────────────────────

describe('parseOffersSort + sortOffers (#852)', () => {
  it('defaults to price when absent', () => {
    expect(parseOffersSort(undefined)).toEqual({ value: 'price' });
  });

  it('accepts price | vram | score case-insensitively', () => {
    expect(parseOffersSort('VRAM')).toEqual({ value: 'vram' });
    expect(parseOffersSort('score')).toEqual({ value: 'score' });
  });

  it('rejects an unknown sort key', () => {
    const r = parseOffersSort('latency');
    expect('error' in r && r.error).toContain('price|vram|score');
  });

  const offers = [
    { id: 'a', pricePerHr: 0.5, vramGb: 24, score: 10 },
    { id: 'b', pricePerHr: 0.2, vramGb: 48, score: 30 },
    { id: 'c', pricePerHr: 0.9, vramGb: 16, score: 20 },
  ];

  it('sorts price ascending (cheapest first)', () => {
    expect(sortOffers(offers, 'price').map(o => o.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts vram descending (most VRAM first)', () => {
    expect(sortOffers(offers, 'vram').map(o => o.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts score descending and does not mutate input', () => {
    const copy = [...offers];
    expect(sortOffers(offers, 'score').map(o => o.id)).toEqual(['b', 'c', 'a']);
    expect(offers).toEqual(copy); // not mutated
  });
});

// ── #843: aggregate burn rate ─────────────────────────────────────────────────

describe('sumBurnRate (#843)', () => {
  it('sums costPerHr across instances, ignoring missing/invalid', () => {
    const r = sumBurnRate([
      { costPerHr: 0.5 },
      { costPerHr: '0.25' as unknown as number }, // numeric string coerced
      { costPerHr: undefined },
      { costPerHr: 0 }, // zero ignored
      {},
    ]);
    expect(r.totalPerHr).toBeCloseTo(0.75, 6);
    expect(r.counted).toBe(2);
  });

  it('returns zero/zero for an empty list', () => {
    expect(sumBurnRate([])).toEqual({ totalPerHr: 0, counted: 0 });
  });
});

// ── #854 / #863: key source provenance + masking ──────────────────────────────

describe('resolveKeySource (#854)', () => {
  it('prefers AIGW_APP_KEY over older names', () => {
    const r = resolveKeySource({ AIGW_APP_KEY: 'app', AI_GATEWAY_KEY: 'old', GATEWAY_API_KEY: 'older' });
    expect(r).toEqual({ key: 'app', source: 'AIGW_APP_KEY' });
  });

  it('falls through the precedence chain', () => {
    expect(resolveKeySource({ GATEWAY_API_KEY: 'k' })).toEqual({ key: 'k', source: 'GATEWAY_API_KEY' });
  });

  it('extracts the first key from the GATEWAY_API_KEYS multi-key format', () => {
    const r = resolveKeySource({ GATEWAY_API_KEYS: 'abc123:alice,def456:bob' });
    expect(r).toEqual({ key: 'abc123', source: 'GATEWAY_API_KEYS' });
  });

  it('returns source "none" when nothing is set', () => {
    expect(resolveKeySource({})).toEqual({ key: '', source: 'none' });
  });
});

describe('maskKey (#854)', () => {
  it('masks a long key as prefix…suffix', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-12345…cdef');
  });

  it('returns (not set) for empty', () => {
    expect(maskKey('')).toBe('(not set)');
  });
});

// ── #857: whoami identity parsing ─────────────────────────────────────────────

describe('parseUserIdentity (#857)', () => {
  it('parses key:user:label', () => {
    const r = parseUserIdentity('secretkey123:alice:my-laptop');
    expect(r.user).toBe('alice');
    expect(r.label).toBe('my-laptop');
    expect(r.keyHint).toBe('secretke…');
  });

  it('defaults user when the key has no colon', () => {
    const r = parseUserIdentity('plainkey0000');
    expect(r.user).toBe('default');
    expect(r.label).toBeUndefined();
  });
});

// ── #858: gateway URL validation ──────────────────────────────────────────────

describe('validateGatewayUrl (#858)', () => {
  it('accepts and trims a valid http(s) URL', () => {
    expect(validateGatewayUrl('http://localhost:4000/')).toEqual({ value: 'http://localhost:4000' });
  });

  it('rejects a non-http scheme / malformed URL', () => {
    expect('error' in validateGatewayUrl('localhost:4000')).toBe(true);
    expect('error' in validateGatewayUrl('ftp://x')).toBe(true);
  });

  it('rejects empty', () => {
    expect('error' in validateGatewayUrl(undefined)).toBe(true);
    expect('error' in validateGatewayUrl('   ')).toBe(true);
  });
});

// ── #898 / #826: structured HTTP error parsing (CLI) ──────────────────────────

describe('parseHttpError + formatHttpError (#898)', () => {
  it('extracts code + retryable from a structured body', () => {
    const body = JSON.stringify({ error: 'ProviderError', code: 'CREDIT_EXHAUSTED', message: 'no credits', retryable: false });
    const p = parseHttpError(402, body);
    expect(p.code).toBe('CREDIT_EXHAUSTED');
    expect(p.retryable).toBe(false);
    expect(formatHttpError(p)).toBe('CREDIT_EXHAUSTED: no credits (not retryable)');
  });

  it('handles a nested { error: { code } } shape', () => {
    const body = JSON.stringify({ error: { code: 'PROVIDER_TIMEOUT', message: 'slow', retryable: true } });
    const p = parseHttpError(504, body);
    expect(p.code).toBe('PROVIDER_TIMEOUT');
    expect(formatHttpError(p)).toContain('(retryable)');
  });

  it('falls back to raw text for non-JSON bodies', () => {
    const p = parseHttpError(500, 'Internal Server Error');
    expect(p.code).toBeUndefined();
    expect(p.message).toContain('500');
    expect(formatHttpError(p)).toBe(p.message);
  });
});

// ── #816: overwrite guard ─────────────────────────────────────────────────────

describe('overwriteDecision (#816)', () => {
  it('allows writing when the file does not exist', () => {
    expect(overwriteDecision({ exists: false })).toBe('ok');
  });

  it('blocks clobbering a default path without --force', () => {
    expect(overwriteDecision({ exists: true, isDefaultPath: true })).toBe('block');
  });

  it('warns (not blocks) for a user-specified path, and for --force', () => {
    expect(overwriteDecision({ exists: true, isDefaultPath: false })).toBe('warn');
    expect(overwriteDecision({ exists: true, isDefaultPath: true, force: true })).toBe('warn');
  });
});

// ── #817: upload size validation ──────────────────────────────────────────────

describe('validateUploadSize (#817)', () => {
  it('accepts a file within the limit', () => {
    expect(validateUploadSize(1024)).toEqual({ ok: true });
  });

  it('rejects an empty file', () => {
    const r = validateUploadSize(0);
    expect(r.ok).toBe(false);
  });

  it('rejects a file over the cap', () => {
    const r = validateUploadSize(MAX_AUDIO_UPLOAD_BYTES + 1);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('max');
  });
});

// ── #896: `--` separator for verbatim chat messages ───────────────────────────

describe('chatMessageArgsWithSeparator (#896)', () => {
  const valued = new Set(['-m', '--model', '--max-tokens']);

  it('drops flags before -- (existing behavior)', () => {
    expect(chatMessageArgsWithSeparator(['chat', '-m', 'gpt', 'hello', 'world'], valued)).toEqual(['hello', 'world']);
  });

  it('preserves a verbatim message after -- (leading dash kept)', () => {
    expect(chatMessageArgsWithSeparator(['chat', '--', '-5', 'degrees'], valued)).toEqual(['-5', 'degrees']);
  });

  it('combines pre- and post-separator tokens', () => {
    expect(chatMessageArgsWithSeparator(['chat', '-m', 'gpt', 'pre', '--', '-x', 'post'], valued)).toEqual(['pre', '-x', 'post']);
  });
});

// ── #845: low-balance threshold ───────────────────────────────────────────────

describe('resolveLowBalanceThreshold (#845)', () => {
  it('defaults when unset', () => {
    expect(resolveLowBalanceThreshold(undefined)).toBe(DEFAULT_LOW_BALANCE_USD);
  });

  it('honors a valid override', () => {
    expect(resolveLowBalanceThreshold('20')).toBe(20);
  });

  it('ignores non-numeric / non-positive values', () => {
    expect(resolveLowBalanceThreshold('lots')).toBe(DEFAULT_LOW_BALANCE_USD);
    expect(resolveLowBalanceThreshold('0')).toBe(DEFAULT_LOW_BALANCE_USD);
    expect(resolveLowBalanceThreshold('-3')).toBe(DEFAULT_LOW_BALANCE_USD);
  });
});

// ── #815 / #802 / #818: small output helpers ──────────────────────────────────

describe('isStdoutTarget (#815)', () => {
  it('treats "-" as stdout', () => {
    expect(isStdoutTarget('-')).toBe(true);
  });
  it('treats a real path / undefined as a file', () => {
    expect(isStdoutTarget('out.wav')).toBe(false);
    expect(isStdoutTarget(undefined)).toBe(false);
  });
});

describe('shouldSuppressDecorative (#802/#818)', () => {
  it('suppresses on --quiet, NO_COLOR, or non-TTY', () => {
    expect(shouldSuppressDecorative({ quiet: true })).toBe(true);
    expect(shouldSuppressDecorative({ noColor: true })).toBe(true);
    expect(shouldSuppressDecorative({ isTTY: false })).toBe(true);
  });
  it('does not suppress for an interactive TTY with no flags', () => {
    expect(shouldSuppressDecorative({ isTTY: true })).toBe(false);
    expect(shouldSuppressDecorative({})).toBe(false);
  });
});

// ── #826: SDK structured error parsing (pure + live) ──────────────────────────

describe('parseGatewayErrorBody (#826)', () => {
  it('pulls code + retryable from a flat body', () => {
    expect(parseGatewayErrorBody(JSON.stringify({ code: 'GPU_NOT_READY', retryable: true, message: 'booting' })))
      .toEqual({ code: 'GPU_NOT_READY', retryable: true, message: 'booting' });
  });

  it('returns {} for non-JSON', () => {
    expect(parseGatewayErrorBody('not json')).toEqual({});
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('GatewaySDK surfaces structured error code on GatewayError (#826)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('attaches code/retryable parsed from the error body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'ProviderError', code: 'CREDIT_EXHAUSTED', message: 'no credits', retryable: false }, 402),
    );
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000', retryBackoffMs: [1] });
    try {
      await gw.listVoices();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      const ge = err as GatewayError;
      expect(ge.code).toBe('CREDIT_EXHAUSTED');
      expect(ge.retryable).toBe(false);
      expect(ge.statusCode).toBe(402);
    }
  });
});

// ── #836: waitForGpu poll-param validation ────────────────────────────────────

describe('validatePollOptions (#836)', () => {
  it('passes through valid values', () => {
    expect(validatePollOptions(1000, 60_000)).toEqual({ pollIntervalMs: 1000, timeoutMs: 60_000 });
  });

  it('clamps a 0 / negative interval to the default (no busy-loop)', () => {
    expect(validatePollOptions(0, 60_000).pollIntervalMs).toBe(5_000);
    expect(validatePollOptions(-5, 60_000).pollIntervalMs).toBe(5_000);
  });

  it('clamps a non-finite timeout to the default', () => {
    expect(validatePollOptions(1000, Number.NaN).timeoutMs).toBe(20 * 60_000);
    expect(validatePollOptions(1000, Infinity).timeoutMs).toBe(20 * 60_000);
  });
});

// ── #829: waitForGpu early-idle grace window ──────────────────────────────────

describe('classifyGpuPollState (#829)', () => {
  it('returns ready/error immediately', () => {
    expect(classifyGpuPollState('ready', 1)).toBe('ready');
    expect(classifyGpuPollState('error', 1)).toBe('error');
  });

  it('treats an early idle as transient (within grace window)', () => {
    expect(classifyGpuPollState('idle', 1)).toBe('wait');
    expect(classifyGpuPollState('idle', 2)).toBe('wait');
  });

  it('treats a persistent idle (past grace) as cancelled', () => {
    expect(classifyGpuPollState('idle', 3)).toBe('cancelled');
  });

  it('keeps waiting for in-progress statuses', () => {
    for (const s of ['creating', 'booting', 'installing', 'searching', 'queued', 'whatever']) {
      expect(classifyGpuPollState(s, 5)).toBe('wait');
    }
  });
});
