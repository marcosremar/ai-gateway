/**
 * In-memory StateStore implementation — zero external deps.
 * Useful as a fallback when Redis is unavailable and in tests.
 */
import type { StateStore } from '../deps';

export class InMemoryStateAdapter implements StateStore {
  private kv = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> { return this.kv.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.kv.set(key, value); }
  async del(key: string): Promise<void> { this.kv.delete(key); this.hashes.delete(key); this.lists.delete(key); }

  async scan(pattern: string): Promise<string[]> {
    const prefix = pattern.replace('*', '');
    return [...this.kv.keys()].filter(k => k.startsWith(prefix));
  }

  async rpush(key: string, value: string): Promise<void> {
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key)!.push(value);
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

  async hset(key: string, field: string, value: string): Promise<void> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
  }

  async hdel(key: string, field: string): Promise<void> {
    this.hashes.get(key)?.delete(field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash);
  }
}
