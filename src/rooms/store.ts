// ── AI Gateway — Live subtitle rooms: persistence ────────────────────────────
// Same choice as the rest of the gateway's durable state (deployments.json, apps, telemetry): files in
// `DEPLOYMENTS_STATE_DIR` (the Railway volume), no database dependency in src/.
//
//   <dir>/<CODE>.json         room meta (state-file.ts: tmp + fsync + rename, last good copy in `.bak`)
//   <dir>/<CODE>.lines.jsonl  one appended record per published line; a re-sent id appends again and the
//                             last record of an id wins when the file is read back (idempotent publish)
//
// Audio clips are never stored. Expiry: `sweepExpired` deletes the files of rooms whose last activity (meta field
// or the newest file mtime) is older than the retention.

import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { readStateFile, writeStateFile } from '../deployments/state-file';
import type { RoomLine, RoomMeta } from './types';

const META_FILE = /^([A-Z0-9]{4,16})\.json$/;

export interface RoomStore {
  exists(code: string): Promise<boolean>;
  /** The room with `meta.lastActivityAt` as the newest known activity; null when unknown or unreadable. */
  load(code: string): Promise<{ meta: RoomMeta; lines: RoomLine[] } | null>;
  saveMeta(meta: RoomMeta): Promise<void>;
  appendLine(code: string, line: RoomLine): Promise<void>;
  remove(code: string): Promise<void>;
  /** Deletes rooms idle for longer than `retentionMs`; returns their codes. Skips `keep` (rooms held in memory). */
  sweepExpired(now: number, retentionMs: number, keep: (code: string) => boolean): Promise<string[]>;
}

/** Lines read back: the last record of each id wins, ordered by id. Bad lines are skipped. */
export function linesFromJsonl(text: string): RoomLine[] {
  const byId = new Map<number, RoomLine>();
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let rec: Partial<RoomLine>;
    try { rec = JSON.parse(raw) as Partial<RoomLine>; } catch { continue; }
    if (!rec || typeof rec.id !== 'number' || typeof rec.original !== 'string') continue;
    byId.set(rec.id, {
      id: rec.id,
      original: rec.original,
      originalLang: typeof rec.originalLang === 'string' ? rec.originalLang : null,
      translations: rec.translations && typeof rec.translations === 'object' ? rec.translations : {},
      ts: typeof rec.ts === 'number' ? rec.ts : 0,
    });
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The on-disk record of a line: its fields rebuilt one by one (never the raw request body). */
function lineRecord(line: RoomLine): string {
  const translations: Record<string, string> = {};
  for (const [k, v] of Object.entries(line.translations)) translations[k] = v;
  return `${JSON.stringify({ id: line.id, original: line.original, originalLang: line.originalLang, translations, ts: line.ts })}\n`;
}

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, { meta: RoomMeta; lines: Map<number, RoomLine> }>();

  async exists(code: string) { return this.rooms.has(code); }
  async load(code: string) {
    const r = this.rooms.get(code);
    if (!r) return null;
    return { meta: structuredClone(r.meta), lines: [...r.lines.values()].sort((a, b) => a.id - b.id).map(l => structuredClone(l)) };
  }
  async saveMeta(meta: RoomMeta) {
    const r = this.rooms.get(meta.code);
    if (r) r.meta = structuredClone(meta);
    else this.rooms.set(meta.code, { meta: structuredClone(meta), lines: new Map() });
  }
  async appendLine(code: string, line: RoomLine) { this.rooms.get(code)?.lines.set(line.id, structuredClone(line)); }
  async remove(code: string) { this.rooms.delete(code); }
  async sweepExpired(now: number, retentionMs: number, keep: (code: string) => boolean) {
    const gone: string[] = [];
    for (const [code, r] of this.rooms) {
      if (keep(code) || now - r.meta.lastActivityAt <= retentionMs) continue;
      this.rooms.delete(code);
      gone.push(code);
    }
    return gone;
  }
}

export class FileRoomStore implements RoomStore {
  /** Appends and meta writes of one room, serialized. */
  private chains = new Map<string, Promise<void>>();

  constructor(private readonly dir: string, private readonly log: (msg: string, data?: Record<string, unknown>) => void = () => {}) {}

  private metaPath(code: string) { return join(this.dir, `${code}.json`); }
  private linesPath(code: string) { return join(this.dir, `${code}.lines.jsonl`); }

  private serialize(code: string, op: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(code) ?? Promise.resolve()).catch(() => {}).then(op);
    const tail = next.catch(() => {});
    this.chains.set(code, tail);
    void tail.then(() => { if (this.chains.get(code) === tail) this.chains.delete(code); });
    return next;
  }

  async exists(code: string): Promise<boolean> {
    return stat(this.metaPath(code)).then(() => true, () => false);
  }

  async load(code: string): Promise<{ meta: RoomMeta; lines: RoomLine[] } | null> {
    const read = await readStateFile<RoomMeta>(this.metaPath(code)).catch((err: unknown) => {
      this.log('rooms: meta unreadable', { code, error: err instanceof Error ? err.message : String(err) });
      return { data: null, from: 'none' as const };
    });
    const meta = read.data;
    if (!meta || meta.code !== code || typeof meta.tokenHash !== 'string') return null;
    const text = await readFile(this.linesPath(code), 'utf8').catch(() => '');
    // Lines append without rewriting the meta: the file's mtime is the room's last activity when newer.
    const linesAt = (await stat(this.linesPath(code)).catch(() => null))?.mtimeMs ?? 0;
    return { meta: { ...meta, lastActivityAt: Math.max(meta.lastActivityAt, Math.floor(linesAt)) }, lines: linesFromJsonl(text) };
  }

  saveMeta(meta: RoomMeta): Promise<void> {
    const text = JSON.stringify(meta);
    return this.serialize(meta.code, () => writeStateFile(this.metaPath(meta.code), text));
  }

  appendLine(code: string, line: RoomLine): Promise<void> {
    const record = lineRecord(line);
    return this.serialize(code, async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.linesPath(code), record, { mode: 0o600 });
    });
  }

  remove(code: string): Promise<void> {
    return this.serialize(code, async () => {
      for (const p of [this.metaPath(code), `${this.metaPath(code)}.bak`, this.linesPath(code)]) await unlink(p).catch(() => {});
    });
  }

  async sweepExpired(now: number, retentionMs: number, keep: (code: string) => boolean): Promise<string[]> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return []; }
    const gone: string[] = [];
    for (const name of names) {
      const code = META_FILE.exec(name)?.[1];
      if (!code || keep(code)) continue;
      const last = await this.lastActivity(code);
      if (last === null || now - last <= retentionMs) continue;
      await this.remove(code);
      gone.push(code);
    }
    return gone;
  }

  /**
   * Newest of the meta's `lastActivityAt` and the lines file's mtime (lines append without rewriting the meta). An
   * unreadable meta falls back to its own mtime, so a broken room still expires.
   */
  private async lastActivity(code: string): Promise<number | null> {
    const times: number[] = [];
    const linesAt = await stat(this.linesPath(code)).catch(() => null);
    if (linesAt) times.push(linesAt.mtimeMs);
    const read = await readStateFile<RoomMeta>(this.metaPath(code)).catch(() => null);
    if (typeof read?.data?.lastActivityAt === 'number') times.push(read.data.lastActivityAt);
    else {
      const metaAt = await stat(this.metaPath(code)).catch(() => null);
      if (metaAt) times.push(metaAt.mtimeMs);
    }
    return times.length ? Math.max(...times) : null;
  }
}
