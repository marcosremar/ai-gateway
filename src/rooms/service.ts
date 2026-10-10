// ── AI Gateway — Live subtitle rooms: service ────────────────────────────────
// Rooms held in memory while active (published to or watched), loaded lazily from the store otherwise. Each room keeps
// its whole transcript (bounded by maxLines / maxRoomChars) and its live viewers; lines are broadcast to the viewers
// and appended to the store, audio clips are broadcast only. Expiry is lazy (a room idle past the retention answers
// 404 and is deleted) plus an hourly sweep of the store.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import type { RoomsConfig } from './config';
import type { RoomStore } from './store';
import type { PublicRoom, RoomLine, RoomMeta, RoomServerMessage } from './types';
import {
  CODE_ALPHABET, CODE_LENGTH, RoomError, lineChars, type AudioInput, type CreateRoomInput, type UpdateRoomInput,
} from './validate';

/** A connected viewer (the WS layer implements it). */
export interface RoomViewer {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Whether this viewer wants audio clips of `lang` (a viewer that never said = every language). */
  wantsAudio(lang: string): boolean;
}

export interface LiveRoom {
  meta: RoomMeta;
  lines: RoomLine[];
  /** line id → index in `lines` */
  index: Map<number, number>;
  chars: number;
  viewers: Set<RoomViewer>;
  /** Last time the room was used in memory (for eviction). */
  touchedAt: number;
  metaSavedAt: number;
}

export interface RoomServiceOptions {
  config: RoomsConfig;
  store: RoomStore;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Background sweep + eviction interval (0 = none, tests call `sweep()`). */
  sweepIntervalMs?: number;
}

const HOUR_MS = 3_600_000;
/** lastActivityAt is re-saved at most this often while lines flow (the lines file mtime covers the gap). */
const META_SAVE_EVERY_MS = 5 * 60_000;
/** A room with no viewer, untouched for this long, leaves memory (it stays in the store). */
const EVICT_IDLE_MS = 15 * 60_000;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export class RoomService {
  private readonly rooms = new Map<string, LiveRoom>();
  private readonly loading = new Map<string, Promise<LiveRoom | null>>();
  private readonly created = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: RoomServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    const every = opts.sweepIntervalMs ?? HOUR_MS;
    if (every > 0) {
      this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, every);
      this.timer.unref?.();
    }
  }

  get config(): RoomsConfig { return this.opts.config; }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const room of this.rooms.values()) for (const v of room.viewers) v.close(1001, 'gateway shutting down');
  }

  // ── Create ────────────────────────────────────────────────────────────────

  /** Rate limit: `maxRoomsPerHour` creations per key user in a rolling hour. */
  private admitCreate(ownerId: string): void {
    const now = this.now();
    const recent = (this.created.get(ownerId) ?? []).filter(t => now - t < HOUR_MS);
    if (recent.length >= this.config.maxRoomsPerHour) {
      throw new RoomError(429, `at most ${this.config.maxRoomsPerHour} rooms per hour per key`);
    }
    recent.push(now);
    this.created.set(ownerId, recent);
  }

  async create(input: CreateRoomInput, ownerId: string): Promise<{ code: string; publishToken: string; url: string; expiresAt: string }> {
    this.admitCreate(ownerId);
    let code = newCode();
    for (let i = 0; i < 20 && (this.rooms.has(code) || await this.opts.store.exists(code)); i++) code = newCode();
    if (this.rooms.has(code)) throw new RoomError(503, 'could not allocate a room code, retry');
    const publishToken = randomBytes(24).toString('base64url');
    const now = this.now();
    const meta: RoomMeta = {
      version: 1, code, title: input.title, originalLang: input.originalLang, languages: input.languages,
      createdAt: now, lastActivityAt: now, ended: false, endedAt: null, tokenHash: hashToken(publishToken), ownerId,
      youtubeUrl: input.youtubeUrl,
    };
    await this.opts.store.saveMeta(meta);
    this.rooms.set(code, { meta, lines: [], index: new Map(), chars: 0, viewers: new Set(), touchedAt: now, metaSavedAt: now });
    this.log('rooms: created', { code, ownerId, languages: input.languages.length });
    return { code, publishToken, url: `${this.config.publicBaseUrl}/${code}`, expiresAt: this.expiresAt(meta) };
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  private expiresAt(meta: RoomMeta): string {
    return new Date(meta.lastActivityAt + this.config.retentionMs).toISOString();
  }

  private expired(meta: RoomMeta): boolean {
    return this.now() - meta.lastActivityAt > this.config.retentionMs;
  }

  /** The room, or null when unknown or expired (an expired one is deleted). */
  async get(code: string): Promise<LiveRoom | null> {
    let room = this.rooms.get(code) ?? null;
    if (!room) {
      let pending = this.loading.get(code);
      if (!pending) {
        pending = this.load(code).finally(() => this.loading.delete(code));
        this.loading.set(code, pending);
      }
      room = await pending;
    }
    if (!room) return null;
    if (this.expired(room.meta)) {
      await this.drop(room, 'expired');
      return null;
    }
    room.touchedAt = this.now();
    return room;
  }

  private async load(code: string): Promise<LiveRoom | null> {
    const stored = await this.opts.store.load(code);
    if (!stored) return null;
    const existing = this.rooms.get(code);
    if (existing) return existing;
    const index = new Map<number, number>();
    let chars = 0;
    stored.lines.forEach((l, i) => { index.set(l.id, i); chars += lineChars(l); });
    const room: LiveRoom = {
      meta: stored.meta, lines: stored.lines, index, chars, viewers: new Set(), touchedAt: this.now(), metaSavedAt: this.now(),
    };
    this.rooms.set(code, room);
    return room;
  }

  private async drop(room: LiveRoom, why: string): Promise<void> {
    for (const v of room.viewers) v.close(1001, 'room expired');
    this.rooms.delete(room.meta.code);
    await this.opts.store.remove(room.meta.code).catch(() => {});
    this.log('rooms: removed', { code: room.meta.code, why });
  }

  publicView(room: LiveRoom): PublicRoom {
    const m = room.meta;
    return {
      code: m.code, title: m.title, originalLang: m.originalLang, languages: m.languages,
      createdAt: new Date(m.createdAt).toISOString(), ended: m.ended, expiresAt: this.expiresAt(m),
      youtubeUrl: typeof m.youtubeUrl === 'string' ? m.youtubeUrl : null, lines: room.lines,
    };
  }

  // ── Publish auth ──────────────────────────────────────────────────────────

  /**
   * The room's publish token (constant-time compare of the hashes), or a gateway key whose user created the room or is
   * an admin (`keyUser` resolves the bearer as a gateway key; null when it is not one).
   */
  authorizePublish(room: LiveRoom, bearer: string, keyUser: (token: string) => { userId: string; admin: boolean } | null): void {
    if (!bearer) throw new RoomError(401, 'missing Authorization: Bearer <publishToken>');
    const given = Buffer.from(hashToken(bearer), 'hex');
    const expected = Buffer.from(room.meta.tokenHash, 'hex');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return;
    const user = keyUser(bearer);
    if (user && (user.admin || user.userId === room.meta.ownerId)) return;
    throw new RoomError(user ? 403 : 401, user ? 'this key did not create the room' : 'invalid publish token');
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  private broadcast(room: LiveRoom, msg: RoomServerMessage, filter?: (v: RoomViewer) => boolean): void {
    const text = JSON.stringify(msg);
    for (const v of room.viewers) {
      if (filter && !filter(v)) continue;
      try { v.send(text); } catch { /* the WS layer closes broken viewers */ }
    }
  }

  private touchActivity(room: LiveRoom): void {
    const now = this.now();
    room.meta.lastActivityAt = now;
    room.touchedAt = now;
    if (now - room.metaSavedAt >= META_SAVE_EVERY_MS) {
      room.metaSavedAt = now;
      void this.opts.store.saveMeta(room.meta).catch((err: unknown) => {
        this.log('rooms: meta save failed', { code: room.meta.code, error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  /** Adds or replaces (same id) a line: broadcast first, then persisted. */
  async publishLine(room: LiveRoom, line: RoomLine): Promise<void> {
    if (room.meta.ended) throw new RoomError(409, 'room has ended');
    const at = room.index.get(line.id);
    const added = lineChars(line) - (at === undefined ? 0 : lineChars(room.lines[at]!));
    if (at === undefined && room.lines.length >= this.config.maxLines) throw new RoomError(409, `room is full (${this.config.maxLines} lines)`);
    if (room.chars + added > this.config.maxRoomChars) throw new RoomError(409, 'room transcript is full');
    room.chars += added;
    if (at !== undefined) {
      room.lines[at] = line;
    } else if (!room.lines.length || room.lines[room.lines.length - 1]!.id < line.id) {
      room.index.set(line.id, room.lines.length);
      room.lines.push(line);
    } else {
      // Out-of-order id: insert in place, re-index the tail.
      const pos = room.lines.findIndex(l => l.id > line.id);
      room.lines.splice(pos, 0, line);
      for (let i = pos; i < room.lines.length; i++) room.index.set(room.lines[i]!.id, i);
    }
    this.touchActivity(room);
    this.broadcast(room, { type: 'line', line });
    await this.opts.store.appendLine(room.meta.code, line);
  }

  publishAudio(room: LiveRoom, audio: AudioInput): void {
    if (room.meta.ended) throw new RoomError(409, 'room has ended');
    room.touchedAt = this.now();
    this.broadcast(room, { type: 'audio', lineId: audio.lineId, lang: audio.lang, wav: audio.wav }, v => v.wantsAudio(audio.lang));
  }

  /**
   * Changes the room's YouTube link (also after the end: the recording stays at the same link). Persisted, then
   * broadcast to the open pages as `{"type":"update"}`; an unchanged value is a no-op.
   */
  async update(room: LiveRoom, input: UpdateRoomInput): Promise<void> {
    const before = typeof room.meta.youtubeUrl === 'string' ? room.meta.youtubeUrl : null;
    if (before === input.youtubeUrl) return;
    room.meta.youtubeUrl = input.youtubeUrl;
    room.meta.lastActivityAt = this.now();
    room.touchedAt = this.now();
    room.metaSavedAt = this.now();
    await this.opts.store.saveMeta(room.meta);
    this.log('rooms: updated', { code: room.meta.code, youtube: input.youtubeUrl !== null });
    this.broadcast(room, { type: 'update', youtubeUrl: input.youtubeUrl });
  }

  async end(room: LiveRoom): Promise<void> {
    if (!room.meta.ended) {
      room.meta.ended = true;
      room.meta.endedAt = this.now();
      this.log('rooms: ended', { code: room.meta.code, lines: room.lines.length });
    }
    room.meta.lastActivityAt = this.now();
    room.metaSavedAt = this.now();
    this.broadcast(room, { type: 'ended' });
    await this.opts.store.saveMeta(room.meta);
  }

  // ── Viewers ───────────────────────────────────────────────────────────────

  /** Registers a viewer; false when the room is at `maxViewers`. */
  addViewer(room: LiveRoom, viewer: RoomViewer): boolean {
    if (room.viewers.size >= this.config.maxViewers) return false;
    room.viewers.add(viewer);
    room.touchedAt = this.now();
    return true;
  }

  removeViewer(room: LiveRoom, viewer: RoomViewer): void {
    room.viewers.delete(viewer);
    room.touchedAt = this.now();
  }

  viewerCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.viewers.size;
    return n;
  }

  // ── Expiry ────────────────────────────────────────────────────────────────

  /** Drops expired rooms (memory + store) and evicts idle unwatched rooms from memory. */
  async sweep(): Promise<{ removed: string[]; evicted: string[] }> {
    const now = this.now();
    const removed: string[] = [];
    const evicted: string[] = [];
    for (const room of [...this.rooms.values()]) {
      if (this.expired(room.meta)) { await this.drop(room, 'expired'); removed.push(room.meta.code); continue; }
      if (room.viewers.size === 0 && now - room.touchedAt > EVICT_IDLE_MS) {
        await this.opts.store.saveMeta(room.meta).catch(() => {});
        this.rooms.delete(room.meta.code);
        evicted.push(room.meta.code);
      }
    }
    removed.push(...await this.opts.store.sweepExpired(now, this.config.retentionMs, code => this.rooms.has(code)));
    if (removed.length) this.log('rooms: expired', { count: removed.length });
    for (const [owner, times] of this.created) {
      const recent = times.filter(t => now - t < HOUR_MS);
      if (recent.length) this.created.set(owner, recent); else this.created.delete(owner);
    }
    return { removed, evicted };
  }
}
