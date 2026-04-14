/**
 * SDK, Tracking, Cache, Auth, Vault, Ensemble STT Unit Tests (#506-#620)
 *
 * Tests for spend tracker, caching, auth, vault, GatewaySDK,
 * GatewayHttpClient (internal fetch), and ensemble STT.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helpers ──────────────────────────────────────────────────────────────────

import type { StateStore, KvStore, ListStore, HashStore } from '../../src/deps';

function createMemoryStateStore(): StateStore {
  const kv = new Map<string, { value: string; expiry?: number }>();
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Record<string, string>>();

  return {
    get: async (key) => {
      const entry = kv.get(key);
      if (!entry) return null;
      if (entry.expiry && Date.now() > entry.expiry) {
        kv.delete(key);
        return null;
      }
      return entry.value;
    },
    set: async (key, value, ttlSecs?) => {
      kv.set(key, { value, expiry: ttlSecs ? Date.now() + ttlSecs * 1000 : undefined });
    },
    del: async (key) => {
      kv.delete(key);
    },
    scan: async (pattern) => {
      const prefix = pattern.replace(/\*/g, '');
      return [...kv.keys()].filter((k) => k.startsWith(prefix));
    },
    rpush: async (key, value) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
    },
    ltrim: async (key, start, stop) => {
      const list = lists.get(key) ?? [];
      const len = list.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : stop;
      lists.set(key, list.slice(s, e + 1));
    },
    lrange: async (key, start, stop) => {
      const list = lists.get(key) ?? [];
      const len = list.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : stop;
      return list.slice(s, e + 1);
    },
    hset: async (key, field, value) => {
      const hash = hashes.get(key) ?? {};
      hash[field] = value;
      hashes.set(key, hash);
    },
    hdel: async (key, field) => {
      const hash = hashes.get(key);
      if (hash) delete hash[field];
    },
    hgetall: async (key) => {
      return hashes.get(key) ?? {};
    },
  };
}

function createMemoryKvStore(): KvStore {
  const data = new Map<string, { value: string; expiry?: number }>();
  return {
    get: async (key) => {
      const entry = data.get(key);
      if (!entry) return null;
      if (entry.expiry && Date.now() > entry.expiry) {
        data.delete(key);
        return null;
      }
      return entry.value;
    },
    set: async (key, value, ttlSecs?) => {
      data.set(key, { value, expiry: ttlSecs ? Date.now() + ttlSecs * 1000 : undefined });
    },
    del: async (key) => {
      data.delete(key);
    },
    scan: async (pattern) => {
      const prefix = pattern.replace(/\*/g, '');
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

// ── Spend Tracker Tests (#506-#520) ──────────────────────────────────────────

describe('SpendTracker', () => {
  let store: StateStore;

  beforeEach(async () => {
    store = createMemoryStateStore();
  });

  async function createTracker() {
    const { SpendTracker } = await import('../src/tracking/spend-tracker');
    return new SpendTracker(store);
  }

  function makeRecord(overrides: Record<string, unknown> = {}) {
    return {
      userId: 'user-1',
      provider: 'groq',
      model: 'whisper',
      stage: 'stt' as const,
      inputTokens: 100,
      outputTokens: 0,
      costUsd: 0.001,
      timestamp: Date.now(),
      ...overrides,
    };
  }

  // #506 — record a spend event
  it('records a spend event', async () => {
    const tracker = await createTracker();
    await tracker.record(makeRecord());
    const summary = await tracker.getDailySummary('user-1');
    expect(summary.requestCount).toBe(1);
    expect(summary.totalCostUsd).toBeCloseTo(0.001);
  });

  // #507 — rejects negative costs
  it('ignores records with negative cost', async () => {
    const tracker = await createTracker();
    await tracker.record(makeRecord({ costUsd: -0.5 }));
    const summary = await tracker.getDailySummary('user-1');
    expect(summary.requestCount).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
  });

  // #508 — daily summary aggregates by provider
  it('aggregates by provider in daily summary', async () => {
    const tracker = await createTracker();
    await tracker.record(makeRecord({ provider: 'groq', costUsd: 0.001 }));
    await tracker.record(makeRecord({ provider: 'openai', costUsd: 0.01 }));
    const summary = await tracker.getDailySummary('user-1');
    expect(summary.byProvider['groq'].requests).toBe(1);
    expect(summary.byProvider['openai'].requests).toBe(1);
    expect(summary.totalCostUsd).toBeCloseTo(0.011);
  });

  // #509 — daily summary aggregates by stage
  it('aggregates by stage in daily summary', async () => {
    const tracker = await createTracker();
    await tracker.record(makeRecord({ stage: 'stt', costUsd: 0.001 }));
    await tracker.record(makeRecord({ stage: 'llm', costUsd: 0.01 }));
    await tracker.record(makeRecord({ stage: 'tts', costUsd: 0.005 }));
    const summary = await tracker.getDailySummary('user-1');
    expect(Object.keys(summary.byStage)).toEqual(expect.arrayContaining(['stt', 'llm', 'tts']));
    expect(summary.requestCount).toBe(3);
  });

  // #510 — budget check: under budget
  it('checkBudget returns over=false when under limit', async () => {
    const tracker = await createTracker();
    await tracker.record(makeRecord({ costUsd: 0.5 }));
    const status = await tracker.checkBudget('user-1', { dailyLimitUsd: 10.0 });
    expect(status.over).toBe(false);
    expect(status.pct).toBeLessThan(1);
    expect(status.currentUsd).toBeCloseTo(0.5);
  });

  // #511 — budget check: over budget
  it('checkBudget returns over=true when at or over limit', async () => {
    const tracker = await createTracker();
    await tracker.record(makeRecord({ costUsd: 10.0 }));
    const status = await tracker.checkBudget('user-1', { dailyLimitUsd: 10.0 });
    expect(status.over).toBe(true);
    expect(status.pct).toBeGreaterThanOrEqual(1);
  });

  // #512 — budget check with 0 limit
  it('checkBudget handles zero limit gracefully', async () => {
    const tracker = await createTracker();
    const status = await tracker.checkBudget('user-1', { dailyLimitUsd: 0 });
    expect(status.pct).toBe(0);
  });

  // #513 — empty summary for unknown user
  it('returns empty summary for unknown user', async () => {
    const tracker = await createTracker();
    const summary = await tracker.getDailySummary('unknown-user');
    expect(summary.requestCount).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
  });

  // #514 — multiple records same day
  it('accumulates multiple records for same day', async () => {
    const tracker = await createTracker();
    for (let i = 0; i < 10; i++) {
      await tracker.record(makeRecord({ costUsd: 0.01 }));
    }
    const summary = await tracker.getDailySummary('user-1');
    expect(summary.requestCount).toBe(10);
    expect(summary.totalCostUsd).toBeCloseTo(0.1);
  });

  // #515 — estimateCost returns number
  it('estimateCost returns a number', async () => {
    const tracker = await createTracker();
    const cost = tracker.estimateCost('openai', 'gpt-4o-mini', 1000, 500);
    expect(typeof cost).toBe('number');
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});

// ── ResponseCache Tests (#521-#530) ──────────────────────────────────────────

describe('ResponseCache', () => {
  let kvStore: KvStore;

  beforeEach(() => {
    kvStore = createMemoryKvStore();
  });

  async function createCache(opts?: Record<string, unknown>) {
    const { ResponseCache } = await import('../src/caching/response-cache');
    return new ResponseCache(kvStore, opts as any);
  }

  // #521 — cache miss returns null
  it('cache miss returns null', async () => {
    const cache = await createCache();
    const result = await cache.get('nonexistent');
    expect(result).toBeNull();
  });

  // #522 — set and get
  it('cache hit after set', async () => {
    const cache = await createCache();
    const key = cache.buildKey({
      provider: 'openai',
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await cache.set(key, { content: 'hello', model: 'gpt-4' });
    const result = await cache.get<{ content: string }>(key);
    expect(result?.content).toBe('hello');
  });

  // #523 — TTL eviction
  it('returns null after TTL expires', async () => {
    const cache = await createCache({ defaultTtlMs: 1 });
    const key = cache.buildKey({ provider: 'test', model: 'test', messages: [] });
    await cache.set(key, { content: 'data' }, 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    const result = await cache.get(key);
    expect(result).toBeNull();
  });

  // #524 — key determinism
  it('same params produce same key', async () => {
    const cache = await createCache();
    const key1 = cache.buildKey({
      provider: 'openai',
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }],
    });
    const key2 = cache.buildKey({
      provider: 'openai',
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(key1).toBe(key2);
  });

  // #525 — different params produce different keys
  it('different params produce different keys', async () => {
    const cache = await createCache();
    const key1 = cache.buildKey({
      provider: 'openai',
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'A' }],
    });
    const key2 = cache.buildKey({
      provider: 'openai',
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'B' }],
    });
    expect(key1).not.toBe(key2);
  });

  // #526 — stats tracking
  it('tracks hits and misses in stats', async () => {
    const cache = await createCache();
    const key = cache.buildKey({ provider: 'test', model: 'test', messages: [] });
    await cache.set(key, { data: 1 });
    await cache.get(key); // hit
    await cache.get('missing'); // miss
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(50);
  });

  // #527 — reset stats
  it('resetStats clears counters', async () => {
    const cache = await createCache();
    await cache.get('key1');
    cache.resetStats();
    const stats = cache.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.total).toBe(0);
  });

  // #528 — invalidate by pattern
  it('invalidate removes matching keys', async () => {
    const cache = await createCache();
    const key = cache.buildKey({ provider: 'test', model: 'test', messages: [] });
    await cache.set(key, { data: 1 });
    await cache.invalidate('*');
    const result = await cache.get(key);
    expect(result).toBeNull();
  });

  // #529 — JSON.stringify failure in buildKey
  it('handles non-serializable input in buildKey', async () => {
    const cache = await createCache();
    const circular: any = { provider: 'test', model: 'test' };
    circular.self = circular;
    // Should not throw — falls back to provider:model:fallback
    const key = cache.buildKey(circular);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });

  // #530 — per-request cache disable
  it('get returns null when request-level cache is disabled', async () => {
    const cache = await createCache();
    const key = cache.buildKey({ provider: 'test', model: 'test', messages: [] });
    await cache.set(key, { data: 1 });
    const result = await cache.get(key, { enabled: false });
    expect(result).toBeNull();
  });

  // Additional — custom key
  it('buildCustomKey produces a prefixed hash', async () => {
    const cache = await createCache();
    const key = cache.buildCustomKey('my-custom-key');
    expect(key).toContain('custom:');
  });

  // Additional — semantic config
  it('reports semantic enabled state', async () => {
    const cache = await createCache({ semantic: true, similarityThreshold: 0.85 });
    expect(cache.isSemanticEnabled()).toBe(true);
    expect(cache.getSimilarityThreshold()).toBe(0.85);
  });
});

// ── Auth (GPU Token) Tests (#531-#537) ───────────────────────────────────────

describe('Auth — signGpuToken / verifyGpuToken', () => {
  const origSecret = process.env.GPU_ACCESS_SECRET;

  beforeEach(() => {
    process.env.GPU_ACCESS_SECRET = 'test-secret-for-unit-tests-only-32char!';
  });

  afterEach(() => {
    if (origSecret !== undefined) process.env.GPU_ACCESS_SECRET = origSecret;
    else delete process.env.GPU_ACCESS_SECRET;
  });

  // #531 — sign and verify round-trip
  it('sign and verify round-trip works', async () => {
    const { signGpuToken, verifyGpuToken } = await import('../src/auth/gpu-token');
    const token = signGpuToken('user-123');
    const payload = verifyGpuToken(token);
    expect(payload.uid).toBe('user-123');
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  // #532 — token has correct structure
  it('token has payloadB64.signature structure', async () => {
    const { signGpuToken } = await import('../src/auth/gpu-token');
    const token = signGpuToken('user-1');
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  // #533 — expired token throws
  it('rejects expired token', async () => {
    const { verifyGpuToken } = await import('../src/auth/gpu-token');
    // Craft an expired token manually
    const crypto = await import('crypto');
    const payload = { uid: 'user-1', iat: 1000, exp: 1060 }; // epoch 1060 = long ago
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto
      .createHmac('sha256', process.env.GPU_ACCESS_SECRET!)
      .update(payloadB64)
      .digest('base64url');
    const token = `${payloadB64}.${sig}`;
    expect(() => verifyGpuToken(token)).toThrow('Token expired');
  });

  // #534 — tampered signature throws
  it('rejects token with tampered signature', async () => {
    const { signGpuToken, verifyGpuToken } = await import('../src/auth/gpu-token');
    const token = signGpuToken('user-1');
    const tampered = token.slice(0, -4) + 'XXXX';
    expect(() => verifyGpuToken(tampered)).toThrow('Invalid signature');
  });

  // #535 — tampered payload throws
  it('rejects token with tampered payload', async () => {
    const { signGpuToken, verifyGpuToken } = await import('../src/auth/gpu-token');
    const token = signGpuToken('user-1');
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ uid: 'hacker', iat: 999999999, exp: 9999999999 }),
    ).toString('base64url');
    expect(() => verifyGpuToken(`${tamperedPayload}.${parts[1]}`)).toThrow('Invalid signature');
  });

  // #536 — missing secret throws
  it('throws when GPU_ACCESS_SECRET not set', async () => {
    delete process.env.GPU_ACCESS_SECRET;
    // Need fresh import to pick up env change
    vi.resetModules();
    const { signGpuToken } = await import('../src/auth/gpu-token');
    expect(() => signGpuToken('user-1')).toThrow('GPU_ACCESS_SECRET not set');
  });

  // #537 — invalid token format throws
  it('rejects token with invalid format (no dot)', async () => {
    const { verifyGpuToken } = await import('../src/auth/gpu-token');
    expect(() => verifyGpuToken('nodottoken')).toThrow('Invalid token format');
  });
});

// ── Vault Tests (#538-#548) ──────────────────────────────────────────────────

describe('Vault', () => {
  // 32 bytes = 64 hex chars
  const MASTER_KEY = 'a'.repeat(64);
  const NEW_MASTER_KEY = 'b'.repeat(64);

  function createMemoryVaultStore() {
    const data = new Map<string, string>();
    return {
      get: async (name: string) => data.get(name) ?? null,
      set: async (name: string, value: string) => {
        data.set(name, value);
      },
      delete: async (name: string) => {
        data.delete(name);
      },
      list: async () => [...data.keys()],
      _data: data,
    };
  }

  // #538 — store and retrieve a secret
  it('stores and retrieves a secret', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    await vault.storeSecret('api-key', 'sk-123456');
    const retrieved = await vault.retrieve('api-key');
    expect(retrieved).toBe('sk-123456');
  });

  // #539 — retrieve non-existent secret throws
  it('throws on retrieve of non-existent secret', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    await expect(vault.retrieve('nonexistent')).rejects.toThrow('not found');
  });

  // #540 — delete a secret
  it('deletes a secret', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    await vault.storeSecret('temp', 'value');
    await vault.delete('temp');
    await expect(vault.retrieve('temp')).rejects.toThrow('not found');
  });

  // #541 — list secrets
  it('lists stored secret names', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    await vault.storeSecret('key-a', 'val-a');
    await vault.storeSecret('key-b', 'val-b');
    const names = await vault.list();
    expect(names).toContain('key-a');
    expect(names).toContain('key-b');
  });

  // #542 — encrypt/decrypt round-trip
  it('encrypt and decrypt round-trip works', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    const blob = vault.encrypt('secret-data');
    expect(blob.iv).toBeDefined();
    expect(blob.ciphertext).toBeDefined();
    expect(blob.tag).toBeDefined();
    const decrypted = vault.decrypt(blob);
    expect(decrypted).toBe('secret-data');
  });

  // #543 — key rotation
  it('rotates key and retrieves secrets with new key', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    await vault.storeSecret('rotatable', 'rotate-me');
    await vault.rotateKey(NEW_MASTER_KEY);
    const retrieved = await vault.retrieve('rotatable');
    expect(retrieved).toBe('rotate-me');
  });

  // #544 — rotation error triggers rollback attempt
  it('rotateKey propagates errors on write failure', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    await vault.storeSecret('key-1', 'value-1');

    // Make list() return the secret, but fail on set() during rotation
    const origSet = store.set.bind(store);
    store.set = async () => {
      throw new Error('Simulated write failure');
    };

    // rotateKey calls retrieve (works because original data exists) then set (fails)
    await expect(vault.rotateKey(NEW_MASTER_KEY)).rejects.toThrow('Simulated write failure');

    // Restore set — original data still intact since set failed before writing
    store.set = origSet;
    const val = await vault.retrieve('key-1');
    expect(val).toBe('value-1');
  });

  // #545 — tampered ciphertext fails to decrypt
  it('rejects tampered ciphertext', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    const blob = vault.encrypt('secret-data');
    // Tamper the ciphertext
    blob.ciphertext = 'ff'.repeat(blob.ciphertext.length / 2);
    expect(() => vault.decrypt(blob)).toThrow();
  });

  // #546 — tampered tag fails to decrypt
  it('rejects tampered auth tag', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const vault = new Vault(MASTER_KEY, store);
    const blob = vault.encrypt('secret-data');
    blob.tag = '00'.repeat(16);
    expect(() => vault.decrypt(blob)).toThrow();
  });

  // #547 — invalid master key length
  it('rejects invalid master key length', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    expect(() => new Vault('short-key', store)).toThrow('masterKey must be 32 bytes');
  });

  // #548 — base64 master key
  it('accepts base64-encoded 32-byte master key', async () => {
    const { Vault } = await import('../src/vault/vault');
    const store = createMemoryVaultStore();
    const b64Key = Buffer.from('a'.repeat(32)).toString('base64');
    const vault = new Vault(b64Key, store);
    await vault.storeSecret('test', 'works');
    expect(await vault.retrieve('test')).toBe('works');
  });
});

// ── GatewaySDK Tests (#577-#602) ────────────────────────────────────────────

describe('GatewaySDK', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  function mockJsonResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data),
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(data)).buffer,
      clone() {
        return this;
      },
    } as unknown as Response;
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function createSDK(overrides: Record<string, unknown> = {}) {
    const { GatewaySDK } = await import('../src/sdk/client');
    return new GatewaySDK({
      baseUrl: 'http://localhost:4000',
      ...overrides,
    });
  }

  // #577 — transcribe sends audio
  it('transcribe sends POST to /v1/transcribe', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ text: 'bonjour', used_gpu: true }));
    const sdk = await createSDK();
    const result = await sdk.transcribe(new Uint8Array([1, 2, 3]), 'fr');
    expect(result.text).toBe('bonjour');
    expect(result.usedGpu).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/transcribe'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // #578 — translate sends text
  it('translate sends POST to /v1/translate', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ translated_text: 'hello', used_gpu: false }),
    );
    const sdk = await createSDK();
    const result = await sdk.translate('bonjour', 'fr', 'en');
    expect(result.translatedText).toBe('hello');
  });

  // #579 — translate with empty text
  it('translate returns empty for blank text', async () => {
    const sdk = await createSDK();
    const result = await sdk.translate('  ', 'fr', 'en');
    expect(result.translatedText).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // #580 — pipeline sends audio
  it('pipeline sends POST to /v1/speech', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        transcription: 'bonjour',
        response: 'hello',
        audio_base64: 'AAAA',
        content_type: 'audio/wav',
        timing: { total_ms: 500, used_gpu: true },
      }),
    );
    const sdk = await createSDK();
    const result = await sdk.pipeline(new Uint8Array([1, 2, 3]), { source: 'fr', target: 'en' });
    expect(result.transcription).toBe('bonjour');
    expect(result.timing.usedGpu).toBe(true);
  });

  // #581 — generateAudio
  it('generateAudio sends POST to /v1/tts', async () => {
    const audioBytes = new Uint8Array([82, 73, 70, 70]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => audioBytes.buffer,
      headers: new Headers(),
    } as unknown as Response);
    const sdk = await createSDK();
    const result = await sdk.generateAudio('Hello world', { speaker: 'Ryan' });
    expect(result.contentType).toBe('audio/wav');
  });

  // #582 — listVoices
  it('listVoices returns voices array', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ voices: [{ id: 'v1', name: 'Ryan' }] }));
    const sdk = await createSDK();
    const result = await sdk.listVoices();
    expect(result.voices).toHaveLength(1);
  });

  // #583 — deployGpu
  it('deployGpu sends POST to /v1/gpu/deploy', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ status: 'deploying', message: 'ok' }));
    const sdk = await createSDK();
    const result = await sdk.deployGpu({ apiKey: 'rpa_test', dockerImage: 'test:latest' });
    expect(result.status).toBe('deploying');
  });

  // #584 — gpuStatus
  it('gpuStatus returns status object', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        status: 'ready',
        podId: 'pod-1',
        endpoint: 'http://test:8000',
        gpuType: 'RTX 4090',
        gpuHealthy: true,
      }),
    );
    const sdk = await createSDK();
    const result = await sdk.gpuStatus();
    expect(result.status).toBe('ready');
    expect(result.gpuHealthy).toBe(true);
  });

  // #585 — terminateGpu
  it('terminateGpu sends POST to /v1/gpu/terminate', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ ok: true }));
    const sdk = await createSDK();
    await sdk.terminateGpu('rpa_test');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/gpu/terminate'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // #586 — stopGpu
  it('stopGpu sends POST to /v1/gpu/stop', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ ok: true, podId: 'pod-1' }));
    const sdk = await createSDK();
    const result = await sdk.stopGpu();
    expect(result.ok).toBe(true);
  });

  // #587 — resumeGpu
  it('resumeGpu sends POST to /v1/gpu/resume', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ ok: true }));
    const sdk = await createSDK();
    const result = await sdk.resumeGpu('pod-1');
    expect(result.ok).toBe(true);
  });

  // #588 — gpuOffers
  it('gpuOffers returns offers array', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ offers: [{ id: '1', gpuName: 'RTX 4090' }] }),
    );
    const sdk = await createSDK();
    const result = await sdk.gpuOffers();
    expect(Array.isArray(result)).toBe(true);
  });

  // #589 — gpuList
  it('gpuList returns instances array', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ instances: [] }));
    const sdk = await createSDK();
    const result = await sdk.gpuList();
    expect(Array.isArray(result)).toBe(true);
  });

  // #590 — getProviderConfig
  it('getProviderConfig returns config', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ pipelineStt: ['groq'] }));
    const sdk = await createSDK();
    const result = await sdk.getProviderConfig();
    expect(result.pipelineStt).toEqual(['groq']);
  });

  // #591 — setProviderConfig
  it('setProviderConfig sends POST', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ ok: true }));
    const sdk = await createSDK();
    await sdk.setProviderConfig({ pipelineStt: ['openai'] });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/config/providers'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // #592 — health returns true on 200
  it('health returns true when gateway is up', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ status: 'ok' }));
    const sdk = await createSDK();
    const result = await sdk.health();
    expect(result).toBe(true);
  });

  // #593 — health returns false on error
  it('health returns false when gateway is down', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const sdk = await createSDK();
    const result = await sdk.health();
    expect(result).toBe(false);
  });

  // #594 — chat sends messages
  it('chat sends POST to /v1/chat/completions', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        choices: [{ message: { content: 'Hi there!' } }],
        model: 'llama-3.3-70b',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const sdk = await createSDK();
    const result = await sdk.chat([{ role: 'user', content: 'Hello' }]);
    expect(result.content).toBe('Hi there!');
    expect(result.usage?.totalTokens).toBe(15);
  });

  // #595 — requestLog
  it('requestLog returns request history', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ requests: [{ id: '1' }] }));
    const sdk = await createSDK();
    const result = await sdk.requestLog(10);
    expect(Array.isArray(result)).toBe(true);
  });

  // #596 — metrics returns prometheus string
  it('metrics returns string', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '# HELP gateway_requests Total requests\ngateway_requests 42',
      headers: new Headers(),
    } as unknown as Response);
    const sdk = await createSDK();
    const result = await sdk.metrics();
    expect(typeof result).toBe('string');
    expect(result).toContain('gateway_requests');
  });

  // #597 — gpuLogs
  it('gpuLogs returns log string', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ logs: 'container output...' }));
    const sdk = await createSDK();
    const result = await sdk.gpuLogs();
    expect(result).toBe('container output...');
  });

  // #598 — gpuEventLogs
  it('gpuEventLogs returns entries', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ type: 'jsonl', lines: 1, entries: [{ event: 'boot' }] }),
    );
    const sdk = await createSDK();
    const result = await sdk.gpuEventLogs(10);
    expect(result.entries).toHaveLength(1);
  });

  // #599 — getApiKeys
  it('getApiKeys returns keys array', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ keys: [{ provider: 'groq', hint: 'gsk_...', set: true }] }),
    );
    const sdk = await createSDK();
    const result = await sdk.getApiKeys();
    expect(result).toHaveLength(1);
  });

  // #600 — deployBot
  it('deployBot sends POST to /v1/bot/deploy', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ status: 'deploying' }));
    const sdk = await createSDK();
    const result = await sdk.deployBot({ meetingUrl: 'https://meet.google.com/abc' });
    expect(result.status).toBe('deploying');
  });

  // #601 — close is a no-op
  it('close does not throw', async () => {
    const sdk = await createSDK();
    expect(() => sdk.close()).not.toThrow();
  });

  // #602 — detectLanguage
  it('detectLanguage sends POST', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ language: 'fr', confidence: 0.95 }));
    const sdk = await createSDK();
    const result = await sdk.detectLanguage('Bonjour le monde');
    expect(result.language).toBe('fr');
    expect(result.confidence).toBe(0.95);
  });
});

// ── GatewaySDK HTTP Client Tests (#603-#612) ────────────────────────────────

describe('GatewaySDK — HTTP Client internals', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function createSDK(overrides: Record<string, unknown> = {}) {
    const { GatewaySDK } = await import('../src/sdk/client');
    return new GatewaySDK({
      baseUrl: 'http://localhost:4000',
      ...overrides,
    });
  }

  // #603 — retries on connection error (TypeError)
  it('retries on connection error and eventually succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ text: 'ok', used_gpu: false }),
        headers: new Headers(),
      } as unknown as Response);

    const sdk = await createSDK();
    const result = await sdk.transcribe(new Uint8Array([1]), 'fr');
    expect(result.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // #604 — does not retry HTTP errors
  it('does not retry HTTP 4xx/5xx errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
      headers: new Headers(),
    } as unknown as Response);

    const sdk = await createSDK();
    const { GatewayError } = await import('../src/sdk/types');
    await expect(sdk.translate('test', 'fr', 'en')).rejects.toThrow(GatewayError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // #605 — throws GatewayError with statusCode
  it('throws GatewayError with correct statusCode', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
      headers: new Headers(),
    } as unknown as Response);

    const sdk = await createSDK();
    const { GatewayError } = await import('../src/sdk/types');
    try {
      await sdk.translate('hello', 'en', 'fr');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as InstanceType<typeof GatewayError>).statusCode).toBe(404);
    }
  });

  // #606 — network error triggers GatewayError with isNetworkError=true
  it('network error has isNetworkError=true', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const sdk = await createSDK();
    const { GatewayError } = await import('../src/sdk/types');
    try {
      await sdk.translate('hello', 'en', 'fr');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as InstanceType<typeof GatewayError>).isNetworkError).toBe(true);
    }
  });

  // #607 — authorization header set when apiKey provided
  it('sends Authorization header when apiKey is provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
      headers: new Headers(),
    } as unknown as Response);

    const sdk = await createSDK({ apiKey: 'my-secret-key' });
    await sdk.health();
    const callHeaders = fetchMock.mock.calls[0][1].headers;
    expect(callHeaders.Authorization).toBe('Bearer my-secret-key');
  });

  // #608 — no authorization when no apiKey
  it('does not send Authorization when no apiKey', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
      headers: new Headers(),
    } as unknown as Response);

    const sdk = await createSDK();
    await sdk.health();
    const callHeaders = fetchMock.mock.calls[0][1].headers;
    expect(callHeaders.Authorization).toBeUndefined();
  });

  // #609 — timeout error is not retried
  it('does not retry timeout errors', async () => {
    // DOMException('...', 'AbortError') already has name='AbortError' — no need to set
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    fetchMock.mockRejectedValueOnce(abortErr);

    const sdk = await createSDK();
    const { GatewayError } = await import('../src/sdk/types');
    await expect(sdk.translate('test', 'fr', 'en')).rejects.toThrow(GatewayError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // #610 — Groq fallback on network error for transcribe
  it('falls back to Groq on network error for transcribe', async () => {
    // Gateway network error
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      // Groq direct fallback
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ text: 'groq-result' }),
        headers: new Headers(),
      } as unknown as Response);

    const sdk = await createSDK({ groqApiKey: 'gsk_test' });
    const result = await sdk.transcribe(new Uint8Array([1, 2, 3]), 'fr');
    expect(result.text).toBe('groq-result');
    expect(result.usedGpu).toBe(false);
  });

  // #611 — custom timeouts are respected
  it('uses custom timeouts', async () => {
    const sdk = await createSDK({ timeouts: { stt: 5_000 } });
    // Just verify the SDK was created with custom timeouts
    expect((sdk as any).timeouts.stt).toBe(5_000);
  });

  // #612 — allowedStatuses for deploy (202, 409)
  it('allows 202 and 409 for deployGpu', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ status: 'in-progress', message: 'Deploy already running' }),
      text: async () => JSON.stringify({ status: 'in-progress' }),
      headers: new Headers(),
    } as unknown as Response);

    const sdk = await createSDK();
    const result = await sdk.deployGpu({ apiKey: 'test' });
    expect(result.status).toBe('in-progress');
  });
});

// ── Ensemble STT Tests (#613-#619) ──────────────────────────────────────────

describe('Ensemble STT (runVerifiedSTT)', () => {
  // #613 — returns first successful provider
  it('returns first provider to respond', async () => {
    const { runVerifiedSTT } = await import('../src/ensemble-stt');

    const fastProvider = {
      getModels: () => [{ id: 'whisper-fast' }],
      transcribe: vi.fn().mockResolvedValue({ text: 'fast result', segments: [] }),
    };
    const slowProvider = {
      getModels: () => [{ id: 'whisper-slow' }],
      transcribe: vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ text: 'slow result', segments: [] }), 500),
            ),
        ),
    };

    const result = await runVerifiedSTT(Buffer.from([1, 2, 3]), 'fr', '', {
      providers: [
        { name: 'fast', provider: fastProvider as any },
        { name: 'slow', provider: slowProvider as any },
      ],
    });

    expect(result.consensus).toBe('fast result');
    expect(result.providers['fast']).toBe('fast result');
    expect(result.used_providers).toBe(1);
    expect(result.similarity_method).toBe('jaccard');
  });

  // #614 — throws when all providers fail
  it('throws when all providers fail', async () => {
    const { runVerifiedSTT } = await import('../src/ensemble-stt');

    const failProvider = {
      getModels: () => [{ id: 'whisper' }],
      transcribe: vi.fn().mockRejectedValue(new Error('transcription failed')),
    };

    await expect(
      runVerifiedSTT(Buffer.from([1]), 'fr', '', {
        providers: [
          { name: 'p1', provider: failProvider as any },
          { name: 'p2', provider: failProvider as any },
        ],
      }),
    ).rejects.toThrow('All 2 providers failed');
  });

  // #615 — throws on empty providers
  it('throws when no providers configured', async () => {
    const { runVerifiedSTT } = await import('../src/ensemble-stt');
    await expect(runVerifiedSTT(Buffer.from([1]), 'fr', '', { providers: [] })).rejects.toThrow(
      'No STT providers configured',
    );
  });

  // #616 — timeout drops slow providers
  it('timeout drops slow providers', async () => {
    const { runVerifiedSTT } = await import('../src/ensemble-stt');

    const slowProvider = {
      getModels: () => [{ id: 'whisper' }],
      transcribe: vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ text: 'late', segments: [] }), 2000),
            ),
        ),
    };
    const fastProvider = {
      getModels: () => [{ id: 'whisper-fast' }],
      transcribe: vi.fn().mockResolvedValue({ text: 'fast', segments: [] }),
    };

    const result = await runVerifiedSTT(Buffer.from([1, 2, 3]), 'fr', '', {
      providers: [
        { name: 'slow', provider: slowProvider as any },
        { name: 'fast', provider: fastProvider as any },
      ],
      timeoutMs: 100,
    });

    expect(result.consensus).toBe('fast');
  });

  // #617 — skips providers with empty response
  it('skips providers that return empty text', async () => {
    const { runVerifiedSTT } = await import('../src/ensemble-stt');

    const emptyProvider = {
      getModels: () => [{ id: 'whisper' }],
      transcribe: vi.fn().mockResolvedValue({ text: '', segments: [] }),
    };
    const goodProvider = {
      getModels: () => [{ id: 'whisper' }],
      transcribe: vi.fn().mockResolvedValue({ text: 'hello', segments: [] }),
    };

    const result = await runVerifiedSTT(Buffer.from([1]), 'fr', '', {
      providers: [
        { name: 'empty', provider: emptyProvider as any },
        { name: 'good', provider: goodProvider as any },
      ],
    });

    expect(result.consensus).toBe('hello');
    expect(result.providers['good']).toBe('hello');
  });

  // #618 — provider with no models throws
  it('rejects provider with no models', async () => {
    const { runVerifiedSTT } = await import('../src/ensemble-stt');

    const noModelProvider = {
      getModels: () => [],
      transcribe: vi.fn(),
    };

    await expect(
      runVerifiedSTT(Buffer.from([1]), 'fr', '', {
        providers: [{ name: 'nomodel', provider: noModelProvider as any }],
      }),
    ).rejects.toThrow(/failed/i);
  });

  // #619 — clears deadline timers after race
  it('clears deadline timers after race completes', async () => {
    const { runVerifiedSTT } = await import('../src/ensemble-stt');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const provider = {
      getModels: () => [{ id: 'whisper' }],
      transcribe: vi.fn().mockResolvedValue({ text: 'result', segments: [] }),
    };

    await runVerifiedSTT(Buffer.from([1]), 'fr', '', {
      providers: [
        { name: 'p1', provider: provider as any },
        { name: 'p2', provider: provider as any },
      ],
      timeoutMs: 5000,
    });

    // clearTimeout should have been called for all deadline timers
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  // #620 — back-compat aliases
  it('exports backward-compatible aliases', async () => {
    const mod = await import('../src/ensemble-stt');
    expect(mod.runEnsembleSTT).toBe(mod.runVerifiedSTT);
    expect(mod.EnsembleSTTDeps).toBeUndefined; // it's a type, not a value
  });

  // Additional — latency_ms is reported
  it('reports latency_ms in result', async () => {
    const { runVerifiedSTT } = await import('../src/ensemble-stt');

    const provider = {
      getModels: () => [{ id: 'whisper' }],
      transcribe: vi.fn().mockResolvedValue({ text: 'result', segments: [] }),
    };

    const result = await runVerifiedSTT(Buffer.from([1]), 'fr', '', {
      providers: [{ name: 'p1', provider: provider as any }],
    });

    expect(typeof result.latency_ms).toBe('number');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  // Additional — segments are forwarded
  it('forwards segment data from winning provider', async () => {
    const { runVerifiedSTT } = await import('../src/ensemble-stt');

    const segments = [{ text: 'hello', start: 0, end: 1 }];
    const provider = {
      getModels: () => [{ id: 'whisper' }],
      transcribe: vi.fn().mockResolvedValue({
        text: 'hello',
        segments,
        avg_logprob: -0.3,
        compression_ratio: 1.5,
        no_speech_prob: 0.01,
      }),
    };

    const result = await runVerifiedSTT(Buffer.from([1]), 'fr', '', {
      providers: [{ name: 'p1', provider: provider as any }],
    });

    expect(result.segments).toEqual(segments);
    expect(result.avg_logprob).toBe(-0.3);
    expect(result.compression_ratio).toBe(1.5);
    expect(result.no_speech_prob).toBe(0.01);
  });
});

// ── Credit Block Tracker Tests (supplementary) ───────────────────────────────

describe('CreditBlockTracker', () => {
  it('records and checks credit blocks', async () => {
    const { CreditBlockTracker } = await import('../src/providers/credit-block');
    const tracker = new CreditBlockTracker();
    expect(tracker.isBlocked('groq', 'hash1')).toBe(false);
    tracker.recordBlock('groq', 'hash1');
    expect(tracker.isBlocked('groq', 'hash1')).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it('clear removes specific block', async () => {
    const { CreditBlockTracker } = await import('../src/providers/credit-block');
    const tracker = new CreditBlockTracker();
    tracker.recordBlock('groq', 'hash1');
    tracker.clear('groq', 'hash1');
    expect(tracker.isBlocked('groq', 'hash1')).toBe(false);
  });

  it('serializes and deserializes blocks', async () => {
    const { CreditBlockTracker } = await import('../src/providers/credit-block');
    const tracker = new CreditBlockTracker();
    tracker.recordBlock('groq', 'hash1');
    const json = tracker.toJSON();
    expect(Object.keys(json).length).toBe(1);

    const restored = new CreditBlockTracker();
    restored.fromJSON(json);
    expect(restored.isBlocked('groq', 'hash1')).toBe(true);
  });

  it('hashApiKey produces consistent hash', async () => {
    const { hashApiKey } = await import('../src/providers/credit-block');
    const hash1 = hashApiKey('gsk_test123');
    const hash2 = hashApiKey('gsk_test123');
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(32);
  });
});

// ── Vault Singleton Tests ────────────────────────────────────────────────────

describe('Vault Singleton', () => {
  it('getVault returns null before init', async () => {
    const { getVault, resetVault } = await import('../src/vault/vault-singleton');
    resetVault();
    expect(getVault()).toBeNull();
  });

  it('setVault / getVault round-trip', async () => {
    const { setVault, getVault, resetVault } = await import('../src/vault/vault-singleton');
    const { Vault } = await import('../src/vault/vault');
    resetVault();
    const store = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const vault = new Vault('a'.repeat(64), store);
    setVault(vault);
    expect(getVault()).toBe(vault);
    resetVault();
  });
});
