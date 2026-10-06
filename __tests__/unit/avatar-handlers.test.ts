/**
 * Unit tests for server/avatar-handlers.ts
 *
 * Covers all four HTTP handlers:
 *   handleAvatarSpeak      — validation, no-endpoint 503, audio pass-through,
 *                            TTS generation (GPU + cloud), fetch error 502
 *   handleAvatarAnimateWord— passthrough schema, no-endpoint 503, success/502
 *   handleAvatarMood       — passthrough schema, no-endpoint 503, success/502
 *   handleAvatarStatus     — no-endpoint 200/false, alive 200/true, down 200/false
 *
 * Also verifies getAvatarEndpoint URL-derivation logic (RunPod proxy format,
 * localhost 8085, localhost 8080) through handleAvatarStatus.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Module mocks (hoisted before any imports) ─────────────────────────────────

const mockSynthesize = vi.fn();

vi.mock('../../server/providers', () => ({
  client: { synthesize: (...a: unknown[]) => mockSynthesize(...a) },
  translationDefaults: {},
}));

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── State helpers — use real module, mutate via setters ───────────────────────

import { setBotStateVar, botState, setDeployState, deployState, setGpuHealthy } from '../../server/state';

// ── Test helpers ───────────────────────────────────────────────────────────────

interface FakeRes {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead(code: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function fakeRes(): FakeRes {
  const r: FakeRes = {
    writeHead(code, hdrs) { r.status = code; r.headers = hdrs as Record<string, string>; },
    end(body) { r.body = body; },
  };
  return r;
}

function fakeReq(payload: unknown): IncomingMessage {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  const req = {
    setEncoding: vi.fn(),
    on(event: string, cb: (c: Buffer) => void) {
      if (event === 'data') setTimeout(() => cb(buf), 0);
      else if (event === 'end') setTimeout(() => cb(Buffer.from('')), 1);
    },
  } as unknown as IncomingMessage;
  return req;
}

function fakeReqBadJson(): IncomingMessage {
  const buf = Buffer.from('{bad json{', 'utf8');
  const req = {
    setEncoding: vi.fn(),
    on(event: string, cb: (c: Buffer) => void) {
      if (event === 'data') setTimeout(() => cb(buf), 0);
      else if (event === 'end') setTimeout(() => cb(Buffer.from('')), 1);
    },
  } as unknown as IncomingMessage;
  return req;
}

function jsonBody(res: FakeRes): unknown {
  return JSON.parse(res.body ?? 'null');
}

// ── Import handlers (after mocks) ─────────────────────────────────────────────

import {
  handleAvatarSpeak,
  handleAvatarAnimateWord,
  handleAvatarMood,
  handleAvatarStatus,
} from '../../server/avatar-handlers';

// ── handleAvatarSpeak ─────────────────────────────────────────────────────────

describe('handleAvatarSpeak', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setBotStateVar({ ...botState, endpoint: '' });
    setDeployState({ ...deployState, endpoint: '', status: 'idle' });
    setGpuHealthy(false);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setGpuHealthy(false);
  });

  it('returns 400 on malformed JSON body', async () => {
    const res = fakeRes();
    await handleAvatarSpeak(fakeReqBadJson(), res as unknown as ServerResponse);
    expect(res.status).toBe(400);
  });

  it('returns 400 when text exceeds 4096 characters', async () => {
    setBotStateVar({ ...botState, endpoint: 'https://pod-8080.proxy.runpod.net' });
    const res = fakeRes();
    await handleAvatarSpeak(
      fakeReq({ text: 'x'.repeat(4097) }),
      res as unknown as ServerResponse,
    );
    expect(res.status).toBe(400);
    expect((jsonBody(res) as Record<string, unknown>).error).toBe('Validation failed');
  });

  it('returns 503 when no bot endpoint is set', async () => {
    setBotStateVar({ ...botState, endpoint: '' });
    const res = fakeRes();
    await handleAvatarSpeak(fakeReq({ audio: 'base64data' }), res as unknown as ServerResponse);
    expect(res.status).toBe(503);
    expect(String((jsonBody(res) as Record<string, unknown>).error)).toContain('No bot pod deployed');
  });

  it('passes through pre-generated audio payload to avatar /api/speak', async () => {
    setBotStateVar({ ...botState, endpoint: 'https://mypod-8080.proxy.runpod.net' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const res = fakeRes();
    await handleAvatarSpeak(
      fakeReq({ audio: 'abc123', visemes: [1, 2], vtimes: [0.1] }),
      res as unknown as ServerResponse,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mypod-3099.proxy.runpod.net/api/speak');
    const body = JSON.parse(opts.body as string);
    expect(body.audio).toBe('abc123');
    expect(res.status).toBe(200);
  });

  it('generates TTS via cloud when GPU unavailable and proxies result to avatar', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    setDeployState({ ...deployState, status: 'idle', endpoint: '' });
    const fakeAudio = Buffer.from('wav-bytes');
    mockSynthesize.mockResolvedValue({ audio: fakeAudio });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ queued: true }) });

    const res = fakeRes();
    await handleAvatarSpeak(
      fakeReq({ text: 'hello world', voice: 'af_heart' }),
      res as unknown as ServerResponse,
    );

    expect(mockSynthesize).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3099/api/speak');
    const body = JSON.parse(opts.body as string);
    expect(body.audio).toBe(fakeAudio.toString('base64'));
    expect(body.text).toBe('hello world');
    expect(res.status).toBe(200);
  });

  it('falls back to cloud TTS when GPU TTS returns non-ok status', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    setDeployState({ ...deployState, status: 'ready', endpoint: 'http://gpu:8000' });
    setGpuHealthy(true);
    const fakeAudio = Buffer.from('cloud-wav');
    mockSynthesize.mockResolvedValue({ audio: fakeAudio });
    // GPU TTS fails, avatar succeeds
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const res = fakeRes();
    await handleAvatarSpeak(fakeReq({ text: 'hi' }), res as unknown as ServerResponse);

    expect(mockSynthesize).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('returns 502 when avatar /api/speak fetch throws', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = fakeRes();
    await handleAvatarSpeak(fakeReq({ audio: 'x' }), res as unknown as ServerResponse);
    expect(res.status).toBe(502);
    expect(String((jsonBody(res) as Record<string, unknown>).error)).toContain('Avatar speak failed');
  });

  it('mirrors upstream non-200 status from avatar server', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    fetchMock.mockResolvedValue({ ok: false, status: 422, json: async () => ({ detail: 'bad input' }) });

    const res = fakeRes();
    await handleAvatarSpeak(fakeReq({ audio: 'x' }), res as unknown as ServerResponse);
    expect(res.status).toBe(422);
  });

  it('transforms RunPod proxy URL: port 8080 → 3099', async () => {
    setBotStateVar({ ...botState, endpoint: 'https://abc-8080.proxy.runpod.net/' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const res = fakeRes();
    await handleAvatarSpeak(fakeReq({ audio: 'x' }), res as unknown as ServerResponse);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('abc-3099.proxy.runpod.net');
  });
});

// ── handleAvatarAnimateWord ───────────────────────────────────────────────────

describe('handleAvatarAnimateWord', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setBotStateVar({ ...botState, endpoint: '' });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns 400 on malformed JSON', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    const res = fakeRes();
    await handleAvatarAnimateWord(fakeReqBadJson(), res as unknown as ServerResponse);
    expect(res.status).toBe(400);
  });

  it('returns 503 when no bot endpoint set', async () => {
    setBotStateVar({ ...botState, endpoint: '' });
    const res = fakeRes();
    await handleAvatarAnimateWord(fakeReq({ word: 'hello' }), res as unknown as ServerResponse);
    expect(res.status).toBe(503);
    expect(String((jsonBody(res) as Record<string, unknown>).error)).toContain('No bot pod deployed');
  });

  it('proxies payload to avatar /api/animate-word and returns response', async () => {
    setBotStateVar({ ...botState, endpoint: 'https://mypod-8080.proxy.runpod.net' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ animated: true }) });

    const res = fakeRes();
    await handleAvatarAnimateWord(
      fakeReq({ word: 'hello', timing: 0.5 }),
      res as unknown as ServerResponse,
    );

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mypod-3099.proxy.runpod.net/api/animate-word');
    const body = JSON.parse(opts.body as string);
    expect(body.word).toBe('hello');
    expect(res.status).toBe(200);
    expect((jsonBody(res) as Record<string, unknown>).animated).toBe(true);
  });

  it('returns 502 when avatar fetch throws', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    fetchMock.mockRejectedValue(new Error('timeout'));

    const res = fakeRes();
    await handleAvatarAnimateWord(fakeReq({}), res as unknown as ServerResponse);
    expect(res.status).toBe(502);
    expect(String((jsonBody(res) as Record<string, unknown>).error)).toContain('Avatar animate-word failed');
  });

  it('accepts empty payload (passthrough schema allows any object)', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const res = fakeRes();
    await handleAvatarAnimateWord(fakeReq({}), res as unknown as ServerResponse);
    expect(res.status).toBe(200);
  });

  it('routes to localhost:3099 when bot endpoint is localhost:8085', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const res = fakeRes();
    await handleAvatarAnimateWord(fakeReq({ x: 1 }), res as unknown as ServerResponse);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('localhost:3099');
  });

  it('routes to localhost:3099 when bot endpoint is localhost:8080', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8080' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const res = fakeRes();
    await handleAvatarAnimateWord(fakeReq({}), res as unknown as ServerResponse);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('localhost:3099');
  });
});

// ── handleAvatarMood ──────────────────────────────────────────────────────────

describe('handleAvatarMood', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setBotStateVar({ ...botState, endpoint: '' });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns 400 on malformed JSON', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    const res = fakeRes();
    await handleAvatarMood(fakeReqBadJson(), res as unknown as ServerResponse);
    expect(res.status).toBe(400);
  });

  it('returns 503 when no bot endpoint set', async () => {
    setBotStateVar({ ...botState, endpoint: '' });
    const res = fakeRes();
    await handleAvatarMood(fakeReq({ mood: 'happy' }), res as unknown as ServerResponse);
    expect(res.status).toBe(503);
    expect(String((jsonBody(res) as Record<string, unknown>).error)).toContain('No bot pod deployed');
  });

  it('proxies mood payload to avatar /api/mood', async () => {
    setBotStateVar({ ...botState, endpoint: 'https://pod123-8080.proxy.runpod.net' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ set: true }) });

    const res = fakeRes();
    await handleAvatarMood(fakeReq({ mood: 'sad', intensity: 0.8 }), res as unknown as ServerResponse);

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://pod123-3099.proxy.runpod.net/api/mood');
    const body = JSON.parse(opts.body as string);
    expect(body.mood).toBe('sad');
    expect(res.status).toBe(200);
  });

  it('returns 502 when avatar fetch throws', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    fetchMock.mockRejectedValue(new Error('net error'));

    const res = fakeRes();
    await handleAvatarMood(fakeReq({ mood: 'angry' }), res as unknown as ServerResponse);
    expect(res.status).toBe(502);
    expect(String((jsonBody(res) as Record<string, unknown>).error)).toContain('Avatar mood failed');
  });

  it('mirrors upstream non-200 status from avatar server', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ reason: 'busy' }) });

    const res = fakeRes();
    await handleAvatarMood(fakeReq({}), res as unknown as ServerResponse);
    expect(res.status).toBe(503);
  });
});

// ── handleAvatarStatus ────────────────────────────────────────────────────────

describe('handleAvatarStatus', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setBotStateVar({ ...botState, endpoint: '' });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns 200 with available:false when no bot endpoint is set', async () => {
    setBotStateVar({ ...botState, endpoint: '' });
    const res = fakeRes();
    await handleAvatarStatus({} as IncomingMessage, res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    const body = jsonBody(res) as Record<string, unknown>;
    expect(body.available).toBe(false);
    expect(String(body.reason)).toContain('No bot pod deployed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 200 with available:true when avatar server responds ok', async () => {
    setBotStateVar({ ...botState, endpoint: 'https://mypod-8080.proxy.runpod.net' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: '1.2.3', ready: true }),
    });

    const res = fakeRes();
    await handleAvatarStatus({} as IncomingMessage, res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    const body = jsonBody(res) as Record<string, unknown>;
    expect(body.available).toBe(true);
    expect(body.avatarEndpoint).toBe('https://mypod-3099.proxy.runpod.net');
    expect(body.version).toBe('1.2.3');
  });

  it('returns 200 with available:false when avatar server fetch throws', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = fakeRes();
    await handleAvatarStatus({} as IncomingMessage, res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    const body = jsonBody(res) as Record<string, unknown>;
    expect(body.available).toBe(false);
    expect(String(body.reason)).toContain('Avatar server not reachable');
  });

  it('probes avatar /api/status endpoint', async () => {
    setBotStateVar({ ...botState, endpoint: 'http://localhost:8085' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const res = fakeRes();
    await handleAvatarStatus({} as IncomingMessage, res as unknown as ServerResponse);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3099/api/status');
  });

  it('returns available:false when endpoint format is unrecognised', async () => {
    // An endpoint that does not match RunPod proxy or localhost — getAvatarEndpoint returns null
    setBotStateVar({ ...botState, endpoint: 'https://custom-server.example.com:9000' });
    const res = fakeRes();
    await handleAvatarStatus({} as IncomingMessage, res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    const body = jsonBody(res) as Record<string, unknown>;
    expect(body.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── getAvatarEndpoint URL-derivation (via handleAvatarStatus) ─────────────────

describe('getAvatarEndpoint URL derivation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  async function probe(endpoint: string): Promise<string | null> {
    setBotStateVar({ ...botState, endpoint });
    const res = fakeRes();
    await handleAvatarStatus({} as IncomingMessage, res as unknown as ServerResponse);
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    return calls.length > 0 ? calls[0][0] : null;
  }

  it('RunPod proxy: replaces -8080 with -3099 in URL', async () => {
    const url = await probe('https://abc-8080.proxy.runpod.net');
    expect(url).toBe('https://abc-3099.proxy.runpod.net/api/status');
  });

  it('localhost:8085 → localhost:3099', async () => {
    const url = await probe('http://localhost:8085');
    expect(url).toBe('http://localhost:3099/api/status');
  });

  it('localhost:8080 → localhost:3099', async () => {
    const url = await probe('http://localhost:8080');
    expect(url).toBe('http://localhost:3099/api/status');
  });

  it('unrecognised host → null (no fetch called)', async () => {
    const url = await probe('https://other.example.com:5000');
    expect(url).toBeNull();
  });
});
