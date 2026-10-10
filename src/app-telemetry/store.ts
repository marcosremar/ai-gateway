// ── AI Gateway — Desktop-app field telemetry: persistence ──────────────────────────────────────────────────────────
// Same choice as rooms and the unified telemetry: plain files on the gateway's volume (DEPLOYMENTS_STATE_DIR), no
// database dependency.
//
//   <dir>/YYYY-MM-DD.jsonl   one appended line per stored event, by server receive day (UTC)
//
// Retention: `sweep` deletes day files older than `retentionDays`. A day file past `maxDayBytes` refuses further
// writes (507) so a misbehaving client cannot fill the volume. `dir: null` keeps rows in memory (tests).

import { appendFile, mkdir, readdir, readFile, unlink, stat } from 'fs/promises';
import { join } from 'path';
import type { StoredAppEvent } from './validate';

const DAY_MS = 86_400_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface AppTelemetryStoreOptions {
  dir: string | null;
  retentionDays: number;
  maxDayBytes?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class AppTelemetryStoreFull extends Error {}

export class AppTelemetryStore {
  readonly retentionDays: number;
  private readonly maxDayBytes: number;
  private readonly memory: StoredAppEvent[] = [];
  /** Serializes appends (one writer per process). */
  private chain: Promise<void> = Promise.resolve();
  private daySizes = new Map<string, number>();

  constructor(private readonly opts: AppTelemetryStoreOptions) {
    this.retentionDays = opts.retentionDays;
    this.maxDayBytes = opts.maxDayBytes ?? 512 * 1024 * 1024;
  }

  get dir(): string | null { return this.opts.dir; }

  /** Appends rows (all with the same rxTs day). Throws AppTelemetryStoreFull when the day's file is at its cap. */
  append(rows: StoredAppEvent[]): Promise<void> {
    if (!rows.length) return Promise.resolve();
    if (this.opts.dir === null) { this.memory.push(...rows); return Promise.resolve(); }
    const dir = this.opts.dir;
    const text = rows.map(r => `${JSON.stringify(r)}\n`).join('');
    const op = async (): Promise<void> => {
      const day = dayOf(rows[0]!.rxTs);
      const path = join(dir, `${day}.jsonl`);
      let size = this.daySizes.get(day);
      if (size === undefined) size = (await stat(path).catch(() => null))?.size ?? 0;
      const bytes = Buffer.byteLength(text);
      if (size + bytes > this.maxDayBytes) throw new AppTelemetryStoreFull(`telemetry day file ${day} is full`);
      await mkdir(dir, { recursive: true });
      await appendFile(path, text, { mode: 0o600 });
      if (this.daySizes.size > 8) this.daySizes.clear();
      this.daySizes.set(day, size + bytes);
    };
    const next = this.chain.catch(() => {}).then(op);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Rows received in [since, until] (rxTs), oldest first. Unparseable lines are skipped. */
  async read(since: number, until: number): Promise<StoredAppEvent[]> {
    if (this.opts.dir === null) return this.memory.filter(r => r.rxTs >= since && r.rxTs <= until);
    await this.chain;
    const dir = this.opts.dir;
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const first = dayOf(since);
    const last = dayOf(until);
    const out: StoredAppEvent[] = [];
    for (const name of names.sort()) {
      const day = DAY_FILE.exec(name)?.[1];
      if (!day || day < first || day > last) continue;
      const text = await readFile(join(dir, name), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const row = JSON.parse(line) as StoredAppEvent;
          if (typeof row?.rxTs === 'number' && row.rxTs >= since && row.rxTs <= until) out.push(row);
        } catch { /* torn line */ }
      }
    }
    return out;
  }

  /** Deletes day files (or memory rows) older than the retention. Returns how many files/rows went away. */
  async sweep(now: number): Promise<number> {
    const cutoffMs = now - this.retentionDays * DAY_MS;
    if (this.opts.dir === null) {
      const before = this.memory.length;
      const keep = this.memory.filter(r => r.rxTs >= cutoffMs);
      this.memory.length = 0;
      this.memory.push(...keep);
      return before - keep.length;
    }
    const cutoff = dayOf(cutoffMs);
    let names: string[];
    try { names = await readdir(this.opts.dir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      const day = DAY_FILE.exec(name)?.[1];
      if (!day || day >= cutoff) continue;
      await unlink(join(this.opts.dir, name)).then(() => { removed++; }, (err: unknown) => {
        this.opts.log?.('app telemetry: sweep failed', { file: name, error: err instanceof Error ? err.message : String(err) });
      });
      this.daySizes.delete(day);
    }
    return removed;
  }
}
