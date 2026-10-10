// ── AI Gateway — Live subtitle rooms: request validation ────────────────────
// Plain checks (no schema library on this path): each returns the clean value or throws RoomError(400/413).

import type { RoomsConfig } from './config';
import type { RoomLine } from './types';

export class RoomError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RoomError';
  }
}

/** BCP-47-ish language code: `en`, `pt-BR`, `zh-Hans`. */
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
/** Room code alphabet: no 0/O/1/I/L (read aloud, typed on a phone). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Upper-cased code when it has the room code shape, else null. */
export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export function parseLang(v: unknown, field: string): string {
  if (typeof v !== 'string' || !LANG.test(v)) throw new RoomError(400, `${field} must be a language code like "en" or "pt-BR"`);
  return v;
}

/** Longest accepted `youtubeUrl`. */
export const MAX_YOUTUBE_URL_CHARS = 300;
/** Hosts a room's YouTube link may point to (watch page, channel `/live`, youtu.be short link). */
export const YOUTUBE_HOSTS: readonly string[] = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

/**
 * Optional YouTube watch link of a room: absent / null / "" → null (none); else an https URL on one of
 * `YOUTUBE_HOSTS`, no credentials, no explicit port, at most MAX_YOUTUBE_URL_CHARS — returned normalized, or a 400.
 */
export function parseYoutubeUrl(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const bad = () => new RoomError(400, `youtubeUrl must be an https link on ${YOUTUBE_HOSTS.join(', ')} (at most ${MAX_YOUTUBE_URL_CHARS} characters)`);
  if (typeof v !== 'string' || v.length > MAX_YOUTUBE_URL_CHARS || !/^https:\/\/[\x21-\x7e]+$/i.test(v)) throw bad();
  let url: URL;
  try { url = new URL(v); } catch { throw bad(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !YOUTUBE_HOSTS.includes(url.hostname)) throw bad();
  const out = url.toString();
  if (out.length > MAX_YOUTUBE_URL_CHARS) throw bad();
  return out;
}

export interface CreateRoomInput { title: string; originalLang: string | null; languages: string[]; youtubeUrl: string | null }

/** `PATCH /v1/rooms/:code`: the room fields a publisher may change after creation. */
export interface UpdateRoomInput { youtubeUrl: string | null }

export function parseUpdate(body: unknown): UpdateRoomInput {
  if (!isObject(body)) throw new RoomError(400, 'body must be a JSON object');
  if (!('youtubeUrl' in body)) throw new RoomError(400, 'nothing to update: send {"youtubeUrl": "<link>" | null}');
  return { youtubeUrl: parseYoutubeUrl(body.youtubeUrl) };
}

export function parseCreate(body: unknown, cfg: RoomsConfig): CreateRoomInput {
  if (!isObject(body)) throw new RoomError(400, 'body must be a JSON object');
  const title = body.title === undefined || body.title === null ? '' : body.title;
  if (typeof title !== 'string') throw new RoomError(400, 'title must be a string');
  if (title.length > cfg.maxTitleChars) throw new RoomError(400, `title is longer than ${cfg.maxTitleChars} characters`);
  const originalLang = body.originalLang === undefined || body.originalLang === null ? null : parseLang(body.originalLang, 'originalLang');
  if (!Array.isArray(body.languages)) throw new RoomError(400, 'languages must be an array of language codes');
  if (body.languages.length > cfg.maxLanguages) throw new RoomError(400, `at most ${cfg.maxLanguages} languages`);
  const languages: string[] = [];
  for (const l of body.languages) {
    const lang = parseLang(l, 'languages[]');
    if (!languages.includes(lang)) languages.push(lang);
  }
  return { title: title.trim(), originalLang, languages, youtubeUrl: parseYoutubeUrl(body.youtubeUrl) };
}

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw new RoomError(400, `${field} must be a string`);
  if (v.length > max) throw new RoomError(413, `${field} is longer than ${max} characters`);
  return v;
}

export function parseLine(body: unknown, cfg: RoomsConfig, now: number): RoomLine {
  if (!isObject(body)) throw new RoomError(400, 'body must be a JSON object');
  const id = body.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) throw new RoomError(400, 'id must be a non-negative integer');
  const original = text(body.original, 'original', cfg.maxFieldChars);
  const originalLang = body.originalLang === undefined || body.originalLang === null ? null : parseLang(body.originalLang, 'originalLang');
  const rawTr = body.translations ?? {};
  if (!isObject(rawTr)) throw new RoomError(400, 'translations must be an object of language → text');
  const keys = Object.keys(rawTr);
  if (keys.length > cfg.maxLanguages) throw new RoomError(400, `at most ${cfg.maxLanguages} translations`);
  const translations: Record<string, string> = {};
  for (const k of keys) translations[parseLang(k, 'translations key')] = text(rawTr[k], `translations.${k}`, cfg.maxFieldChars);
  const ts = body.ts === undefined || body.ts === null ? now : body.ts;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) throw new RoomError(400, 'ts must be a timestamp in ms');
  const line: RoomLine = { id, original, originalLang, translations, ts: Math.floor(ts) };
  const delayMs = parseDelayMs(body.delayMs);
  if (delayMs !== undefined) line.delayMs = delayMs;
  return line;
}

/** Longest accepted `delayMs` (2 min). */
export const MAX_DELAY_MS = 120_000;

/** Optional `delayMs` of a line: absent/null → undefined; else an integer 0…MAX_DELAY_MS or a 400. */
export function parseDelayMs(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > MAX_DELAY_MS) {
    throw new RoomError(400, `delayMs must be an integer between 0 and ${MAX_DELAY_MS}`);
  }
  return v;
}

export interface AudioInput { lineId: number; lang: string; wav: string }

export function parseAudio(body: unknown, cfg: RoomsConfig): AudioInput {
  if (!isObject(body)) throw new RoomError(400, 'body must be a JSON object');
  const { lineId, wav } = body;
  if (typeof lineId !== 'number' || !Number.isSafeInteger(lineId) || lineId < 0) throw new RoomError(400, 'lineId must be a non-negative integer');
  const lang = parseLang(body.lang, 'lang');
  if (typeof wav !== 'string' || wav.length === 0) throw new RoomError(400, 'wav must be a base64 string');
  if (Math.floor(wav.length * 3 / 4) > cfg.maxAudioBytes) throw new RoomError(413, `audio is larger than ${cfg.maxAudioBytes} bytes`);
  if (wav.length % 4 !== 0 || !BASE64.test(wav)) throw new RoomError(400, 'wav must be standard base64');
  return { lineId, lang, wav };
}

/** Characters a line adds to its room (memory bound). */
export function lineChars(line: RoomLine): number {
  let n = line.original.length;
  for (const v of Object.values(line.translations)) n += v.length;
  return n;
}
