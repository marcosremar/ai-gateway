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

  async scan(pattern: string): Promise<string[]> {
    this.sweep();
    const now = Date.now();
    const prefix = pattern.replace('*', '');
    return [...this.kv.entries()]
      .filter(([k, e]) => k.startsWith(prefix) && e.expiresAt >= now)
      .map(([k]) => k);
  }

  async rpush(key: string, value: string): Promise<void> {
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key)!.push(value);
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
    this.hashes.get(key)!.set(field, value);
    if (ttlSecs) this.hashExpiry.set(key, Date.now() + ttlSecs * 1000);
  }

  async hdel(key: string, field: string): Promise<void> {
    this.hashes.get(key)?.delete(field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const exp = this.hashExpiry.get(key);
    if (exp && exp < Date.now()) {
      this.hashes.delete(key);
      this.hashExpiry.delete(key);
      return {};
    }
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash);
  }
}
