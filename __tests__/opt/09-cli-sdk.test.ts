/**
 * Optimization suite 09 — CLI / SDK / DX.
 *
 * Covers the localized fixes implemented from docs/optimizations/09-cli-sdk-dx.md:
 *   - #662/#663/#664  bounded ChatMessage/ChatCompletion schemas (src/contracts)
 *   - #827            maxCostUsd passthrough on GatewaySDK.deployGpu (src/sdk)
 *   - #833            per-instance retry/backoff config on GatewaySDK (src/sdk)
 *   - #805/#807/#808/#842  CLI numeric-flag validation, exit codes, safe getArg,
 *                          and --max-cost-usd parsing (cli/cli-helpers.ts)
 *
 * Unit-only — no network. `fetch` is mocked for SDK tests; timers are real but
 * retry backoff is set to 0/tiny so the suite stays fast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  ChatMessageSchema,
  ChatCompletionRequestSchema,
  MAX_CHAT_CONTENT_CHARS,
  MAX_CHAT_MESSAGES,
  MAX_COMPLETION_TOKENS,
} from '../../src/contracts';
import { GatewaySDK, GatewayError } from '../../src/sdk';
import {
  validateNumericFlag,
  parseMaxCostUsd,
  getArgSafe,
  classifyExitCode,
  UsageError,
  EXIT_USAGE,
  EXIT_RUNTIME,
} from '../../cli/cli-helpers';

// ── Contracts: bounded chat schemas (#662/#663/#664) ─────────────────────────

describe('contracts: ChatMessageSchema content bound (#662)', () => {
  it('accepts content up to the limit', () => {
    const ok = ChatMessageSchema.safeParse({ role: 'user', content: 'x'.repeat(MAX_CHAT_CONTENT_CHARS) });
    expect(ok.success).toBe(true);
  });

  it('rejects content exceeding the limit', () => {
    const bad = ChatMessageSchema.safeParse({ role: 'user', content: 'x'.repeat(MAX_CHAT_CONTENT_CHARS + 1) });
    expect(bad.success).toBe(false);
  });
});

describe('contracts: ChatCompletionRequest messages array bound (#663)', () => {
  const msg = { role: 'user' as const, content: 'hi' };

  it('accepts a normal request', () => {
    const ok = ChatCompletionRequestSchema.safeParse({ model: 'm', messages: [msg] });
    expect(ok.success).toBe(true);
  });

  it('rejects an empty messages array', () => {
    const bad = ChatCompletionRequestSchema.safeParse({ model: 'm', messages: [] });
    expect(bad.success).toBe(false);
  });

  it('rejects more than the max number of messages', () => {
    const tooMany = Array.from({ length: MAX_CHAT_MESSAGES + 1 }, () => msg);
    const bad = ChatCompletionRequestSchema.safeParse({ model: 'm', messages: tooMany });
    expect(bad.success).toBe(false);
  });
});

describe('contracts: ChatCompletionRequest max_tokens bound (#664)', () => {
  const msg = { role: 'user' as const, content: 'hi' };

  it('accepts max_tokens at the limit', () => {
    const ok = ChatCompletionRequestSchema.safeParse({ model: 'm', messages: [msg], max_tokens: MAX_COMPLETION_TOKENS });
    expect(ok.success).toBe(true);
  });

  it('rejects max_tokens above the limit', () => {
    const bad = ChatCompletionRequestSchema.safeParse({ model: 'm', messages: [msg], max_tokens: MAX_COMPLETION_TOKENS + 1 });
    expect(bad.success).toBe(false);
  });

  it('still rejects non-positive max_tokens', () => {
    const bad = ChatCompletionRequestSchema.safeParse({ model: 'm', messages: [msg], max_tokens: 0 });
    expect(bad.success).toBe(false);
  });
});

// ── CLI helpers: numeric validation, exit codes, safe getArg, max-cost ───────

describe('cli-helpers: validateNumericFlag (#805)', () => {
  it('treats a missing value as "not provided" (no error)', () => {
    expect(validateNumericFlag(undefined, '-n')).toEqual({ value: undefined });
  });

  it('rejects a non-numeric value', () => {
    const r = validateNumericFlag('abc', '-n');
    expect(r.value).toBeUndefined();
    expect(r.error).toContain('-n');
  });

  it('rejects an empty string', () => {
    expect(validateNumericFlag('', '-n').error).toBeDefined();
  });

  it('parses a valid integer', () => {
    expect(validateNumericFlag('7', '-n', { integer: true, min: 1 })).toEqual({ value: 7 });
  });

  it('enforces the integer constraint', () => {
    expect(validateNumericFlag('1.5', '-n', { integer: true }).error).toBeDefined();
  });

  it('enforces min/max bounds', () => {
    expect(validateNumericFlag('0', '-n', { min: 1 }).error).toBeDefined();
    expect(validateNumericFlag('100', '-n', { max: 50 }).error).toBeDefined();
  });
});

describe('cli-helpers: parseMaxCostUsd (#842)', () => {
  it('returns undefined when absent', () => {
    expect(parseMaxCostUsd(undefined)).toEqual({ value: undefined });
  });

  it('parses a valid dollar amount', () => {
    expect(parseMaxCostUsd('0.4')).toEqual({ value: 0.4 });
  });

  it('rejects a non-numeric ceiling', () => {
    expect(parseMaxCostUsd('cheap').error).toBeDefined();
  });

  it('rejects a zero / negative ceiling', () => {
    expect(parseMaxCostUsd('0').error).toBeDefined();
    expect(parseMaxCostUsd('-1').error).toBeDefined();
  });
});

describe('cli-helpers: getArgSafe (#808)', () => {
  it('returns the value following a flag', () => {
    expect(getArgSafe(['chat', '-m', 'gpt'], '-m')).toBe('gpt');
  });

  it('returns undefined when the next token is itself a flag', () => {
    expect(getArgSafe(['chat', '-m', '--no-stream'], '-m')).toBeUndefined();
  });

  it('returns undefined when the flag is absent or trailing', () => {
    expect(getArgSafe(['chat'], '-m')).toBeUndefined();
    expect(getArgSafe(['chat', '-m'], '-m')).toBeUndefined();
  });
});

describe('cli-helpers: classifyExitCode (#807)', () => {
  it('maps UsageError to the usage exit code (2)', () => {
    expect(classifyExitCode(new UsageError('bad flag'))).toBe(EXIT_USAGE);
    expect(EXIT_USAGE).toBe(2);
  });

  it('maps any other error to the runtime exit code (1)', () => {
    expect(classifyExitCode(new Error('http 500'))).toBe(EXIT_RUNTIME);
    expect(classifyExitCode('boom')).toBe(EXIT_RUNTIME);
    expect(EXIT_RUNTIME).toBe(1);
  });
});

// ── SDK: deployGpu maxCostUsd passthrough (#827) ─────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GatewaySDK.deployGpu maxCostUsd passthrough (#827)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends maxCostUsd / containerDiskInGb / interruptible in the request body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ deployId: 'd1', status: 'deploying', message: 'ok' }, 202));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });

    const res = await gw.deployGpu({
      apiKey: 'k',
      dockerImage: 'img',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
      maxCostUsd: 0.5,
      containerDiskInGb: 20,
      interruptible: true,
      region: 'US',
    });

    expect(res.deployId).toBe('d1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.maxCostUsd).toBe(0.5);
    expect(body.containerDiskInGb).toBe(20);
    expect(body.interruptible).toBe(true);
    expect(body.region).toBe('US');
  });

  it('omits optional fields when not provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ deployId: 'd2', status: 'deploying', message: 'ok' }, 202));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });

    await gw.deployGpu({ apiKey: 'k', dockerImage: 'img', gpuTypes: ['x'] });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect('maxCostUsd' in body).toBe(false);
    expect('interruptible' in body).toBe(false);
  });

  it('rejects an invalid maxCostUsd before issuing the request', async () => {
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
    await expect(
      gw.deployGpu({ apiKey: 'k', maxCostUsd: -1 }),
    ).rejects.toThrow(/maxCostUsd/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── SDK: configurable retry / backoff (#833) ─────────────────────────────────

describe('GatewaySDK retry config (#833)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries connection-level failures up to the default count', async () => {
    // TypeError = network failure → retryable. Resolve on the 3rd attempt.
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ voices: [] }));

    // Tiny backoff so the test is fast.
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000', retryBackoffMs: [1] });
    const res = await gw.listVoices();
    expect(res.voices).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry when maxRetries is 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000', maxRetries: 0 });

    await expect(gw.listVoices()).rejects.toBeInstanceOf(GatewayError);
    // Exactly one attempt — no retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors a custom maxRetries cap', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000', maxRetries: 2, retryBackoffMs: [1] });

    await expect(gw.listVoices()).rejects.toBeInstanceOf(GatewayError);
    // 1 initial + 2 retries = 3 attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry an HTTP 4xx error', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000', retryBackoffMs: [1] });

    await expect(gw.listVoices()).rejects.toBeInstanceOf(GatewayError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to defaults on invalid retry config', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ voices: [] }));
    // Negative maxRetries and empty backoff array should be ignored.
    const gw = new GatewaySDK({
      baseUrl: 'http://localhost:4000',
      // @ts-expect-error — exercising runtime guard with a bad value
      maxRetries: -5,
      retryBackoffMs: [],
    });
    const res = await gw.listVoices();
    expect(res.voices).toEqual([]);
  });
});
