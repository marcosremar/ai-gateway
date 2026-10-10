// ── AI Gateway — Live subtitle rooms: types ──────────────────────────────────
// The wire shapes of docs/rooms.md (the presenter's desktop app is built against them — change only additively).

/** One subtitle line as published and as served. */
export interface RoomLine {
  id: number;
  original: string;
  originalLang: string | null;
  translations: Record<string, string>;
  ts: number;
  /** Additive: ms from the end of speech to the subtitle being ready (presenter-measured), 0–120000. */
  delayMs?: number;
}

/** What the store keeps about a room (never sent as is: `tokenHash` and `ownerId` stay server-side). */
export interface RoomMeta {
  version: 1;
  code: string;
  title: string;
  originalLang: string | null;
  languages: string[];
  createdAt: number;
  lastActivityAt: number;
  ended: boolean;
  endedAt: number | null;
  /** sha256 (hex) of the publish token. */
  tokenHash: string;
  /** Gateway key user that created the room (may publish with its key instead of the token). */
  ownerId: string;
  /** Additive: the presenter's YouTube watch link (validated, https on a YouTube host); absent in older metas = none. */
  youtubeUrl?: string | null;
}

/** `GET /v1/rooms/:code` and the WS `snapshot.room`. */
export interface PublicRoom {
  code: string;
  title: string;
  originalLang: string | null;
  languages: string[];
  createdAt: string;
  ended: boolean;
  /** Additive to the contract: when the transcript stops being served (last activity + retention). */
  expiresAt: string;
  /** Additive: where the same session is live on YouTube (null = none). */
  youtubeUrl: string | null;
  lines: RoomLine[];
}

export type RoomServerMessage =
  | { type: 'snapshot'; room: PublicRoom }
  /** Room fields changed after creation (`PATCH /v1/rooms/:code`). */
  | { type: 'update'; youtubeUrl: string | null }
  | { type: 'line'; line: RoomLine }
  | { type: 'audio'; lineId: number; lang: string; wav: string }
  | { type: 'ended' }
  | { type: 'pong' };
