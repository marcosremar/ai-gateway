// ── AI Gateway — ucast.me accounts: usage metering ──────────────────────────
// Counters per UTC day, per user and per activation key, kept in `account-usage.json` (debounced atomic writes, the
// house state-file pattern). Monthly totals (quota) are sums of the month's days.

import { readStateFile, writeStateFile } from '../deployments/state-file';

export const COUNTERS = ['requests', 'sttRequests', 'audioSeconds', 'llmRequests', 'llmTokens', 'ttsRequests', 'ttsChars', 'ttsSeconds', 'rooms'] as const;
export type Counter = typeof COUNTERS[number];
export type Counters = Record<Counter, number>;

export const zeroCounters = (): Counters => Object.fromEntries(COUNTERS.map(c => [c, 0])) as Counters;

const DAY_MS = 86_400_000;
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
/** First instant of the next UTC month. */
export const nextMonthStart = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
export const nextDayStart = (ms: number): number => (Math.floor(ms / DAY_MS) + 1) * DAY_MS;

/** day → userId → keyId → counters */
type Rows = Record<string, Record<string, Record<string, Partial<Counters>>>>;

function add(into: Counters, from: Partial<Counters>): Counters {
  for (const c of COUNTERS) into[c] += from[c] ?? 0;
  return into;
}

function round(c: Counters): Counters {
  for (const k of COUNTERS) c[k] = Math.round(c[k] * 100) / 100;
  return c;
}

export class UsageMeter {
  private rows: Rows = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly opts: {
    path: string | null; retentionDays: number; now: () => number;
    log?: (msg: string, data?: Record<string, unknown>) => void;
  }) {}

  async load(): Promise<void> {
    if (!this.opts.path) return;
    const read = await readStateFile<{ version: 1; days: Rows }>(this.opts.path);
    if (read.from === 'backup') this.opts.log?.('accounts: USAGE FILE UNREADABLE, recovered from the last good backup', { problem: read.problem });
    this.rows = read.data?.days ?? {};
  }

  record(userId: string, keyId: string, delta: Partial<Counters>): void {
    const day = dayOf(this.opts.now());
    const byUser = ((this.rows[day] ??= {})[userId] ??= {});
    const row = (byUser[keyId] ??= {});
    for (const c of COUNTERS) {
      const v = delta[c];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) row[c] = (row[c] ?? 0) + v;
    }
    this.schedule();
  }

  /** Totals of a user over the days `from`..`to` (inclusive, YYYY-MM-DD). */
  private total(userId: string, pick: (day: string) => boolean, keyId?: string): Counters {
    const out = zeroCounters();
    for (const [day, users] of Object.entries(this.rows)) {
      if (!pick(day)) continue;
      for (const [k, row] of Object.entries(users[userId] ?? {})) if (!keyId || k === keyId) add(out, row);
    }
    return round(out);
  }

  month(userId: string): Counters {
    const m = monthOf(this.opts.now());
    return this.total(userId, d => d.startsWith(m));
  }

  today(userId: string): Counters {
    const d = dayOf(this.opts.now());
    return this.total(userId, x => x === d);
  }

  /** Daily rows of the last `days` days (oldest first, zero days included) and per-key totals over the same range. */
  report(userId: string, days: number): { days: Array<{ day: string } & Counters>; byKey: Record<string, Counters> } {
    const now = this.opts.now();
    const list: Array<{ day: string } & Counters> = [];
    const byKey: Record<string, Counters> = {};
    for (let i = days - 1; i >= 0; i--) {
      const day = dayOf(now - i * DAY_MS);
      const total = zeroCounters();
      for (const [keyId, row] of Object.entries(this.rows[day]?.[userId] ?? {})) {
        add(total, row);
        add((byKey[keyId] ??= zeroCounters()), row);
      }
      list.push({ day, ...round(total) });
    }
    for (const k of Object.keys(byKey)) round(byKey[k]!);
    return { days: list, byKey };
  }

  private schedule(): void {
    if (!this.opts.path || this.timer) return;
    this.timer = setTimeout(() => { void this.flush(); }, 2000);
    this.timer.unref?.();
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const path = this.opts.path;
    if (!path) return Promise.resolve();
    const oldest = dayOf(this.opts.now() - this.opts.retentionDays * DAY_MS);
    for (const day of Object.keys(this.rows)) if (day < oldest) delete this.rows[day];
    const text = JSON.stringify({ version: 1, days: this.rows });
    this.saving = this.saving.catch(() => {}).then(() => writeStateFile(path, text)).catch((err: unknown) => {
      this.opts.log?.('accounts: USAGE WRITE FAILED', { error: err instanceof Error ? err.message : String(err) });
    });
    return this.saving;
  }
}

// ── Measuring a request ─────────────────────────────────────────────────────

/** Duration of a PCM/any WAV buffer in seconds (header's byte rate and data size), or null when not a WAV. */
export function wavSeconds(buf: Buffer): number | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let byteRate = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 16 <= buf.length) byteRate = buf.readUInt32LE(pos + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const available = buf.length - pos - 8;
      return Math.min(size, available) / byteRate;
    }
    if (size === 0xFFFFFFFF) return null;
    pos += 8 + size + (size & 1);
  }
  return null;
}

/** Audio seconds of an upload: the WAV header when it is one, else ~128 kbit/s compressed audio. */
export function audioSecondsOf(file: Buffer, response?: unknown): number {
  const reported = response && typeof response === 'object' ? (response as { duration?: unknown }).duration : undefined;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return reported;
  return wavSeconds(file) ?? file.length / 16_000;
}

/** LLM tokens: the provider's `usage.total_tokens` when present, else prompt characters / 4. */
export function llmTokensOf(body: Record<string, unknown>, response?: unknown): number {
  const usage = response && typeof response === 'object' ? (response as { usage?: { total_tokens?: unknown } }).usage : undefined;
  if (typeof usage?.total_tokens === 'number' && Number.isFinite(usage.total_tokens)) return usage.total_tokens;
  return Math.ceil(JSON.stringify(body.messages ?? '').length / 4);
}
