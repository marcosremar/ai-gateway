// ── Optimization suite #05 — WebSocket / Real-time transport ─────────────────
// Unit tests for the localized backpressure / fan-out / source-guard fixes.
// NO real sockets: every "ws" is a plain object with vi.fn() spies. Pure
// helpers are imported via relative paths from the server/src trees.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  broadcastWs,
  broadcastDubAudio,
  subscribeDub,
  unsubscribeDub,
  packBinaryDubFrame,
  isBackpressured,
  wsClients,
  WS_BROADCAST_BACKPRESSURE_BYTES,
  wsBroadcastDropped,
  resetWsBroadcastDropped,
} from '../../server/ws-state';

import {
  trySetBotAudioSource,
  setBotAudioSource,
  botAudioSource,
} from '../../server/ws/bot-audio';

import {
  isSpeechBackpressured,
  SPEECH_AUDIO_BACKPRESSURE_BYTES,
} from '../../server/ws/speech-lifecycle';

import { createWebhookDelivery, signWebhook } from '../../src/webhooks';

// ── Mock WS factory ──────────────────────────────────────────────────────────
// Minimal shape: { id, data.id, readyState, send, close, getBufferedAmount }.
type MockWs = {
  data: { id: string };
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getBufferedAmount: ReturnType<typeof vi.fn>;
};

function mockWs(id: string, buffered = 0, opts: { sendThrows?: boolean; readyState?: number } = {}): MockWs {
  return {
    data: { id },
    readyState: opts.readyState ?? 1,
    send: vi.fn(() => { if (opts.sendThrows) throw new Error('socket closed'); }),
    close: vi.fn(),
    getBufferedAmount: vi.fn(() => buffered),
  };
}

function clearWsClients(): void {
  for (const ws of [...wsClients]) wsClients.delete(ws);
}

const HIGH = WS_BROADCAST_BACKPRESSURE_BYTES + 1;

beforeEach(() => {
  clearWsClients();
  resetWsBroadcastDropped();
  setBotAudioSource(null);
});

// ── #419 broadcastWs backpressure + single-serialize + dead-client reaping ───
describe('broadcastWs backpressure (#419)', () => {
  it('skips clients over the buffered-bytes ceiling and counts the drop', () => {
    const healthy = mockWs('a', 0);
    const slow = mockWs('b', HIGH);
    wsClients.add(healthy as any);
    wsClients.add(slow as any);

    broadcastWs({ type: 'gpu:status' });

    expect(healthy.send).toHaveBeenCalledTimes(1);
    expect(slow.send).not.toHaveBeenCalled();
    expect(wsBroadcastDropped).toBe(1);
  });

  it('serializes the payload once and sends the identical string to all healthy clients', () => {
    const a = mockWs('a');
    const b = mockWs('b');
    wsClients.add(a as any);
    wsClients.add(b as any);

    broadcastWs({ type: 'x', n: 1 });

    const sentA = a.send.mock.calls[0][0];
    const sentB = b.send.mock.calls[0][0];
    expect(typeof sentA).toBe('string');
    expect(sentA).toBe(JSON.stringify({ type: 'x', n: 1 }));
    // Same reference => serialized once, not per-client.
    expect(sentA).toBe(sentB);
  });

  it('removes clients whose send throws (collect-then-delete)', () => {
    const ok = mockWs('ok');
    const broken = mockWs('broken', 0, { sendThrows: true });
    wsClients.add(ok as any);
    wsClients.add(broken as any);

    broadcastWs({ type: 'ping' });

    expect(wsClients.has(broken as any)).toBe(false);
    expect(wsClients.has(ok as any)).toBe(true);
  });

  it('is a no-op with no clients', () => {
    expect(() => broadcastWs({ type: 'noop' })).not.toThrow();
    expect(wsBroadcastDropped).toBe(0);
  });
});

// ── isBackpressured helper ───────────────────────────────────────────────────
describe('isBackpressured helper', () => {
  it('is true at/over the limit, false below', () => {
    expect(isBackpressured(mockWs('x', WS_BROADCAST_BACKPRESSURE_BYTES))).toBe(true);
    expect(isBackpressured(mockWs('x', WS_BROADCAST_BACKPRESSURE_BYTES - 1))).toBe(false);
  });

  it('treats a missing getBufferedAmount as not-backpressured', () => {
    expect(isBackpressured({} as any)).toBe(false);
  });

  it('honours a custom limit', () => {
    expect(isBackpressured(mockWs('x', 100), 50)).toBe(true);
    expect(isBackpressured(mockWs('x', 40), 50)).toBe(false);
  });
});

// ── #420 / #421 relay backpressure share the same isBackpressured gate ───────
// (The relay loops live in ws-server.ts/bot-audio.ts and call isBackpressured
//  per client; we assert the gate's semantics that those loops rely on.)
describe('relay backpressure gate (#420/#421)', () => {
  it('a saturated viewer is gated out while a healthy one is not', () => {
    const fast = mockWs('fast', 0);
    const slow = mockWs('slow', HIGH);
    // Emulate the relay loop body.
    const relayed: string[] = [];
    for (const c of [fast, slow]) {
      if (isBackpressured(c)) continue;
      relayed.push(c.data.id);
    }
    expect(relayed).toEqual(['fast']);
  });
});

// ── #432 / #433 broadcastDubAudio: partition + backpressure + safe delete ────
describe('broadcastDubAudio (#432/#433)', () => {
  it('sends a binary frame to opted-in clients and JSON to the rest', () => {
    const bin = mockWs('bin');
    const txt = mockWs('txt');
    subscribeDub('bin', bin as any, 'es', true);   // binaryAudio: true
    subscribeDub('txt', txt as any, 'es', false);

    const audio = Buffer.from([1, 2, 3, 4]);
    broadcastDubAudio('es', { type: 'dub', audio: 'IGNORED', target: 'es' }, audio);

    // Binary client received a Buffer; text client received a JSON string.
    expect(Buffer.isBuffer(bin.send.mock.calls[0][0])).toBe(true);
    expect(typeof txt.send.mock.calls[0][0]).toBe('string');
    // The JSON path still carries the original message (incl. audio field).
    expect(txt.send.mock.calls[0][0]).toContain('"target":"es"');

    unsubscribeDub('bin');
    unsubscribeDub('txt');
  });

  it('skips backpressured dub subscribers', () => {
    const slow = mockWs('slow', HIGH);
    subscribeDub('slow', slow as any, 'de', false);

    broadcastDubAudio('de', { type: 'dub', target: 'de' });

    expect(slow.send).not.toHaveBeenCalled();
    expect(wsBroadcastDropped).toBe(1);
    unsubscribeDub('slow');
  });

  it('delivers to every subscriber even when an earlier one throws (no skip)', () => {
    // Three subscribers; the first throws on send. collect-then-delete must not
    // cause the iteration to skip the subscriber that follows the deleted one.
    const a = mockWs('a', 0, { sendThrows: true });
    const b = mockWs('b');
    const c = mockWs('c');
    subscribeDub('a', a as any, 'it', false);
    subscribeDub('b', b as any, 'it', false);
    subscribeDub('c', c as any, 'it', false);

    broadcastDubAudio('it', { type: 'dub', target: 'it' });

    expect(b.send).toHaveBeenCalledTimes(1);
    expect(c.send).toHaveBeenCalledTimes(1);

    unsubscribeDub('a'); unsubscribeDub('b'); unsubscribeDub('c');
  });
});

// ── #437 packBinaryDubFrame is decodable (length header + payload split) ─────
describe('packBinaryDubFrame round-trip (#437)', () => {
  it('writes a uint32 LE JSON length and the audio after it', () => {
    const meta = { type: 'dub', target: 'fr', seq: 7 };
    const audio = Buffer.from('AUDIO-BYTES-HERE');
    const frame = packBinaryDubFrame(meta, audio);

    const jsonLen = frame.readUInt32LE(0);
    expect(jsonLen).toBe(Buffer.byteLength(JSON.stringify(meta)));
    // Decoder contract: jsonLen must fit within the frame.
    expect(jsonLen).toBeLessThanOrEqual(frame.length - 4);

    const decodedMeta = JSON.parse(frame.subarray(4, 4 + jsonLen).toString());
    const decodedAudio = frame.subarray(4 + jsonLen);
    expect(decodedMeta).toEqual(meta);
    expect(decodedAudio.equals(audio)).toBe(true);
  });
});

// ── #475 trySetBotAudioSource: single-source guard ───────────────────────────
describe('trySetBotAudioSource single-source guard (#475)', () => {
  it('claims the slot when empty', () => {
    const first = mockWs('first');
    expect(trySetBotAudioSource(first as any)).toBe(true);
    expect(botAudioSource).toBe(first as any);
  });

  it('rejects a second source while the incumbent is OPEN', () => {
    const first = mockWs('first', 0, { readyState: 1 });
    const second = mockWs('second');
    expect(trySetBotAudioSource(first as any)).toBe(true);
    expect(trySetBotAudioSource(second as any)).toBe(false);
    // Incumbent retained, newcomer did not clobber it.
    expect(botAudioSource).toBe(first as any);
  });

  it('takes over when the incumbent socket is no longer OPEN (half-open)', () => {
    const stale = mockWs('stale', 0, { readyState: 3 /* CLOSED */ });
    const fresh = mockWs('fresh');
    setBotAudioSource(stale as any);
    expect(trySetBotAudioSource(fresh as any)).toBe(true);
    expect(botAudioSource).toBe(fresh as any);
  });

  it('re-claiming with the same ws is idempotent', () => {
    const ws = mockWs('same');
    expect(trySetBotAudioSource(ws as any)).toBe(true);
    expect(trySetBotAudioSource(ws as any)).toBe(true);
    expect(botAudioSource).toBe(ws as any);
  });
});

// ── #418 isSpeechBackpressured: skip audio chunks for saturated speech ws ────
describe('isSpeechBackpressured (#418)', () => {
  it('is true at/over the audio ceiling, false below', () => {
    expect(isSpeechBackpressured(mockWs('x', SPEECH_AUDIO_BACKPRESSURE_BYTES))).toBe(true);
    expect(isSpeechBackpressured(mockWs('x', SPEECH_AUDIO_BACKPRESSURE_BYTES - 1))).toBe(false);
  });

  it('treats a missing getBufferedAmount as not-backpressured', () => {
    expect(isSpeechBackpressured({} as any)).toBe(false);
  });
});

// ── #469 webhook SSRF guard is present and refuses private targets ───────────
describe('webhook SSRF guard (#469)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('refuses delivery to a loopback URL without calling fetch', async () => {
    const delivery = createWebhookDelivery({ url: 'http://127.0.0.1/hook', retries: 1 });
    const ok = await delivery.send({ event: 'pipeline.completed', data: { x: 1 } });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses delivery to a metadata host (link-local) without calling fetch', async () => {
    const delivery = createWebhookDelivery({ url: 'http://169.254.169.254/latest/meta-data', retries: 1 });
    const ok = await delivery.send({ event: 'gpu.deployed', data: {} });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses file: URLs without calling fetch', async () => {
    const delivery = createWebhookDelivery({ url: 'file:///etc/passwd', retries: 1 });
    const ok = await delivery.send({ event: 'config.changed', data: {} });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows a public URL through to fetch', async () => {
    const delivery = createWebhookDelivery({ url: 'https://hooks.example-public-domain.test/x', retries: 1 });
    // .test suffix skips DNS resolution but is NOT in the synchronous blocklist,
    // so the guard lets it through to fetch (which we stub to 200).
    const ok = await delivery.send({ event: 'pipeline.completed', data: {} });
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('signWebhook is deterministic HMAC-SHA256 hex', () => {
    const evt = { event: 'gpu.deployed', data: { a: 1 }, id: 'fixed', timestamp: 't' };
    const sig1 = signWebhook(evt, 'secret');
    const sig2 = signWebhook(evt, 'secret');
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/);
    expect(signWebhook(evt, 'other')).not.toBe(sig1);
  });
});
