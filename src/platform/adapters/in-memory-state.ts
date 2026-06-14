/**
 * In-memory StateStore implementation — zero external deps.
 * Useful as a fallback when Redis is unavailable and in tests.
 *
 * Now supports TTL: keys written with a TTL are auto-expired on access
 * and swept periodically to prevent unbounded memory growth.
 */
import type { StateStore } from '../deps';

interface KVEntry { value: string; expiresAt: number; }

export class InMemoryStateAdapter implements StateStore {
  private kv = new Map<string, KVEntry>();
  private hashes = new Map<string, Map<string, string>>();
  private hashExpiry = new Map<string, number>(); // key → expiresAt
  private lists = new Map<string, string[]>();
  private listAccess = new Map<string, number>(); // key → last access timestamp
  private lastSweep = Date.now();
  private readonly LIST_IDLE_TTL = 48 * 60 * 60_000; // 48h
  /** #757: hard cap so a runaway producer can't OOM before the idle sweep. */
  private readonly MAX_LIST_LEN = 100_000;
  /** #759: hard cap on fields per hash so heartbeat hashes can't grow forever. */
  private readonly MAX_HASH_FIELDS = 100_000;

  /** Lazily sweep expired entries (at most every 60s). */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, entry] of this.kv) {
      if (entry.expiresAt < now) this.kv.delete(k);
    }
    for (const [k, exp] of this.hashExpiry) {
      if (exp < now) { this.hashes.delete(k); this.hashExpiry.delete(k); }
    }
    // Sweep idle lists (no TTL support, so evict based on last access time)
    const listCutoff = now - this.LIST_IDLE_TTL;
    for (const [k, ts] of this.listAccess) {
      if (ts < listCutoff) { this.lists.delete(k); this.listAccess.delete(k); }
    }
  }

  async get(key: string): Promise<string | null> {
    this.sweep();
    const entry = this.kv.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) { this.kv.delete(key); return null; }
    return entry.value;
  }

  async set(key: string, value: string, ttlSecs?: number): Promise<void> {
    const expiresAt = ttlSecs ? Date.now() + ttlSecs * 1000 : Number.MAX_SAFE_INTEGER;
    this.kv.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.kv.delete(key);
    this.hashes.delete(key);
    this.hashExpiry.delete(key);
    this.lists.delete(key);
  }

  async scan(pattern: string, callback?: (keys: string[]) => boolean | void, limit: number = 1000): Promise<number> {
    this.sweep();
    const now = Date.now();
    const prefix = pattern.replace('*', '');
    // #761: stream matching keys to the callback in batches (like Redis SCAN
    // with COUNT) instead of materializing the entire matching keyspace into one
    // array before a single callback. This keeps the working set small for large
    // keyspaces and lets the caller stop early after any batch.
    const BATCH = 100;
    let batch: string[] = [];
    let total = 0;
    for (const [k, e] of this.kv) {
      if (!k.startsWith(prefix) || e.expiresAt < now) continue;
      batch.push(k);
      total++;
      if (limit && total >= limit) break;
      if (callback && batch.length >= BATCH) {
        const shouldContinue = callback(batch);
        batch = [];
        if (shouldContinue === false) return total;
      }
    }
    if (callback && batch.length > 0) {
      callback(batch);
    }
    return total;
  }

  async rpush(key: string, value: string): Promise<void> {
    if (!this.lists.has(key)) this.lists.set(key, []);
    const list = this.lists.get(key)!;
    list.push(value);
    // #757: enforce a hard upper bound. Redis lists are only trimmed by an
    // explicit `ltrim`; a producer that never trims could grow unbounded and
    // OOM the process before the 48h idle sweep. Drop the oldest entries (FIFO)
    // once over the cap so the newest data survives.
    if (list.length > this.MAX_LIST_LEN) {
      list.splice(0, list.length - this.MAX_LIST_LEN);
    }
    this.listAccess.set(key, Date.now());
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    const list = this.lists.get(key);
    if (!list) return;
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    this.lists.set(key, list.slice(s, e + 1));
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    return list.slice(s, e + 1);
  }

  async hset(key: string, field: string, value: string, ttlSecs?: number): Promise<void> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const hash = this.hashes.get(key)!;
    hash.set(field, value);
    // #759: cap distinct fields per hash. Updating an existing field is always
    // allowed; only *new* fields beyond the cap are rejected so a session that
    // keeps adding heartbeat fields can't grow without bound.
    if (hash.size > this.MAX_HASH_FIELDS) {
      hash.delete(field);
      throw new Error(`hset: hash '${key}' exceeds MAX_HASH_FIELDS (${this.MAX_HASH_FIELDS})`);
    }
    if (ttlSecs) this.hashExpiry.set(key, Date.now() + ttlSecs * 1000);
  }

  async hdel(key: string, field: string): Promise<void> {
    this.hashes.get(key)?.delete(field);
  }

  async hgetall(key: string, limit: number = 1000): Promise<Record<string, string>> {
    const exp = this.hashExpiry.get(key);
    if (exp && exp < Date.now()) {
      this.hashes.delete(key);
      this.hashExpiry.delete(key);
      return {};
    }
    const hash = this.hashes.get(key);
    if (!hash) return {};
    const entries = Array.from(hash).slice(0, limit);
    return Object.fromEntries(entries);
  }

  async hincrby(key: string, field: string, increment: number, ttlSecs?: number): Promise<void> {
    const hash = this.hashes.get(key);
    if (!hash) {
      this.hashes.set(key, new Map([[field, String(increment)]]));
    } else {
      const current = parseFloat(hash.get(field) || '0');
      hash.set(field, String(current + increment));
    }
    // #760: honor TTL so counters created via hincrby expire like hset-created
    // hashes. Previously hincrby never set hashExpiry, making counters immortal
    // even when callers expected TTL parity with hset.
    if (ttlSecs && ttlSecs > 0) this.hashExpiry.set(key, Date.now() + ttlSecs * 1000);
  }
}
