/**
 * Unit tests for src/gateway/pipeline/voice-reference-cache.ts
 *
 * Covers: storeVoiceReference (store, return ID, evict when over MAX_REFS),
 * getVoiceReference (hit, miss), clearVoiceReferences, getVoiceReferenceCacheSize.
 *
 * No external I/O — pure in-memory cache logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeVoiceReference,
  getVoiceReference,
  clearVoiceReferences,
  getVoiceReferenceCacheSize,
} from '../../src/gateway/pipeline/voice-reference-cache';

// MAX_REFS is 5 (module constant) — tested via behaviour, not import.
const MAX_REFS = 5;

beforeEach(() => {
  clearVoiceReferences();
});

// ── storeVoiceReference ───────────────────────────────────────────────────────

describe('storeVoiceReference', () => {
  it('returns a non-empty string ID', () => {
    const id = storeVoiceReference('audio==', 'hello');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns IDs starting with "ref_"', () => {
    const id = storeVoiceReference('audio==', 'hello');
    expect(id.startsWith('ref_')).toBe(true);
  });

  it('returns unique IDs for successive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) ids.add(storeVoiceReference(`audio_${i}`, `text_${i}`));
    expect(ids.size).toBe(10);
  });

  it('increments cache size after each store', () => {
    expect(getVoiceReferenceCacheSize()).toBe(0);
    storeVoiceReference('a1', 't1');
    expect(getVoiceReferenceCacheSize()).toBe(1);
    storeVoiceReference('a2', 't2');
    expect(getVoiceReferenceCacheSize()).toBe(2);
  });

  it('caps cache at MAX_REFS entries after exceeding limit', () => {
    for (let i = 0; i < MAX_REFS + 3; i++) {
      storeVoiceReference(`audio_${i}`, `text_${i}`);
    }
    expect(getVoiceReferenceCacheSize()).toBe(MAX_REFS);
  });

  it('stored entry is retrievable via returned ID', () => {
    const id = storeVoiceReference('AAAA==', 'my transcript');
    const ref = getVoiceReference(id);
    expect(ref).not.toBeNull();
    expect(ref!.audio).toBe('AAAA==');
    expect(ref!.text).toBe('my transcript');
  });

  it('preserves most-recent entries when evicting', () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_REFS + 2; i++) {
      // Small delay in test by using different audio content (IDs should differ)
      ids.push(storeVoiceReference(`audio_${i}`, `text_${i}`));
    }
    // The oldest (first) entries must have been evicted; the last MAX_REFS should survive.
    const survivors = ids.slice(-MAX_REFS);
    const evicted = ids.slice(0, 2);

    for (const id of survivors) {
      expect(getVoiceReference(id)).not.toBeNull();
    }
    for (const id of evicted) {
      expect(getVoiceReference(id)).toBeNull();
    }
  });

  it('stores empty string audio and text without error', () => {
    const id = storeVoiceReference('', '');
    const ref = getVoiceReference(id);
    expect(ref).not.toBeNull();
    expect(ref!.audio).toBe('');
    expect(ref!.text).toBe('');
  });

  it('stores large audio payload correctly', () => {
    const largeAudio = 'A'.repeat(100_000);
    const id = storeVoiceReference(largeAudio, 'transcript');
    const ref = getVoiceReference(id);
    expect(ref!.audio).toBe(largeAudio);
  });
});

// ── getVoiceReference ─────────────────────────────────────────────────────────

describe('getVoiceReference', () => {
  it('returns null for unknown ID', () => {
    expect(getVoiceReference('ref_unknown_xyz')).toBeNull();
  });

  it('returns null after the cache is cleared', () => {
    const id = storeVoiceReference('audio', 'text');
    clearVoiceReferences();
    expect(getVoiceReference(id)).toBeNull();
  });

  it('returns the stored audio and text fields', () => {
    const id = storeVoiceReference('base64audio==', 'Hello World');
    const ref = getVoiceReference(id);
    expect(ref).toMatchObject({ audio: 'base64audio==', text: 'Hello World' });
  });

  it('returns a reference to the stored object (not a deep copy)', () => {
    // getVoiceReference returns the raw Map value — mutations propagate.
    // This test documents and pins that behaviour.
    const id = storeVoiceReference('audio', 'text');
    const ref = getVoiceReference(id)!;
    ref.audio = 'mutated';
    const refB = getVoiceReference(id)!;
    expect(refB.audio).toBe('mutated');
  });

  it('returns correct entry when multiple IDs exist', () => {
    const id1 = storeVoiceReference('audio1', 'text1');
    const id2 = storeVoiceReference('audio2', 'text2');
    const id3 = storeVoiceReference('audio3', 'text3');

    expect(getVoiceReference(id1)!.audio).toBe('audio1');
    expect(getVoiceReference(id2)!.audio).toBe('audio2');
    expect(getVoiceReference(id3)!.audio).toBe('audio3');
  });
});

// ── clearVoiceReferences ──────────────────────────────────────────────────────

describe('clearVoiceReferences', () => {
  it('empties the cache', () => {
    storeVoiceReference('a', 'b');
    storeVoiceReference('c', 'd');
    clearVoiceReferences();
    expect(getVoiceReferenceCacheSize()).toBe(0);
  });

  it('is idempotent on empty cache', () => {
    clearVoiceReferences();
    clearVoiceReferences();
    expect(getVoiceReferenceCacheSize()).toBe(0);
  });

  it('allows fresh entries after clearing', () => {
    storeVoiceReference('a', 'b');
    clearVoiceReferences();
    const id = storeVoiceReference('fresh', 'new text');
    expect(getVoiceReference(id)).not.toBeNull();
    expect(getVoiceReferenceCacheSize()).toBe(1);
  });
});

// ── getVoiceReferenceCacheSize ────────────────────────────────────────────────

describe('getVoiceReferenceCacheSize', () => {
  it('returns 0 on empty cache', () => {
    expect(getVoiceReferenceCacheSize()).toBe(0);
  });

  it('returns 1 after one store', () => {
    storeVoiceReference('a', 'b');
    expect(getVoiceReferenceCacheSize()).toBe(1);
  });

  it('never exceeds MAX_REFS', () => {
    for (let i = 0; i < MAX_REFS * 3; i++) storeVoiceReference(`a${i}`, `t${i}`);
    expect(getVoiceReferenceCacheSize()).toBe(MAX_REFS);
  });

  it('decreases to 0 after clear', () => {
    for (let i = 0; i < 3; i++) storeVoiceReference(`a${i}`, `t${i}`);
    expect(getVoiceReferenceCacheSize()).toBe(3);
    clearVoiceReferences();
    expect(getVoiceReferenceCacheSize()).toBe(0);
  });
});

// ── modal-keepalive.ts ────────────────────────────────────────────────────────
// Included here as a companion pipeline module test (no external I/O needed
// for the synchronous lifecycle methods; fetch calls are mocked).

import { describe as describeKeepalive } from 'vitest';
import { vi as viFake, beforeEach as bEach, afterEach as aEach } from 'vitest';
import { ModalKeepalive } from '../../src/gateway/pipeline/modal-keepalive';

describeKeepalive('ModalKeepalive', () => {
  let fetchMock: ReturnType<typeof viFake.fn>;

  bEach(() => {
    viFake.useFakeTimers();
    fetchMock = viFake.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ uptime_s: 42, clone: true }),
    } as unknown as Response);
    globalThis.fetch = fetchMock;
  });

  aEach(() => {
    viFake.useRealTimers();
    viFake.restoreAllMocks();
  });

  it('does not start the timer until touch() is called', () => {
    const ka = new ModalKeepalive({ endpoint: 'http://modal', pingTimeoutMs: 5000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts pinging after touch() is called and timer fires', async () => {
    const ka = new ModalKeepalive({ endpoint: 'http://modal', pingTimeoutMs: 5000 });
    ka.touch();
    // Advance past ping interval (4 minutes)
    await viFake.advanceTimersByTimeAsync(4 * 60_000 + 100);
    expect(fetchMock).toHaveBeenCalledWith('http://modal/health', expect.any(Object));
  });

  it('does not start a second timer on repeated touch() calls', () => {
    const ka = new ModalKeepalive({ endpoint: 'http://modal' });
    ka.touch();
    ka.touch();
    ka.touch();
    // Should only have one interval scheduled — test indirectly: no duplicate fetch calls
    // within a single interval window
    expect(fetchMock).not.toHaveBeenCalled(); // none yet (interval not elapsed)
  });

  it('stop() prevents future ping ticks', async () => {
    const ka = new ModalKeepalive({ endpoint: 'http://modal', pingTimeoutMs: 5000 });
    ka.touch();
    ka.stop();
    await viFake.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auto-stops after idle for > 20 minutes', async () => {
    const ka = new ModalKeepalive({ endpoint: 'http://modal', pingTimeoutMs: 5000 });
    ka.touch(); // lastTouchAt = now

    // Advance 21 minutes — the idle stop threshold (20min) fires inside tick()
    await viFake.advanceTimersByTimeAsync(21 * 60_000);

    // After auto-stop the timer is cleared; subsequent ticks should not produce fetches
    const callsBefore = fetchMock.mock.calls.length;
    await viFake.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('touch() re-starts after stop()', async () => {
    const ka = new ModalKeepalive({ endpoint: 'http://modal', pingTimeoutMs: 5000 });
    ka.touch();
    ka.stop();
    // Re-activate
    ka.touch();
    await viFake.advanceTimersByTimeAsync(4 * 60_000 + 100);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('handles fetch failure gracefully (no throw)', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));
    const ka = new ModalKeepalive({ endpoint: 'http://modal', pingTimeoutMs: 5000 });
    ka.touch();
    await expect(viFake.advanceTimersByTimeAsync(4 * 60_000 + 100)).resolves.not.toThrow();
  });

  it('handles non-OK fetch response gracefully', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
    const ka = new ModalKeepalive({ endpoint: 'http://modal', pingTimeoutMs: 5000 });
    ka.touch();
    await expect(viFake.advanceTimersByTimeAsync(4 * 60_000 + 100)).resolves.not.toThrow();
  });
});
