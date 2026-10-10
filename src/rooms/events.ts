// ── AI Gateway — Live subtitle rooms: viewer analytics events ────────────────
// The viewer page batches anonymous interaction events (join, settings changes, dubbing, periodic delay/drift
// samples, visibility, leave) to the public `POST /v1/rooms/:code/events`; admins read them back raw
// (`GET /v1/rooms/:code/events`) or aggregated (`GET /v1/rooms-analytics`). See docs/rooms.md.
//
// Privacy: a random viewerId the page keeps in localStorage, no account, no IP stored (a salted hash of the IP lives
// in memory only, for the rate limit). Events outlive room content: ROOM_EVENTS_RETENTION_DAYS (365).
//
//   <dir>/events/<YYYY-MM-DD>/<CODE>.jsonl   one record per accepted event, UTC day of receipt
// Expiry drops whole day directories older than the retention.

import { createHash, randomBytes } from 'crypto';
import { appendFile, mkdir, readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { RoomError } from './validate';

// ── Schema ──────────────────────────────────────────────────────────────────

export const EVENT_TYPES = ['join', 'setting', 'audio', 'sample', 'visibility', 'ui', 'leave'] as const;
export type ViewerEventType = typeof EVENT_TYPES[number];

type FieldSpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'num'; min: number; max: number }
  | { kind: 'bool' }
  | { kind: 'str'; max: number }
  | { kind: 'langs' }
  | { kind: 'value' }
  | { kind: 'settings' };

const LANG_RE = /^(orig|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2})$/;
const MS = { kind: 'int', min: 0, max: 86_400_000 } as const;
const DELAY = { kind: 'int', min: -600_000, max: 600_000 } as const;
const COUNT = { kind: 'int', min: 0, max: 1_000_000 } as const;

/** Setting keys a viewer can change (page settings + language + dubbing). */
export const SETTING_KEYS = ['lang', 'mode', 'showOrig', 'dub', 'volume', 'sync', 'size', 'theme', 'autoScroll', 'showTimes', 'showDelay'] as const;

/** Allowed fields per event type; anything else is dropped. */
export const EVENT_SCHEMA: Record<ViewerEventType, Record<string, FieldSpec>> = {
  join: {
    ua: { kind: 'enum', values: ['chrome', 'safari', 'firefox', 'edge', 'samsung', 'opera', 'other'] },
    os: { kind: 'enum', values: ['ios', 'android', 'windows', 'macos', 'linux', 'chromeos', 'other'] },
    device: { kind: 'enum', values: ['mobile', 'tablet', 'desktop'] },
    vw: { kind: 'int', min: 0, max: 20_000 },
    vh: { kind: 'int', min: 0, max: 20_000 },
    dpr: { kind: 'num', min: 0, max: 10 },
    lang: { kind: 'str', max: 35 },
    langs: { kind: 'langs' },
    ref: { kind: 'enum', values: ['qr', 'direct', 'link'] },
    returning: { kind: 'bool' },
    settings: { kind: 'settings' },
  },
  setting: {
    key: { kind: 'enum', values: SETTING_KEYS },
    value: { kind: 'value' },
    from: { kind: 'enum', values: ['toolbar', 'sheet', 'auto'] },
  },
  audio: {
    action: { kind: 'enum', values: ['play', 'pause', 'mute', 'unmute', 'gap', 'drop', 'decode_error', 'unsupported'] },
    ms: MS,
    n: COUNT,
  },
  sample: {
    textDelayMs: DELAY, voiceDelayMs: DELAY, driftMs: DELAY, lagMs: DELAY,
    queueMs: MS, gaps: COUNT, gapMs: MS, drops: COUNT, clips: COUNT, lines: COUNT, visible: { kind: 'bool' },
  },
  visibility: { state: { kind: 'enum', values: ['hidden', 'visible'] } },
  ui: { action: { kind: 'enum', values: ['copy', 'sheet_open', 'sheet_close', 'more', 'reconnect', 'ended'] } },
  leave: { durationMs: MS, visibleMs: MS, reason: { kind: 'enum', values: ['pagehide', 'unload', 'ended'] } },
};

/** An event without this (valid) field carries nothing: dropped. */
const REQUIRED: Partial<Record<ViewerEventType, string>> = { audio: 'action', ui: 'action', visibility: 'state' };

const SETTINGS_SNAPSHOT_KEYS: Record<string, FieldSpec> = {
  lang: { kind: 'str', max: 35 },
  mode: { kind: 'enum', values: ['translation', 'transcript', 'bilingual', 'full'] },
  showOrig: { kind: 'bool' }, dub: { kind: 'bool' }, volume: { kind: 'num', min: 0, max: 1 }, sync: { kind: 'bool' },
  size: { kind: 'int', min: -10, max: 10 }, theme: { kind: 'enum', values: ['dark', 'light', 'auto'] },
  autoScroll: { kind: 'bool' }, showTimes: { kind: 'bool' }, showDelay: { kind: 'bool' },
};

/** One stored event. `ts` = server receipt (ms), `t` = the viewer's clock (ms). */
export interface ViewerEventRecord {
  ts: number;
  t: number;
  code: string;
  viewerId: string;
  sessionId: string;
  type: ViewerEventType;
  data: Record<string, unknown>;
}

export interface EventBatch { viewerId: string; sessionId: string; events: Array<{ t: number; type: ViewerEventType; data: Record<string, unknown> }>; dropped: number }

export const MAX_EVENTS_PER_BATCH = 200;
export const EVENTS_MAX_BYTES = 64 * 1024;
const ID_RE = /^[vs]_[A-Za-z0-9_-]{8,40}$/;
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function field(spec: FieldSpec, v: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (spec.kind) {
    case 'enum': return typeof v === 'string' && spec.values.includes(v) ? { ok: true, value: v } : { ok: false };
    case 'int': return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max ? { ok: true, value: Math.round(v) } : { ok: false };
    case 'num': return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max ? { ok: true, value: Math.round(v * 1000) / 1000 } : { ok: false };
    case 'bool': return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false };
    case 'str': return typeof v === 'string' && v.length <= spec.max ? { ok: true, value: v } : { ok: false };
    case 'langs': {
      if (!Array.isArray(v)) return { ok: false };
      const out = v.filter((x): x is string => typeof x === 'string' && x.length <= 35).slice(0, 8);
      return { ok: true, value: out };
    }
    case 'value': {
      if (typeof v === 'boolean') return { ok: true, value: v };
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000) return { ok: true, value: Math.round(v * 1000) / 1000 };
      if (typeof v === 'string' && v.length <= 35) return { ok: true, value: v };
      return { ok: false };
    }
    case 'settings': {
      if (!isObject(v)) return { ok: false };
      return { ok: true, value: pick(SETTINGS_SNAPSHOT_KEYS, v) };
    }
  }
}

function pick(schema: Record<string, FieldSpec>, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(schema)) {
    if (!(k in raw)) continue;
    const r = field(spec, raw[k]);
    if (r.ok) out[k] = r.value;
  }
  return out;
}

/**
 * Validates a batch: `{viewerId, sessionId, events: [{t, type, ...fields}]}`. The envelope must be right (else 400);
 * events of an unknown type or without a timestamp are dropped (counted), unknown/invalid fields are dropped.
 * A setting event keeps only a value valid for its key.
 */
export function parseEventBatch(body: unknown): EventBatch {
  if (!isObject(body)) throw new RoomError(400, 'body must be a JSON object');
  const { viewerId, sessionId, events } = body;
  if (typeof viewerId !== 'string' || !ID_RE.test(viewerId) || !viewerId.startsWith('v_')) throw new RoomError(400, 'viewerId must look like "v_<random>"');
  if (typeof sessionId !== 'string' || !ID_RE.test(sessionId) || !sessionId.startsWith('s_')) throw new RoomError(400, 'sessionId must look like "s_<random>"');
  if (!Array.isArray(events)) throw new RoomError(400, 'events must be an array');
  if (events.length > MAX_EVENTS_PER_BATCH) throw new RoomError(413, `at most ${MAX_EVENTS_PER_BATCH} events per batch`);
  const out: EventBatch['events'] = [];
  let dropped = 0;
  for (const e of events) {
    if (!isObject(e) || typeof e.type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(e.type)
      || typeof e.t !== 'number' || !Number.isFinite(e.t) || e.t < 0) { dropped++; continue; }
    const type = e.type as ViewerEventType;
    const data = pick(EVENT_SCHEMA[type], e);
    if (type === 'setting' && !validSettingValue(data.key, data.value)) { dropped++; continue; }
    const required = REQUIRED[type];
    if (required && !(required in data)) { dropped++; continue; }
    out.push({ t: Math.floor(e.t), type, data });
  }
  return { viewerId, sessionId, events: out, dropped };
}

function validSettingValue(key: unknown, value: unknown): boolean {
  if (typeof key !== 'string') return false;
  if (key === 'lang') return typeof value === 'string' && LANG_RE.test(value);
  if (key === 'dub') return typeof value === 'boolean';
  const spec = SETTINGS_SNAPSHOT_KEYS[key];
  return spec ? field(spec, value).ok : false;
}

// ── Rate limit (memory only) ────────────────────────────────────────────────

/** Fixed one-minute windows per key. The IP key is a salted hash (salt regenerated per process) — never stored. */
export class EventRateLimiter {
  private windows = new Map<string, { start: number; n: number }>();
  private readonly salt = randomBytes(16);

  constructor(private readonly perViewerPerMin: number, private readonly perIpPerMin: number, private readonly now: () => number = Date.now) {}

  ipKey(ip: string): string { return createHash('sha256').update(this.salt).update(ip).digest('base64url').slice(0, 16); }

  /** Throws 429 when either the viewer or the IP is over its budget; else counts the batch. */
  admit(viewerId: string, ip: string): void {
    const t = this.now();
    const keys: Array<[string, number]> = [[`v:${viewerId}`, this.perViewerPerMin], [`i:${this.ipKey(ip)}`, this.perIpPerMin]];
    for (const [k, max] of keys) {
      const w = this.windows.get(k);
      if (w && t - w.start < 60_000 && w.n >= max) throw new RoomError(429, 'too many event batches, slow down');
    }
    for (const [k] of keys) {
      const w = this.windows.get(k);
      if (!w || t - w.start >= 60_000) this.windows.set(k, { start: t, n: 1 }); else w.n++;
    }
    if (this.windows.size > 50_000) for (const [k, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(k);
  }
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface EventStore {
  append(records: ViewerEventRecord[]): Promise<void>;
  /** Events of one room (oldest first), received at or after `since`. */
  read(code: string, since: number): Promise<ViewerEventRecord[]>;
  /** Every event received at or after `since`. */
  readAll(since: number): Promise<ViewerEventRecord[]>;
  /** Deletes events received before `cutoff` (whole days); returns how many day buckets went. */
  sweep(cutoff: number): Promise<number>;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
const CODE_FILE = /^([A-Z0-9]{4,16})\.jsonl$/;

export class MemoryEventStore implements EventStore {
  readonly records: ViewerEventRecord[] = [];
  async append(records: ViewerEventRecord[]) { this.records.push(...records.map(r => structuredClone(r))); }
  async read(code: string, since: number) { return this.records.filter(r => r.code === code && r.ts >= since); }
  async readAll(since: number) { return this.records.filter(r => r.ts >= since); }
  async sweep(cutoff: number) {
    const keepFrom = day(cutoff);
    const before = new Set(this.records.filter(r => day(r.ts) < keepFrom).map(r => day(r.ts)));
    for (let i = this.records.length - 1; i >= 0; i--) if (day(this.records[i]!.ts) < keepFrom) this.records.splice(i, 1);
    return before.size;
  }
}

function parseJsonl(text: string): ViewerEventRecord[] {
  const out: ViewerEventRecord[] = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    try {
      const r = JSON.parse(raw) as ViewerEventRecord;
      if (r && typeof r.ts === 'number' && typeof r.type === 'string') out.push(r);
    } catch { /* torn line */ }
  }
  return out;
}

export class FileEventStore implements EventStore {
  constructor(private readonly dir: string) {}

  async append(records: ViewerEventRecord[]): Promise<void> {
    const groups = new Map<string, string>();
    for (const r of records) {
      const p = join(this.dir, day(r.ts), `${r.code}.jsonl`);
      groups.set(p, (groups.get(p) ?? '') + `${JSON.stringify(r)}\n`);
    }
    for (const [p, text] of groups) {
      await mkdir(join(p, '..'), { recursive: true });
      await appendFile(p, text, { mode: 0o600 });
    }
  }

  private async days(since: number): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const from = day(since);
    return names.filter(n => DAY_DIR.test(n) && n >= from).sort();
  }

  async read(code: string, since: number): Promise<ViewerEventRecord[]> {
    const out: ViewerEventRecord[] = [];
    for (const d of await this.days(since)) {
      const text = await readFile(join(this.dir, d, `${code}.jsonl`), 'utf8').catch(() => '');
      for (const r of parseJsonl(text)) if (r.ts >= since) out.push(r);
    }
    return out;
  }

  async readAll(since: number): Promise<ViewerEventRecord[]> {
    const out: ViewerEventRecord[] = [];
    for (const d of await this.days(since)) {
      const files = await readdir(join(this.dir, d)).catch(() => [] as string[]);
      for (const f of files) {
        if (!CODE_FILE.test(f)) continue;
        const text = await readFile(join(this.dir, d, f), 'utf8').catch(() => '');
        for (const r of parseJsonl(text)) if (r.ts >= since) out.push(r);
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  async sweep(cutoff: number): Promise<number> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const keepFrom = day(cutoff);
    let n = 0;
    for (const d of names) {
      if (!DAY_DIR.test(d) || d >= keepFrom) continue;
      await rm(join(this.dir, d), { recursive: true, force: true });
      n++;
    }
    return n;
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface RoomsAnalytics {
  from: string;
  to: string;
  events: number;
  rooms: number;
  viewers: number;
  sessions: number;
  returningViewers: number;
  avgWatchMs: number | null;
  medianWatchMs: number | null;
  devices: Record<string, number>;
  browsers: Record<string, number>;
  referrers: Record<string, number>;
  /** Final language per session. */
  languages: Record<string, number>;
  /** Final mode per session. */
  modes: Record<string, number>;
  /** Sessions that turned dubbing on at least once. */
  dubbingSessions: number;
  /** How many times each setting was changed. */
  settingChanges: Record<string, number>;
  textDelayMs: Percentiles;
  voiceDelayMs: Percentiles;
  driftMs: Percentiles;
  audio: { gaps: number; gapMs: number; drops: number; decodeErrors: number };
}

export interface Percentiles { n: number; p50: number | null; p95: number | null }

export function percentiles(values: number[]): Percentiles {
  if (!values.length) return { n: 0, p50: null, p95: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95) };
}

const inc = (m: Record<string, number>, k: unknown) => { const key = typeof k === 'string' || typeof k === 'number' || typeof k === 'boolean' ? String(k) : 'unknown'; m[key] = (m[key] ?? 0) + 1; };

/** Aggregates over events (any order). A session's watch time is its `leave.durationMs`, else last − first event. */
export function aggregateEvents(records: ViewerEventRecord[], from: number, to: number): RoomsAnalytics {
  const sessions = new Map<string, { first: number; last: number; leave: number | null; lang?: string; mode?: string; dub: boolean; device?: string; ua?: string; ref?: string }>();
  const rooms = new Set<string>();
  const viewers = new Set<string>();
  const returning = new Set<string>();
  const settingChanges: Record<string, number> = {};
  const text: number[] = [], voice: number[] = [], drift: number[] = [];
  const audio = { gaps: 0, gapMs: 0, drops: 0, decodeErrors: 0 };
  const sorted = [...records].sort((a, b) => a.ts - b.ts || a.t - b.t);
  for (const r of sorted) {
    rooms.add(r.code);
    viewers.add(r.viewerId);
    const key = `${r.code}/${r.sessionId}`;
    let s = sessions.get(key);
    if (!s) { s = { first: r.t, last: r.t, leave: null, dub: false }; sessions.set(key, s); }
    s.first = Math.min(s.first, r.t);
    s.last = Math.max(s.last, r.t);
    const d = r.data;
    switch (r.type) {
      case 'join': {
        s.device = d.device as string; s.ua = d.ua as string; s.ref = d.ref as string;
        if (d.returning === true) returning.add(r.viewerId);
        const st = isObject(d.settings) ? d.settings : {};
        if (typeof st.lang === 'string') s.lang = st.lang;
        if (typeof st.mode === 'string') s.mode = st.mode;
        if (st.dub === true) s.dub = true;
        break;
      }
      case 'setting':
        inc(settingChanges, d.key);
        if (d.key === 'lang' && typeof d.value === 'string') s.lang = d.value;
        if (d.key === 'mode' && typeof d.value === 'string') s.mode = d.value;
        if (d.key === 'dub' && d.value === true) s.dub = true;
        break;
      case 'sample':
        if (typeof d.textDelayMs === 'number') text.push(d.textDelayMs);
        if (typeof d.voiceDelayMs === 'number') voice.push(d.voiceDelayMs);
        if (typeof d.driftMs === 'number') drift.push(d.driftMs);
        if (typeof d.gaps === 'number') audio.gaps += d.gaps;
        if (typeof d.gapMs === 'number') audio.gapMs += d.gapMs;
        if (typeof d.drops === 'number') audio.drops += d.drops;
        break;
      case 'audio':
        if (d.action === 'decode_error') audio.decodeErrors++;
        if (d.action === 'play') s.dub = true;
        break;
      case 'leave':
        if (typeof d.durationMs === 'number') s.leave = Math.max(s.leave ?? 0, d.durationMs);
        break;
      default: break;
    }
  }
  const watch: number[] = [];
  const devices: Record<string, number> = {}, browsers: Record<string, number> = {}, referrers: Record<string, number> = {};
  const languages: Record<string, number> = {}, modes: Record<string, number> = {};
  let dubbing = 0;
  for (const s of sessions.values()) {
    watch.push(s.leave ?? Math.max(0, s.last - s.first));
    if (s.device) inc(devices, s.device);
    if (s.ua) inc(browsers, s.ua);
    if (s.ref) inc(referrers, s.ref);
    if (s.lang) inc(languages, s.lang);
    if (s.mode) inc(modes, s.mode);
    if (s.dub) dubbing++;
  }
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    events: records.length, rooms: rooms.size, viewers: viewers.size, sessions: sessions.size, returningViewers: returning.size,
    avgWatchMs: watch.length ? Math.round(watch.reduce((a, b) => a + b, 0) / watch.length) : null,
    medianWatchMs: percentiles(watch).p50,
    devices, browsers, referrers, languages, modes, dubbingSessions: dubbing, settingChanges,
    textDelayMs: percentiles(text), voiceDelayMs: percentiles(voice), driftMs: percentiles(drift), audio,
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface RoomEventsOptions {
  store: EventStore;
  retentionMs: number;
  now?: () => number;
  perViewerPerMin?: number;
  perIpPerMin?: number;
  /** Background expiry interval (0 = none; tests call `sweep()`). */
  sweepIntervalMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class RoomEvents {
  private readonly now: () => number;
  private readonly limiter: EventRateLimiter;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: RoomEventsOptions) {
    this.now = opts.now ?? Date.now;
    this.limiter = new EventRateLimiter(opts.perViewerPerMin ?? 30, opts.perIpPerMin ?? 300, this.now);
    const every = opts.sweepIntervalMs ?? 6 * 3_600_000;
    if (every > 0) {
      this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, every);
      this.timer.unref?.();
    }
  }

  get retentionMs(): number { return this.opts.retentionMs; }

  async record(code: string, batch: EventBatch, ip: string): Promise<{ accepted: number; dropped: number }> {
    this.limiter.admit(batch.viewerId, ip);
    const ts = this.now();
    const records = batch.events.map(e => ({ ts, t: e.t, code, viewerId: batch.viewerId, sessionId: batch.sessionId, type: e.type, data: e.data }));
    if (records.length) await this.opts.store.append(records);
    return { accepted: records.length, dropped: batch.dropped };
  }

  async list(code: string, sinceMs: number | null, limit: number): Promise<ViewerEventRecord[]> {
    const since = Math.max(sinceMs ?? 0, this.now() - this.opts.retentionMs);
    const all = await this.opts.store.read(code, since);
    return all.slice(-limit);
  }

  async analytics(days: number, code: string | null): Promise<RoomsAnalytics> {
    const to = this.now();
    const from = Math.max(to - days * 86_400_000, to - this.opts.retentionMs);
    const records = code ? await this.opts.store.read(code, from) : await this.opts.store.readAll(from);
    return aggregateEvents(records, from, to);
  }

  async sweep(): Promise<number> {
    const n = await this.opts.store.sweep(this.now() - this.opts.retentionMs);
    if (n) this.opts.log?.('rooms: expired viewer events', { days: n });
    return n;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
