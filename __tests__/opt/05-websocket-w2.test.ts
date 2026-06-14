// ── Optimization suite #05 — WebSocket / Real-time transport (WAVE 2) ────────
// Unit tests for the localized wave-2 hardening fixes (paths, message-size
// byte accounting, dub-target validation, WAV/PCM framing, bot-audio header +
// trim, STT flush/close-code, connection-count clamp, webhook DLQ + v2 sig).
//
// NO real sockets/network: every "ws" is a plain object with vi.fn() spies;
// fetch is stubbed where a delivery path is exercised. Pure helpers are
// imported via relative paths from the server/src trees.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  packBinaryDubFrame,
  MAX_DUB_FRAME_META_BYTES,
  isValidDubTarget,
  subscribeDub,
  unsubscribeDub,
  getActiveTargets,
} from '../../server/ws-state';

import {
  classifyWsPath,
  wsMessageByteLength,
  exceedsWsMessageLimit,
  wsTooLargeCloseReason,
  resolvePauseMs,
  clampConnCount,
  MAX_WS_MESSAGE_SIZE,
} from '../../server/ws-server';

import {
  validateSpeechAudio,
} from '../../server/ws/speech-lifecycle';

import {
  buildWavHeader,
  trimChunksToByteBudget,
  parseBotAudioHandshake,
  BOT_AUDIO_DEFAULT_SAMPLE_RATE,
} from '../../server/ws/bot-audio';

import {
  shouldForceFlush,
} from '../../server/ws/stt-lifecycle';

import {
  isKnownWsCommand,
  handleWsCommand,
} from '../../server/ws/handlers';

import {
  createWebhookDelivery,
  signWebhookV2,
  verifyWebhookV2,
} from '../../src/webhooks';

// ── Mock WS factory ──────────────────────────────────────────────────────────
type MockWs = {
  data: { id: string };
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getBufferedAmount: ReturnType<typeof vi.fn>;
};

function mockWs(id: string, buffered = 0): MockWs {
  return {
    data: { id },
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    getBufferedAmount: vi.fn(() => buffered),
  };
}

// ── #413 classifyWsPath: reject unknown paths instead of upgrading to bot ────
describe('classifyWsPath (#413)', () => {
  it('maps each known endpoint to its connection type', () => {
    expect(classifyWsPath('/v1/speech/ws')).toBe('speech');
    expect(classifyWsPath('/v1/stt/stream')).toBe('stt');
    expect(classifyWsPath('/ws/bot-audio')).toBe('bot-audio');
    expect(classifyWsPath('/v1/observability/frames')).toBe('frame-inspector');
  });

  it('maps the bot-events root paths to bot', () => {
    expect(classifyWsPath('/')).toBe('bot');
    expect(classifyWsPath('/ws')).toBe('bot');
    expect(classifyWsPath('/v1/events')).toBe('bot');
  });

  it('returns null for an unknown path (typo) so the caller 404s', () => {
    expect(classifyWsPath('/v1/speach/ws')).toBeNull();   // typo
    expect(classifyWsPath('/random')).toBeNull();
    expect(classifyWsPath('/ws/bot-audioo')).toBeNull();
  });
});

// ── #479 / #481 / #480 message-size guard measured in bytes ──────────────────
describe('ws message size guard — byte accounting (#479/#481/#480)', () => {
  it('measures binary frames by byteLength', () => {
    expect(wsMessageByteLength({ byteLength: 1234 })).toBe(1234);
  });

  it('measures strings in UTF-8 bytes, not UTF-16 code units', () => {
    // '😀' is 1 JS string char pair but 4 UTF-8 bytes.
    const s = '😀';
    expect(wsMessageByteLength(s)).toBe(Buffer.byteLength(s, 'utf8'));
    expect(wsMessageByteLength(s)).toBeGreaterThan(s.length);
  });

  it('flags a multibyte string whose .length is under the cap but bytes are over', () => {
    // 3-byte chars: (limit/2 + 1) chars => well under .length cap but ~1.5x bytes.
    const charCount = Math.floor(MAX_WS_MESSAGE_SIZE / 2) + 1; // .length < limit
    const big = '€'.repeat(charCount); // '€' = 3 UTF-8 bytes
    expect(big.length).toBeLessThanOrEqual(MAX_WS_MESSAGE_SIZE);
    expect(exceedsWsMessageLimit(big)).toBe(true);
  });

  it('does not flag a payload at/under the limit', () => {
    expect(exceedsWsMessageLimit('hello')).toBe(false);
    expect(exceedsWsMessageLimit({ byteLength: MAX_WS_MESSAGE_SIZE })).toBe(false);
    expect(exceedsWsMessageLimit({ byteLength: MAX_WS_MESSAGE_SIZE + 1 })).toBe(true);
  });

  it('the 1009 close reason carries the byte limit', () => {
    expect(wsTooLargeCloseReason()).toContain(String(MAX_WS_MESSAGE_SIZE));
    expect(wsTooLargeCloseReason(42)).toContain('42');
  });
});

// ── #455 resolvePauseMs: clamp + default ─────────────────────────────────────
describe('resolvePauseMs (#455)', () => {
  it('clamps to [50, 30000]', () => {
    expect(resolvePauseMs('0')).toBe(700);      // 0 → default 700
    expect(resolvePauseMs('10')).toBe(50);       // below min → 50
    expect(resolvePauseMs('999999')).toBe(30000); // above max → 30000
    expect(resolvePauseMs('1500')).toBe(1500);
  });

  it('defaults non-numeric / missing to 700', () => {
    expect(resolvePauseMs(null)).toBe(700);
    expect(resolvePauseMs(undefined)).toBe(700);
    expect(resolvePauseMs('abc')).toBe(700);
  });
});

// ── #403 clampConnCount: never negative ──────────────────────────────────────
describe('clampConnCount (#403)', () => {
  it('clamps below zero to zero', () => {
    expect(clampConnCount(-1)).toBe(0);
    expect(clampConnCount(-100)).toBe(0);
  });
  it('passes through non-negative values', () => {
    expect(clampConnCount(0)).toBe(0);
    expect(clampConnCount(5)).toBe(5);
  });
});

// ── #438 packBinaryDubFrame rejects oversized metadata ───────────────────────
describe('packBinaryDubFrame oversized-metadata guard (#438)', () => {
  it('packs normal metadata', () => {
    const frame = packBinaryDubFrame({ type: 'dub', target: 'fr' }, Buffer.from('a'));
    expect(frame.length).toBeGreaterThan(4);
  });

  it('throws RangeError when metadata exceeds the cap', () => {
    const huge = { blob: 'x'.repeat(MAX_DUB_FRAME_META_BYTES + 1) };
    expect(() => packBinaryDubFrame(huge, Buffer.alloc(0))).toThrow(RangeError);
  });
});

// ── #483 isValidDubTarget: bounded key space ─────────────────────────────────
describe('isValidDubTarget (#483)', () => {
  it('accepts short language codes', () => {
    expect(isValidDubTarget('en')).toBe(true);
    expect(isValidDubTarget('pt')).toBe(true);
    expect(isValidDubTarget('zh-Hant')).toBe(true);
  });

  it('rejects empty, overlong, and bad-charset targets', () => {
    expect(isValidDubTarget('')).toBe(false);
    expect(isValidDubTarget('x')).toBe(false);            // too short
    expect(isValidDubTarget('a'.repeat(99))).toBe(false); // too long
    expect(isValidDubTarget('en;DROP')).toBe(false);      // bad charset
    expect(isValidDubTarget(123 as any)).toBe(false);     // non-string
  });
});

// ── #482 / #485 command shape + unknown-command nack ─────────────────────────
describe('isKnownWsCommand (#482/#485)', () => {
  it('recognizes the documented commands', () => {
    for (const t of ['bot:join', 'bot:leave', 'dub:subscribe', 'dub:switch', 'dub:unsubscribe', 'speculation:feed', 'ping']) {
      expect(isKnownWsCommand({ type: t })).toBe(true);
    }
  });

  it('rejects unknown / malformed type', () => {
    expect(isKnownWsCommand({ type: 'frobnicate' })).toBe(false);
    expect(isKnownWsCommand({ type: {} as any })).toBe(false);
    expect(isKnownWsCommand({ type: [] as any })).toBe(false);
    expect(isKnownWsCommand({})).toBe(false);
  });
});

describe('handleWsCommand nack + dub validation (#482/#483/#485)', () => {
  it('sends an unknown_command error frame for a bogus type', async () => {
    const ws = mockWs('c1');
    await handleWsCommand(ws as any, { type: 'frobnicate' });
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent).toMatchObject({ type: 'error', code: 'unknown_command' });
  });

  it('sends an unknown_command error frame for a non-string type', async () => {
    const ws = mockWs('c2');
    await handleWsCommand(ws as any, { type: { evil: true } });
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.code).toBe('unknown_command');
  });

  it('answers ping with pong (known command still works)', async () => {
    const ws = mockWs('c3');
    await handleWsCommand(ws as any, { type: 'ping' });
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent).toEqual({ type: 'pong' });
  });

  it('rejects a bogus dub target with invalid_target and does not subscribe', async () => {
    const ws = mockWs('c4');
    await handleWsCommand(ws as any, { type: 'dub:subscribe', target: 'not a code!!' });
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent).toMatchObject({ type: 'error', code: 'invalid_target' });
    expect(getActiveTargets()).not.toContain('not a code!!');
  });

  it('accepts a valid dub target and confirms the subscription', async () => {
    const ws = mockWs('c5');
    await handleWsCommand(ws as any, { type: 'dub:subscribe', target: 'es' });
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent).toMatchObject({ type: 'dub:subscribed', target: 'es' });
    expect(getActiveTargets()).toContain('es');
    unsubscribeDub('c5');
  });
});

// ── #441 validateSpeechAudio: framing checks ─────────────────────────────────
describe('validateSpeechAudio (#441)', () => {
  it('rejects an empty buffer', () => {
    expect(validateSpeechAudio(Buffer.alloc(0))).toMatch(/No audio/i);
  });

  it('rejects a RIFF buffer shorter than the 44-byte header', () => {
    const truncated = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(10)]);
    expect(validateSpeechAudio(truncated)).toMatch(/Truncated WAV/i);
  });

  it('accepts a plausible WAV (RIFF + >=44 bytes)', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60)]);
    expect(validateSpeechAudio(wav)).toBeNull();
  });

  it('rejects odd-length raw PCM (split 16-bit sample)', () => {
    expect(validateSpeechAudio(Buffer.alloc(101))).toMatch(/16-bit/);
  });

  it('accepts even-length raw PCM', () => {
    expect(validateSpeechAudio(Buffer.alloc(640))).toBeNull();
  });
});

// ── #442 / #443 buildWavHeader: negotiated rate + derived byte-rate ──────────
describe('buildWavHeader (#442/#443)', () => {
  it('writes the negotiated sample rate and a correct byte rate', () => {
    const h = buildWavHeader(48000, 1000);
    expect(h.length).toBe(44);
    expect(h.toString('latin1', 0, 4)).toBe('RIFF');
    expect(h.toString('latin1', 8, 12)).toBe('WAVE');
    expect(h.readUInt32LE(24)).toBe(48000);          // sample rate
    expect(h.readUInt32LE(28)).toBe(48000 * 2);      // byte rate = rate*1*2
    expect(h.readUInt16LE(32)).toBe(2);              // block align
    expect(h.readUInt16LE(34)).toBe(16);             // bits/sample
    expect(h.readUInt32LE(40)).toBe(1000);           // data size
    expect(h.readUInt32LE(4)).toBe(1036);            // file size = data + 36
  });

  it('byte-rate tracks the rate (16k vs 48k differ)', () => {
    expect(buildWavHeader(16000, 0).readUInt32LE(28)).toBe(32000);
    expect(buildWavHeader(48000, 0).readUInt32LE(28)).toBe(96000);
  });

  it('falls back to 16000 for a zero/negative rate', () => {
    expect(buildWavHeader(0, 0).readUInt32LE(24)).toBe(16000);
  });
});

// ── #447 trimChunksToByteBudget: keep newest audio ───────────────────────────
describe('trimChunksToByteBudget (#447)', () => {
  it('returns all chunks unchanged when under budget', () => {
    const chunks = [Buffer.alloc(10), Buffer.alloc(10)];
    const r = trimChunksToByteBudget(chunks, 100);
    expect(r.bytes).toBe(20);
    expect(r.chunks).toBe(chunks);
  });

  it('drops the OLDEST chunks and keeps the newest within budget', () => {
    const a = Buffer.from('AAA');   // oldest
    const b = Buffer.from('BBB');
    const c = Buffer.from('CCC');   // newest
    const r = trimChunksToByteBudget([a, b, c], 6);
    expect(r.bytes).toBe(6);
    // chronological order preserved, oldest 'a' dropped
    expect(Buffer.concat(r.chunks).toString()).toBe('BBBCCC');
  });

  it('keeps only the newest chunk when budget fits exactly one', () => {
    const r = trimChunksToByteBudget([Buffer.from('OLD'), Buffer.from('NEW')], 3);
    expect(Buffer.concat(r.chunks).toString()).toBe('NEW');
  });
});

// ── #444 parseBotAudioHandshake: explicit default ────────────────────────────
describe('parseBotAudioHandshake (#444)', () => {
  it('extracts the negotiated sample rate from a valid handshake', () => {
    expect(parseBotAudioHandshake(JSON.stringify({ protocol_version: 1, sample_rate: 48000 })))
      .toEqual({ sampleRate: 48000 });
  });

  it('defaults the rate when sample_rate is missing/invalid', () => {
    expect(parseBotAudioHandshake(JSON.stringify({ protocol_version: 1 })))
      .toEqual({ sampleRate: BOT_AUDIO_DEFAULT_SAMPLE_RATE });
    expect(parseBotAudioHandshake(JSON.stringify({ protocol_version: 1, sample_rate: 0 })))
      .toEqual({ sampleRate: BOT_AUDIO_DEFAULT_SAMPLE_RATE });
  });

  it('returns null for non-handshake / non-JSON strings', () => {
    expect(parseBotAudioHandshake(JSON.stringify({ foo: 'bar' }))).toBeNull();
    expect(parseBotAudioHandshake('not json')).toBeNull();
    expect(parseBotAudioHandshake(JSON.stringify([1, 2, 3]))).toBeNull();
  });
});

// ── #452 shouldForceFlush: words OR chars ────────────────────────────────────
describe('shouldForceFlush (#452)', () => {
  it('flushes when word count meets the threshold', () => {
    expect(shouldForceFlush('one two three', 3, 20)).toBe(true);
  });

  it('flushes a long run of short tokens by char count (the bug fix)', () => {
    // Two words (under the 3-word min) but >20 chars → must still flush.
    const longTwoWords = 'supercalifragilistic expialidocious';
    expect(longTwoWords.split(/\s+/).length).toBeLessThan(3);
    expect(longTwoWords.length).toBeGreaterThan(20);
    expect(shouldForceFlush(longTwoWords, 3, 20)).toBe(true);
  });

  it('does not flush a short fragment under both thresholds', () => {
    expect(shouldForceFlush('hi', 3, 20)).toBe(false);
    expect(shouldForceFlush('   ', 3, 20)).toBe(false);
    expect(shouldForceFlush('', 3, 20)).toBe(false);
  });
});

// ── #497 webhook DLQ is bounded ──────────────────────────────────────────────
describe('webhook DLQ bound (#497)', () => {
  beforeEach(() => {
    // Always fail delivery so every send dead-letters. No SSRF module + a
    // public-looking .test host → fetch is reached; make it throw.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
  });

  it('caps the dead-letter queue at maxDeadLetters (drops oldest)', async () => {
    const delivery = createWebhookDelivery({
      url: 'https://hooks.example-public-domain.test/x',
      retries: 1,        // single attempt → fast fail
      maxDeadLetters: 3,
    });
    for (let i = 0; i < 6; i++) {
      const ok = await delivery.send({ event: 'pipeline.completed', data: { i } });
      expect(ok).toBe(false);
    }
    const dlq = delivery.getDeadLetters();
    expect(dlq.length).toBe(3);
    // Oldest (i=0,1,2) dropped; newest (i=3,4,5) retained, in order.
    expect(dlq.map(d => (d.event.data as any).i)).toEqual([3, 4, 5]);
  });
});

// ── #498 webhook v2 signature commits to timestamp (replay guard) ────────────
describe('webhook v2 signature + replay guard (#498)', () => {
  it('signWebhookV2 is deterministic and binds the timestamp', () => {
    const body = JSON.stringify({ event: 'gpu.deployed', id: 'x' });
    const ts = '2026-06-14T00:00:00.000Z';
    const s1 = signWebhookV2(body, ts, 'secret');
    const s2 = signWebhookV2(body, ts, 'secret');
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    // Different timestamp → different signature (replay of old ts won't verify).
    expect(signWebhookV2(body, '2026-06-14T00:00:01.000Z', 'secret')).not.toBe(s1);
    // Different secret → different signature.
    expect(signWebhookV2(body, ts, 'other')).not.toBe(s1);
  });

  it('verifyWebhookV2 accepts a fresh, correctly-signed request', () => {
    const body = JSON.stringify({ event: 'pipeline.completed' });
    const ts = new Date().toISOString();
    const sig = signWebhookV2(body, ts, 'sek');
    expect(verifyWebhookV2(body, ts, sig, 'sek')).toBe(true);
  });

  it('verifyWebhookV2 rejects a stale timestamp (replay)', () => {
    const body = JSON.stringify({ event: 'pipeline.completed' });
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const sig = signWebhookV2(body, oldTs, 'sek');
    expect(verifyWebhookV2(body, oldTs, sig, 'sek')).toBe(false); // > 5 min tolerance
  });

  it('verifyWebhookV2 rejects a tampered body and a bad signature', () => {
    const ts = new Date().toISOString();
    const sig = signWebhookV2('original', ts, 'sek');
    expect(verifyWebhookV2('tampered', ts, sig, 'sek')).toBe(false);
    expect(verifyWebhookV2('original', ts, 'deadbeef', 'sek')).toBe(false);
  });
});
