/**
 * Unit tests for server/ws-state.ts
 *
 * Coverage:
 *   packBinaryDubFrame    — frame structure: 4-byte LE header + JSON metadata + raw audio
 *   subscribeDub /
 *   unsubscribeDub /
 *   getActiveTargets      — dub subscription lifecycle (module-level Maps)
 *   broadcastWs           — JSON delivery to all clients; dead-client pruning
 *   broadcastDubAudio     — JSON vs binary frame routing per subscriber type
 *
 * Strategy: vi.resetModules() + dynamic import in beforeEach so the module-level
 * dub Maps (dubTargetClients, dubClientTarget, dubClientWs, dubBinaryClients) are
 * fresh for every test — no cross-test pollution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock heavy dependencies ───────────────────────────────────────────────────

vi.mock('../../server/state', () => ({
  botState: { endpoint: '', transcripts: [] },
  botPodApiKey: null,
}));

vi.mock('../../src/logger', () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  }),
}));

// ── Fake WebSocket factory ────────────────────────────────────────────────────
// ServerWebSocket from Bun is only used as a type (import type) — at runtime
// any object with .send() and .data.id satisfies the interface.

type FakeWS = { send: ReturnType<typeof vi.fn>; data: { id: string } };

function fakeWs(id: string): FakeWS {
  return { send: vi.fn(), data: { id } };
}

// ── Fresh module handle per test ──────────────────────────────────────────────

type WsMod = typeof import('../../server/ws-state');
let m: WsMod;

beforeEach(async () => {
  vi.resetModules();
  m = await import('../../server/ws-state');
});

// ═══════════════════════════════════════════════════════════════════════════
// packBinaryDubFrame — pure binary packing
// ═══════════════════════════════════════════════════════════════════════════

describe('packBinaryDubFrame', () => {
  it('first 4 bytes encode the JSON metadata byte length as uint32 LE', () => {
    const metadata = { type: 'dub', target: 'fr' };
    const audio = Buffer.from([0xAA, 0xBB, 0xCC]);
    const frame = m.packBinaryDubFrame(metadata, audio);
    const storedLen = frame.readUInt32LE(0);
    const expectedLen = Buffer.from(JSON.stringify(metadata)).length;
    expect(storedLen).toBe(expectedLen);
  });

  it('total frame length = 4 (header) + jsonLen + audioLen', () => {
    const metadata = { x: 1 };
    const audio = Buffer.alloc(100);
    const frame = m.packBinaryDubFrame(metadata, audio);
    const jsonLen = Buffer.from(JSON.stringify(metadata)).length;
    expect(frame.length).toBe(4 + jsonLen + 100);
  });

  it('JSON bytes after the 4-byte header round-trip to original metadata', () => {
    const metadata = { type: 'subtitle', target: 'de', timing: { start: 1.5 } };
    const audio = Buffer.alloc(8);
    const frame = m.packBinaryDubFrame(metadata, audio);
    const jsonLen = frame.readUInt32LE(0);
    const recovered = JSON.parse(frame.slice(4, 4 + jsonLen).toString('utf-8'));
    expect(recovered).toEqual(metadata);
  });

  it('audio bytes follow the JSON section exactly', () => {
    const metadata = { k: 'v' };
    const audio = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const frame = m.packBinaryDubFrame(metadata, audio);
    const jsonLen = frame.readUInt32LE(0);
    const audioSlice = frame.slice(4 + jsonLen);
    expect(audioSlice.equals(audio)).toBe(true);
  });

  it('handles empty metadata object ({})', () => {
    const audio = Buffer.from([0xFF]);
    const frame = m.packBinaryDubFrame({}, audio);
    const jsonLen = frame.readUInt32LE(0);
    expect(jsonLen).toBe(2); // '{}'
    const recovered = JSON.parse(frame.slice(4, 4 + jsonLen).toString());
    expect(recovered).toEqual({});
  });

  it('handles zero-length audio buffer', () => {
    const metadata = { type: 'test' };
    const audio = Buffer.alloc(0);
    const frame = m.packBinaryDubFrame(metadata, audio);
    const jsonLen = frame.readUInt32LE(0);
    expect(frame.length).toBe(4 + jsonLen);
  });

  it('handles large audio buffer (1 MB)', () => {
    const metadata = { target: 'ja' };
    const audio = Buffer.alloc(1_000_000, 0x55);
    const frame = m.packBinaryDubFrame(metadata, audio);
    const jsonLen = frame.readUInt32LE(0);
    expect(frame.length).toBe(4 + jsonLen + 1_000_000);
    expect(frame[frame.length - 1]).toBe(0x55);
  });

  it('serializes numeric and boolean values correctly', () => {
    const metadata = { count: 42, active: true, score: 0.95 };
    const audio = Buffer.alloc(1);
    const frame = m.packBinaryDubFrame(metadata, audio);
    const jsonLen = frame.readUInt32LE(0);
    const recovered = JSON.parse(frame.slice(4, 4 + jsonLen).toString());
    expect(recovered.count).toBe(42);
    expect(recovered.active).toBe(true);
    expect(recovered.score).toBe(0.95);
  });

  it('two consecutive calls with different metadata produce different headers', () => {
    const a = m.packBinaryDubFrame({ x: 1 }, Buffer.alloc(0));
    const b = m.packBinaryDubFrame({ long_key_name: 'some_value', more: true }, Buffer.alloc(0));
    expect(a.readUInt32LE(0)).not.toBe(b.readUInt32LE(0));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// subscribeDub / unsubscribeDub / getActiveTargets
// ═══════════════════════════════════════════════════════════════════════════

describe('subscribeDub / unsubscribeDub / getActiveTargets', () => {
  it('getActiveTargets returns [] before any subscription', () => {
    expect(m.getActiveTargets()).toEqual([]);
  });

  it('subscribing makes the target appear in getActiveTargets', () => {
    m.subscribeDub('c1', fakeWs('c1') as any, 'fr');
    expect(m.getActiveTargets()).toContain('fr');
  });

  it('two subscribers to the same target produce exactly one entry', () => {
    m.subscribeDub('c1', fakeWs('c1') as any, 'es');
    m.subscribeDub('c2', fakeWs('c2') as any, 'es');
    const targets = m.getActiveTargets().filter(t => t === 'es');
    expect(targets.length).toBe(1);
  });

  it('unsubscribing removes the target when no clients remain', () => {
    m.subscribeDub('c1', fakeWs('c1') as any, 'de');
    m.unsubscribeDub('c1');
    expect(m.getActiveTargets()).not.toContain('de');
  });

  it('target stays active when one of two subscribers unsubscribes', () => {
    m.subscribeDub('c1', fakeWs('c1') as any, 'it');
    m.subscribeDub('c2', fakeWs('c2') as any, 'it');
    m.unsubscribeDub('c1');
    expect(m.getActiveTargets()).toContain('it');
  });

  it('unsubscribing all clients removes all targets', () => {
    m.subscribeDub('c1', fakeWs('c1') as any, 'fr');
    m.subscribeDub('c2', fakeWs('c2') as any, 'de');
    m.unsubscribeDub('c1');
    m.unsubscribeDub('c2');
    expect(m.getActiveTargets()).toEqual([]);
  });

  it('multiple distinct targets are all reported', () => {
    m.subscribeDub('c1', fakeWs('c1') as any, 'fr');
    m.subscribeDub('c2', fakeWs('c2') as any, 'de');
    m.subscribeDub('c3', fakeWs('c3') as any, 'ja');
    expect(m.getActiveTargets().sort()).toEqual(['de', 'fr', 'ja']);
  });

  it('re-subscribing to a different target updates the subscription', () => {
    const ws = fakeWs('c1');
    m.subscribeDub('c1', ws as any, 'fr');
    m.subscribeDub('c1', ws as any, 'de'); // re-subscribe: old sub cleaned up first
    const targets = m.getActiveTargets();
    expect(targets).toContain('de');
    expect(targets).not.toContain('fr');
  });

  it('re-subscribing same client to same target is idempotent', () => {
    const ws = fakeWs('c1');
    m.subscribeDub('c1', ws as any, 'fr');
    m.subscribeDub('c1', ws as any, 'fr');
    expect(m.getActiveTargets()).toContain('fr');
    // Only one target entry
    expect(m.getActiveTargets().filter(t => t === 'fr').length).toBe(1);
  });

  it('unsubscribeDub for unknown clientId is a safe no-op', () => {
    expect(() => m.unsubscribeDub('ghost')).not.toThrow();
    expect(m.getActiveTargets()).toEqual([]);
  });

  it('subscribing with binaryAudio=true does not affect getActiveTargets', () => {
    m.subscribeDub('c1', fakeWs('c1') as any, 'ko', true);
    expect(m.getActiveTargets()).toContain('ko');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// broadcastWs
// ═══════════════════════════════════════════════════════════════════════════

describe('broadcastWs', () => {
  it('is a no-op when wsClients is empty', () => {
    expect(() => m.broadcastWs({ type: 'test' })).not.toThrow();
  });

  it('delivers serialized JSON to every connected client', () => {
    const ws1 = fakeWs('c1');
    const ws2 = fakeWs('c2');
    m.wsClients.add(ws1 as any);
    m.wsClients.add(ws2 as any);
    m.broadcastWs({ type: 'hello', value: 42 });
    const expected = JSON.stringify({ type: 'hello', value: 42 });
    expect(ws1.send).toHaveBeenCalledWith(expected);
    expect(ws2.send).toHaveBeenCalledWith(expected);
    m.wsClients.clear();
  });

  it('prunes clients whose send() throws', () => {
    const good = fakeWs('good');
    const dead = fakeWs('dead');
    dead.send.mockImplementation(() => { throw new Error('closed'); });
    m.wsClients.add(good as any);
    m.wsClients.add(dead as any);
    m.broadcastWs({ type: 'ping' });
    expect(m.wsClients.has(dead as any)).toBe(false);
    expect(m.wsClients.has(good as any)).toBe(true);
    m.wsClients.clear();
  });

  it('does not call send() on any client when all clients are dead', () => {
    const dead1 = fakeWs('d1');
    const dead2 = fakeWs('d2');
    dead1.send.mockImplementation(() => { throw new Error('closed'); });
    dead2.send.mockImplementation(() => { throw new Error('closed'); });
    m.wsClients.add(dead1 as any);
    m.wsClients.add(dead2 as any);
    expect(() => m.broadcastWs({ type: 'bye' })).not.toThrow();
    expect(m.wsClients.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// broadcastDubAudio
// ═══════════════════════════════════════════════════════════════════════════

describe('broadcastDubAudio', () => {
  it('is a no-op when no clients are subscribed to the target', () => {
    expect(() => m.broadcastDubAudio('zz', { type: 'dub' })).not.toThrow();
  });

  it('delivers JSON string to a non-binary subscriber', () => {
    const ws = fakeWs('c1');
    m.subscribeDub('c1', ws as any, 'fr', false);
    const msg = { type: 'dub', target: 'fr', audio: 'aGVsbG8=' };
    m.broadcastDubAudio('fr', msg);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  it('delivers a binary Buffer to a binary subscriber when audioBuffer is provided', () => {
    const ws = fakeWs('c1');
    m.subscribeDub('c1', ws as any, 'fr', true);
    const audio = Buffer.from([0xAA, 0xBB]);
    m.broadcastDubAudio('fr', { type: 'dub' }, audio);
    expect(ws.send).toHaveBeenCalledOnce();
    const arg = ws.send.mock.calls[0][0];
    expect(Buffer.isBuffer(arg)).toBe(true);
  });

  it('binary frame strips the "audio" field from the metadata header', () => {
    const ws = fakeWs('c1');
    m.subscribeDub('c1', ws as any, 'de', true);
    const audio = Buffer.from([0x11, 0x22]);
    m.broadcastDubAudio('de', { type: 'dub', target: 'de', audio: 'base64data' }, audio);
    const frame: Buffer = ws.send.mock.calls[0][0];
    const jsonLen = frame.readUInt32LE(0);
    const meta = JSON.parse(frame.slice(4, 4 + jsonLen).toString('utf-8'));
    expect(meta).not.toHaveProperty('audio');
    expect(meta.type).toBe('dub');
    expect(meta.target).toBe('de');
  });

  it('binary frame audio bytes equal the supplied audioBuffer', () => {
    const ws = fakeWs('c1');
    m.subscribeDub('c1', ws as any, 'ko', true);
    const audio = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    m.broadcastDubAudio('ko', { type: 'dub' }, audio);
    const frame: Buffer = ws.send.mock.calls[0][0];
    const jsonLen = frame.readUInt32LE(0);
    const audioSlice = frame.slice(4 + jsonLen);
    expect(audioSlice.equals(audio)).toBe(true);
  });

  it('falls back to JSON when audioBuffer is absent even for binary subscriber', () => {
    const ws = fakeWs('c1');
    m.subscribeDub('c1', ws as any, 'fr', true);
    const msg = { type: 'dub' };
    m.broadcastDubAudio('fr', msg); // no audioBuffer
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  it('two binary subscribers to the same target receive the exact same Buffer instance', () => {
    const ws1 = fakeWs('c1');
    const ws2 = fakeWs('c2');
    m.subscribeDub('c1', ws1 as any, 'ja', true);
    m.subscribeDub('c2', ws2 as any, 'ja', true);
    const audio = Buffer.from([0x01]);
    m.broadcastDubAudio('ja', { type: 'dub' }, audio);
    const frame1: Buffer = ws1.send.mock.calls[0][0];
    const frame2: Buffer = ws2.send.mock.calls[0][0];
    // lazy build: same Buffer reference
    expect(frame1).toBe(frame2);
  });

  it('mixed subscribers: binary gets Buffer, non-binary gets JSON string', () => {
    const binWs = fakeWs('bin');
    const jsonWs = fakeWs('json');
    m.subscribeDub('bin',  binWs  as any, 'es', true);
    m.subscribeDub('json', jsonWs as any, 'es', false);
    const audio = Buffer.from([0xAB]);
    m.broadcastDubAudio('es', { type: 'dub' }, audio);
    expect(Buffer.isBuffer(binWs.send.mock.calls[0][0])).toBe(true);
    expect(typeof jsonWs.send.mock.calls[0][0]).toBe('string');
  });

  it('dead subscribers are pruned during broadcast', () => {
    const good = fakeWs('g');
    const dead = fakeWs('d');
    dead.send.mockImplementation(() => { throw new Error('gone'); });
    m.subscribeDub('g', good as any, 'fr', false);
    m.subscribeDub('d', dead as any, 'fr', false);
    m.broadcastDubAudio('fr', { type: 'dub' });
    // good client still received the message
    expect(good.send).toHaveBeenCalledOnce();
    // target still active (good subscriber remains)
    expect(m.getActiveTargets()).toContain('fr');
  });

  it('broadcasts to subscribers on different targets independently', () => {
    const wsFr = fakeWs('cFr');
    const wsDe = fakeWs('cDe');
    m.subscribeDub('cFr', wsFr as any, 'fr');
    m.subscribeDub('cDe', wsDe as any, 'de');
    const msgFr = { type: 'dub', target: 'fr' };
    m.broadcastDubAudio('fr', msgFr);
    expect(wsFr.send).toHaveBeenCalledWith(JSON.stringify(msgFr));
    expect(wsDe.send).not.toHaveBeenCalled();
  });
});
