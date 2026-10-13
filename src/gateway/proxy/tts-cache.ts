import { createHash } from 'crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

export interface TtsCacheEntry { audio: Buffer; contentType: string; provider: string; synthMs: number; at: number }
interface DiskMeta { contentType: string; provider: string; synthMs: number; at: number; bytes: number }

export interface TtsCacheOptions { maxBytes: number; maxEntryBytes: number; ttlMs: number; dir?: string; diskMaxBytes: number; now?: () => number }

export interface TtsCacheAppStats { hits: number; misses: number; bypassed: number; savedMs: number }
export interface TtsCacheStats {
  entries: number; bytes: number; maxBytes: number; diskBytes: number; diskMaxBytes: number; ttlHours: number;
  hits: number; misses: number; bypassed: number; evictions: number; savedMs: number; byApp: Record<string, TtsCacheAppStats>;
}

const MB = 1024 * 1024;
export const TTS_CACHE_DEFAULTS = { maxBytes: 64 * MB, maxEntryBytes: 4 * MB, ttlMs: 24 * 3_600_000, diskMaxBytes: 200 * MB };
const MIN_COMPRESSED_BYTES = 256;
const MIN_PCM_RMS = 50;

export function ttsCacheFromEnv(env: Record<string, string | undefined>, stateDir: string): TtsCache | null {
  if (env.TTS_CACHE?.trim() === '0') return null;
  const num = (v: string | undefined, d: number) => (v?.trim() && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const diskMaxBytes = num(env.TTS_CACHE_DISK_MB, TTS_CACHE_DEFAULTS.diskMaxBytes / MB) * MB;
  return new TtsCache({
    maxBytes: num(env.TTS_CACHE_MEMORY_MB, TTS_CACHE_DEFAULTS.maxBytes / MB) * MB,
    maxEntryBytes: TTS_CACHE_DEFAULTS.maxEntryBytes,
    ttlMs: num(env.TTS_CACHE_TTL_HOURS, TTS_CACHE_DEFAULTS.ttlMs / 3_600_000) * 3_600_000,
    diskMaxBytes, ...(diskMaxBytes > 0 ? { dir: join(stateDir, 'tts-cache') } : {}),
  });
}

export const normalizeText = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();

export function ttsCacheKey(scope: string, model: string, chain: string, params: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify([scope, model, chain, sorted])).digest('hex');
}

export function audioComplete(audio: Buffer, contentType: string): boolean {
  const riff = audio.subarray(0, 4).toString() === 'RIFF';
  if (!riff && !/wav|pcm|l16/i.test(contentType)) return audio.length >= MIN_COMPRESSED_BYTES;
  const start = riff ? 44 : 0;
  let sum = 0;
  let n = 0;
  for (let i = start; i + 1 < audio.length; i += 2, n++) sum += audio.readInt16LE(i) ** 2;
  return n > 0 && Math.sqrt(sum / n) >= MIN_PCM_RMS;
}

export class TtsCache {
  private readonly memory = new Map<string, TtsCacheEntry>();
  private readonly disk = new Map<string, DiskMeta>();
  private bytes = 0;
  private diskBytes = 0;
  private readonly counters = { hits: 0, misses: 0, bypassed: 0, evictions: 0, savedMs: 0 };
  private readonly byApp = new Map<string, TtsCacheAppStats>();
  private readonly now: () => number;

  constructor(private readonly opts: TtsCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (!this.opts.dir) return;
    await mkdir(this.opts.dir, { recursive: true });
    for (const name of await readdir(this.opts.dir)) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -5);
      const meta = await readFile(join(this.opts.dir, name), 'utf8').then(t => JSON.parse(t) as DiskMeta).catch(() => null);
      if (!meta || this.now() - meta.at > this.opts.ttlMs) { await this.dropDisk(key); continue; }
      this.disk.set(key, meta);
      this.diskBytes += meta.bytes;
    }
    await this.trimDisk();
  }

  async get(key: string): Promise<TtsCacheEntry | null> {
    const now = this.now();
    const hit = this.memory.get(key);
    if (hit) {
      this.memory.delete(key);
      if (now - hit.at > this.opts.ttlMs) { this.bytes -= hit.audio.length; return null; }
      this.memory.set(key, hit);
      return hit;
    }
    const meta = this.disk.get(key);
    if (!meta || !this.opts.dir) return null;
    if (now - meta.at > this.opts.ttlMs) { await this.dropDisk(key); return null; }
    const audio = await readFile(join(this.opts.dir, `${key}.bin`)).catch(() => null);
    if (!audio || audio.length !== meta.bytes) { await this.dropDisk(key); return null; }
    const entry = { audio, contentType: meta.contentType, provider: meta.provider, synthMs: meta.synthMs, at: meta.at };
    this.remember(key, entry);
    return entry;
  }

  put(key: string, entry: Omit<TtsCacheEntry, 'at'>): boolean {
    if (!entry.audio.length || entry.audio.length > this.opts.maxEntryBytes || !audioComplete(entry.audio, entry.contentType)) return false;
    const full = { ...entry, at: this.now() };
    this.remember(key, full);
    if (this.opts.dir) void this.writeDisk(key, full);
    return true;
  }

  note(scope: string, outcome: 'hit' | 'miss' | 'bypass', savedMs = 0): void {
    const app = this.byApp.get(scope) ?? { hits: 0, misses: 0, bypassed: 0, savedMs: 0 };
    if (outcome === 'hit') { app.hits++; app.savedMs += savedMs; this.counters.hits++; this.counters.savedMs += savedMs; }
    else if (outcome === 'miss') { app.misses++; this.counters.misses++; }
    else { app.bypassed++; this.counters.bypassed++; }
    this.byApp.set(scope, app);
  }

  stats(): TtsCacheStats {
    return {
      entries: this.memory.size, bytes: this.bytes, maxBytes: this.opts.maxBytes, diskBytes: this.diskBytes, diskMaxBytes: this.opts.dir ? this.opts.diskMaxBytes : 0,
      ttlHours: this.opts.ttlMs / 3_600_000, ...this.counters, byApp: Object.fromEntries([...this.byApp].map(([k, v]) => [k, { ...v }])),
    };
  }

  private remember(key: string, entry: TtsCacheEntry): void {
    const old = this.memory.get(key);
    if (old) this.bytes -= old.audio.length;
    this.memory.delete(key);
    this.memory.set(key, entry);
    this.bytes += entry.audio.length;
    for (const [k, e] of this.memory) {
      if (this.bytes <= this.opts.maxBytes) break;
      this.memory.delete(k);
      this.bytes -= e.audio.length;
      this.counters.evictions++;
    }
  }

  private async writeDisk(key: string, entry: TtsCacheEntry): Promise<void> {
    const dir = this.opts.dir!;
    const meta: DiskMeta = { contentType: entry.contentType, provider: entry.provider, synthMs: entry.synthMs, at: entry.at, bytes: entry.audio.length };
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${key}.bin`), entry.audio);
      await writeFile(join(dir, `${key}.json`), JSON.stringify(meta));
      const old = this.disk.get(key);
      if (old) this.diskBytes -= old.bytes;
      this.disk.set(key, meta);
      this.diskBytes += meta.bytes;
      await this.trimDisk();
    } catch {
      await this.dropDisk(key);
    }
  }

  private async trimDisk(): Promise<void> {
    const oldest = [...this.disk].sort(([, a], [, b]) => a.at - b.at);
    for (const [key] of oldest) {
      if (this.diskBytes <= this.opts.diskMaxBytes) break;
      await this.dropDisk(key);
    }
  }

  private async dropDisk(key: string): Promise<void> {
    const meta = this.disk.get(key);
    if (meta) this.diskBytes -= meta.bytes;
    this.disk.delete(key);
    if (!this.opts.dir) return;
    await rm(join(this.opts.dir, `${key}.bin`), { force: true }).catch(() => {});
    await rm(join(this.opts.dir, `${key}.json`), { force: true }).catch(() => {});
  }
}
