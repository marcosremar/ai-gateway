// ── AI Gateway — Live subtitle rooms: configuration ─────────────────────────
// Every knob is read from the environment with a default; nothing about the public page (domain, base URL) is
// hardcoded elsewhere. See docs/rooms.md.

import { homedir } from 'os';
import { join } from 'path';

export interface RoomsConfig {
  /** Base of the viewer link returned by POST /v1/rooms (`<base>/<CODE>`). */
  publicBaseUrl: string;
  /** Host whose `/` and `/<CODE>` serve the viewer pages (Host header match). Empty = only `/live/<CODE>`. */
  publicHost: string;
  /** A room is deleted this long after its last activity (create, line, end). */
  retentionMs: number;
  /** Directory of the room files; null = memory only (tests). */
  dir: string | null;
  maxLines: number;
  /** Max characters of `original` and of each translation. */
  maxFieldChars: number;
  /** Max total text characters of a room (bounds memory: rooms are held whole while active). */
  maxRoomChars: number;
  maxLanguages: number;
  maxTitleChars: number;
  /** Rooms one key may create per rolling hour. */
  maxRoomsPerHour: number;
  maxViewers: number;
  /** Max decoded size of one dubbed audio clip. */
  maxAudioBytes: number;
}

export const ROOMS_DEFAULTS = {
  PUBLIC_BASE_URL: 'https://live.ucast.me',
  PUBLIC_HOST: 'live.ucast.me',
  RETENTION_DAYS: 30,
  MAX_LINES: 20_000,
  MAX_FIELD_CHARS: 2_000,
  MAX_ROOM_CHARS: 8_000_000,
  MAX_LANGUAGES: 12,
  MAX_TITLE_CHARS: 200,
  MAX_ROOMS_PER_HOUR: 60,
  MAX_VIEWERS: 500,
  MAX_AUDIO_BYTES: 2 * 1024 * 1024,
} as const;

const DAY_MS = 86_400_000;

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function roomsConfigFromEnv(env: Record<string, string | undefined> = process.env): RoomsConfig {
  // The gateway's durable state dir (the Railway volume); Railway's own mount variable when that one is not set.
  const stateDir = env.DEPLOYMENTS_STATE_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || join(homedir(), '.ai-gateway');
  const base = (env.ROOMS_PUBLIC_BASE_URL?.trim() || ROOMS_DEFAULTS.PUBLIC_BASE_URL).replace(/\/+$/, '');
  return {
    publicBaseUrl: base,
    publicHost: (env.ROOMS_PUBLIC_HOST ?? ROOMS_DEFAULTS.PUBLIC_HOST).trim().toLowerCase(),
    retentionMs: positive(env.ROOMS_RETENTION_DAYS, ROOMS_DEFAULTS.RETENTION_DAYS) * DAY_MS,
    dir: env.ROOMS_DIR?.trim() || join(stateDir, 'rooms'),
    maxLines: Math.floor(positive(env.ROOMS_MAX_LINES, ROOMS_DEFAULTS.MAX_LINES)),
    maxFieldChars: Math.floor(positive(env.ROOMS_MAX_FIELD_CHARS, ROOMS_DEFAULTS.MAX_FIELD_CHARS)),
    maxRoomChars: Math.floor(positive(env.ROOMS_MAX_ROOM_CHARS, ROOMS_DEFAULTS.MAX_ROOM_CHARS)),
    maxLanguages: ROOMS_DEFAULTS.MAX_LANGUAGES,
    maxTitleChars: ROOMS_DEFAULTS.MAX_TITLE_CHARS,
    maxRoomsPerHour: Math.floor(positive(env.ROOMS_MAX_PER_HOUR, ROOMS_DEFAULTS.MAX_ROOMS_PER_HOUR)),
    maxViewers: Math.floor(positive(env.ROOMS_MAX_VIEWERS, ROOMS_DEFAULTS.MAX_VIEWERS)),
    maxAudioBytes: Math.floor(positive(env.ROOMS_MAX_AUDIO_BYTES, ROOMS_DEFAULTS.MAX_AUDIO_BYTES)),
  };
}
