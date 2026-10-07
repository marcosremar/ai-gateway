/**
 * Telemetry storage. Same choice as the rest of the gateway's durable state (deployments.json, apps, the SDK
 * stability log): files in `DEPLOYMENTS_STATE_DIR` (a mounted volume on Railway), no database dependency in src/.
 *
 *   - in memory: the last `maxRows` events (TELEMETRY_MAX_ROWS, default 200 000), what every query reads;
 *   - on disk (when `dir` is set): one JSONL file per UTC day of receive time, `<dir>/YYYY-MM-DD.jsonl`, appended
 *     (serialized, best-effort: a failed write never fails the ingest), re-read at boot within the retention;
 *   - retention: rows and day files older than TELEMETRY_RETENTION_DAYS (default 14) are removed by `cleanup()`
 *     (hourly once `start()`ed); the day files are also capped by TELEMETRY_MAX_DISK_MB (default 256, oldest first).
 *
 * What goes to disk is a rebuilt copy holding only the contract's fields (CodeQL js/http-to-file-access): the events
 * were already validated by the schema and scrubbed (scrub.ts) before they reach `insert`.
 */

import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'fs/promises';
import { join } from 'path';
import {
  TELEMETRY_LEVELS, TELEMETRY_SOURCES, type StoredTelemetryEvent, type TelemetryAttrs,
} from './contract';

const DAY_MS = 86_400_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface TelemetryStoreOptions {
  /** Directory of the day files; absent = memory only. */
  dir?: string;
  retentionDays?: number;
  maxRows?: number;
  maxDiskBytes?: number;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Called with each stored row (OTLP forward, see http.ts). Errors are swallowed. */
  onStored?: (row: StoredTelemetryEvent) => void;
}

export type NewTelemetryRow = Omit<StoredTelemetryEvent, 'seq'>;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const str = (v: unknown, max = 128): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The on-disk record: contract fields only, rebuilt one by one. */
export function fileRow(row: StoredTelemetryEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seq: row.seq, ts: row.ts, rxTs: row.rxTs, source: row.source, level: row.level, event: row.event, traceId: row.traceId,
  };
  for (const k of ['sessionId', 'turnId', 'replicaId', 'deployment', 'app'] as const) if (row[k] !== undefined) out[k] = row[k];
  if (row.durMs !== undefined) out.durMs = row.durMs;
  if (row.attrs) {
    const attrs: TelemetryAttrs = {};
    for (const [k, v] of Object.entries(row.attrs)) attrs[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    out.attrs = attrs;
  }
  return out;
}

/** A row read back from disk, or null when the line is not one we wrote. */
export function parseFileRow(line: string): StoredTelemetryEvent | null {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const seq = num(raw.seq); const ts = num(raw.ts); const rxTs = num(raw.rxTs);
  const source = TELEMETRY_SOURCES.find(s => s === raw.source);
  const level = TELEMETRY_LEVELS.find(l => l === raw.level);
  const event = str(raw.event, 64); const traceId = str(raw.traceId, 32);
  if (seq === undefined || ts === undefined || rxTs === undefined || !source || !level || !event || !traceId) return null;
  const row: StoredTelemetryEvent = { seq, ts, rxTs, source, level, event, traceId };
  for (const k of ['sessionId', 'turnId', 'replicaId', 'deployment', 'app'] as const) {
    const v = str(raw[k]);
    if (v !== undefined) row[k] = v;
  }
  const durMs = num(raw.durMs);
  if (durMs !== undefined) row.durMs = durMs;
  if (raw.attrs && typeof raw.attrs === 'object' && !Array.isArray(raw.attrs)) {
    const attrs: TelemetryAttrs = {};
    for (const [k, v] of Object.entries(raw.attrs as Record<string, unknown>)) {
      if (v === null || typeof v === 'boolean' || num(v) !== undefined || str(v, 200) !== undefined) attrs[k] = v as TelemetryAttrs[string];
    }
    row.attrs = attrs;
  }
  return row;
}

export class TelemetryStore {
  private data: StoredTelemetryEvent[] = [];
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly retentionMs: number;
  readonly maxRows: number;
  readonly maxDiskBytes: number;
  private readonly now: () => number;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;
  /** Rows pushed out by the row cap before their retention ran out (`maxRows` too small for the traffic). */
  evictedByCap = 0;

  constructor(private readonly opts: TelemetryStoreOptions = {}) {
    this.retentionMs = Math.max(1, opts.retentionDays ?? 14) * DAY_MS;
    this.maxRows = Math.max(100, opts.maxRows ?? 200_000);
    this.maxDiskBytes = Math.max(1024 * 1024, opts.maxDiskBytes ?? 256 * 1024 * 1024);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** Re-reads the day files within the retention (memory keeps the newest `maxRows`). */
  async init(): Promise<void> {
    const dir = this.opts.dir;
    if (!dir) return;
    const cutoffDay = dayOf(this.now() - this.retentionMs);
    let names: string[] = [];
    try { names = (await readdir(dir)).filter(n => DAY_FILE.test(n)).sort(); } catch { return; }
    const rows: StoredTelemetryEvent[] = [];
    for (const name of names) {
      if (name.slice(0, 10) < cutoffDay) continue;
      const text = await readFile(join(dir, name), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        const row = line ? parseFileRow(line) : null;
        if (row) rows.push(row);
      }
    }
    rows.sort((a, b) => a.seq - b.seq);
    const cutoff = this.now() - this.retentionMs;
    this.data = rows.filter(r => r.rxTs >= cutoff).slice(-this.maxRows);
    this.seq = rows.reduce((m, r) => Math.max(m, r.seq), 0);
    this.log('telemetry: loaded', { rows: this.data.length, files: names.length });
  }

  insert(rows: NewTelemetryRow[]): StoredTelemetryEvent[] {
    const stored = rows.map(r => ({ ...r, seq: ++this.seq }));
    this.data.push(...stored);
    // Trim in steps (not one splice per insert): the array may run ≤ 10 % over the cap between trims.
    if (this.data.length > this.maxRows * 1.1) {
      const extra = this.data.length - this.maxRows;
      this.evictedByCap += extra;
      this.data.splice(0, extra);
    }
    this.persist(stored);
    if (this.opts.onStored) for (const row of stored) { try { this.opts.onStored(row); } catch { /* best effort */ } }
    return stored;
  }

  /** Rows in insertion (seq) order, oldest first. Read-only view for the query functions. */
  rows(): readonly StoredTelemetryEvent[] {
    return this.data;
  }

  get size(): number {
    return this.data.length;
  }

  /** Removes rows and day files past the retention, then the oldest files over the disk cap. */
  async cleanup(): Promise<{ removedRows: number; removedFiles: number }> {
    const cutoff = this.now() - this.retentionMs;
    const before = this.data.length;
    const firstKept = this.data.findIndex(r => r.rxTs >= cutoff);
    this.data.splice(0, firstKept < 0 ? this.data.length : firstKept);
    const removedRows = before - this.data.length;
    let removedFiles = 0;
    const dir = this.opts.dir;
    if (dir) {
      await this.chain;
      let names: string[] = [];
      try { names = (await readdir(dir)).filter(n => DAY_FILE.test(n)).sort(); } catch { names = []; }
      const cutoffDay = dayOf(cutoff);
      const kept: Array<{ name: string; size: number }> = [];
      for (const name of names) {
        if (name.slice(0, 10) < cutoffDay) {
          if (await unlink(join(dir, name)).then(() => true, () => false)) removedFiles++;
        } else {
          kept.push({ name, size: (await stat(join(dir, name)).catch(() => null))?.size ?? 0 });
        }
      }
      let total = kept.reduce((s, f) => s + f.size, 0);
      // Over the disk cap: drop whole days, oldest first, never today's file.
      for (const f of kept.slice(0, -1)) {
        if (total <= this.maxDiskBytes) break;
        if (await unlink(join(dir, f.name)).then(() => true, () => false)) { removedFiles++; total -= f.size; }
      }
    }
    if (removedRows || removedFiles) this.log('telemetry: retention cleanup', { removedRows, removedFiles });
    return { removedRows, removedFiles };
  }

  start(intervalMs = 3_600_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.cleanup().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves when every pending disk write has settled (tests, shutdown). */
  flushed(): Promise<void> {
    return this.chain;
  }

  private persist(rows: StoredTelemetryEvent[]): void {
    const dir = this.opts.dir;
    if (!dir || !rows.length) return;
    const byDay = new Map<string, string[]>();
    for (const row of rows) {
      const day = dayOf(row.rxTs);
      const lines = byDay.get(day) ?? [];
      lines.push(JSON.stringify(fileRow(row)));
      byDay.set(day, lines);
    }
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(dir, { recursive: true });
        for (const [day, lines] of byDay) await appendFile(join(dir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
      } catch (err) {
        this.log('telemetry: could not persist', { error: String((err as Error).message ?? err).slice(0, 120) });
      }
    });
  }
}
