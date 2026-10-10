# Live subtitle rooms

A presenter's desktop app (ucast.me) publishes each live subtitle line (original + translations) and optional dubbed
audio clips to a **room**; anyone scans a QR code to `https://live.ucast.me/<CODE>` and follows on their phone. The
transcript stays readable for `ROOMS_RETENTION_DAYS` (30) after the last activity. Code: `src/rooms/`, mounted by
`serve.ts` like `src/realtime` (customRoute for the key-authenticated create, the rest in front of the proxy).

## HTTP API

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /v1/rooms` | gateway key | `{"title"?, "originalLang"?, "languages": ["en","es"]}` | `201 {"code","publishToken","url","expiresAt"}` |
| `POST /v1/rooms/:code/lines` | publish token (or the creating / an admin gateway key) | `{"id", "original", "originalLang"?, "translations": {"en": "…"}, "ts"?, "delayMs"?}` | `204` |
| `POST /v1/rooms/:code/audio` | publish token | `{"lineId", "lang", "wav": "<base64>"}` (≤ 2 MB decoded) | `204` (broadcast only, never stored) |
| `POST /v1/rooms/:code/end` | publish token | — | `204` |
| `GET /v1/rooms/:code` | public, CORS `*` | — | `200 {"code","title","originalLang","languages","createdAt","ended","expiresAt","lines":[…]}` / `404` |
| `GET /v1/rooms/:code/ws` | public WebSocket | — | see below |

- Code: 6 characters of `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L); lower case is accepted in URLs.
- `id` is monotonic per room; re-sending an id replaces that line (idempotent). Out-of-order ids are kept in id order.
- `expiresAt` in the GET body is an addition to the original contract (the page shows it after the end).
- `delayMs` (additive, optional): ms from the end of speech to the subtitle being ready, an integer 0–120000 (else 400).
  Stored and served back on the line (GET and WS); the page shows the median of the last 10 as "atraso 1,8 s".
- Errors: `{"error":{"message","type"}}` — 400 bad body, 401 no/invalid token, 403 a gateway key that did not create
  the room, 404 unknown or expired, 409 room ended / full, 413 too large, 429 too many rooms created (per key per hour).

## WebSocket

Server → client: `{"type":"snapshot","room":<GET body>}` on connect, then `{"type":"line","line"}`,
`{"type":"audio","lineId","lang","wav"}`, `{"type":"ended"}`. Client → server: `{"type":"ping"}` (→ `{"type":"pong"}`)
and, optionally, `{"type":"listen","lang":"en"|null}`: once sent, audio clips arrive only for that language (`null` =
none), so viewers who do not listen to the dubbing do not download it. The server pings every 25 s.

## Viewer pages

- `https://<ROOMS_PUBLIC_HOST>/<CODE>` (Host header match) and `/live/<CODE>` on any host: the room page (French by default, one
  self-contained HTML document, CSP with a per-response nonce, no CDN). Default language: the viewer's saved choice
  for that room, else the first browser language the room publishes (primary subtag: `en-US` → `en`), else the room's
  first target language; the original only when the room has no translations. The live line and the original under it
  are always one line each: the font shrinks down to 70 %, then only the end of the sentence is shown behind "…".
  Dubbing ("Ouvir dublagem") plays clips with Web Audio: one AudioContext, back-to-back scheduling with 10 ms fades (no
  clicks), oldest pending clips dropped when more than 6 s is queued. While it is on, the live line switches to a line
  when its clip starts playing (a line without a clip within 4 s is shown anyway) and the delay indicator shows the
  voice delay ("voz 3,2 s" = delayMs + wait until the clip played). Indicator: neutral < 3 s, amber 3–6 s, red above.
- Every display setting is the viewer's own (gear → "Réglages d'affichage": bottom sheet on phones, popover from 768 px),
  kept in that browser's localStorage per app — `ucast-settings-<app>`, where `<app>` is the first 12 hex of sha256 of the
  gateway key user that created the room (all activation keys of the desktop app share one), read once from the older
  `ucast-settings` as a fallback; the language per room in `ucast-lang-<CODE>`: interface language (Français by
  default, Português, English), subtitle language, mode
  (Tradução / Só transcrição / Bilíngue / Só texto completo), original under the translation, dubbing on/off + volume +
  "sincronizar legenda com a voz", text size A−/A+ (live line 20–56 px, transcript 14–24 px), theme (escuro / claro /
  automático), auto-scroll, timestamps, delay indicator. Only the languages the room publishes are offered.
- Quick modes on the toolbar (icons with a tooltip on hover/focus and on tap, the current one pressed): dubbed (translation
  + voice), translated subtitles, dual subtitles (bilingual), transcript, full text.
- Karaoke: the words already said are coloured one by one on the live line and the current transcript line. Lines carry
  no word timestamps, so the times are an estimate spread by word length: over the real duration of the dubbed clip from
  its start when the voice is on (sync), else over `speechMs` (15 characters/s of the original) from the line's arrival.
- `https://<ROOMS_PUBLIC_HOST>/` and `/live`: "Saisissez le code de la session". Unknown/expired code: a 404 page.
- Other paths on the public host (e.g. `/health`, `/v1/…`) reach the gateway as usual.

## Viewer analytics events

The room page reports anonymous viewer interactions for product analysis (code: `src/rooms/events.ts`).

| Route | Auth | Answer |
|---|---|---|
| `POST /v1/rooms/:code/events` | public (the room must exist) | `202 {"accepted","dropped"}`; 400 bad envelope, 413 > 64 KB or > 200 events, 429 rate limit |
| `GET /v1/rooms/:code/events?since=<ms>&limit=<n≤50000>` | admin gateway key | `{"code","count","events":[record…]}` (also after the room content expired) |
| `GET /v1/rooms-analytics?days=30&code=<CODE>` | admin gateway key | aggregates (below) |

Batch: `{"viewerId":"v_<hex>","sessionId":"s_<hex>","events":[{"t":<viewer clock ms>,"type":…,…fields}]}`. `viewerId` is
random and kept in the browser's localStorage (`ucast-viewer`); `sessionId` is per page load. Unknown event types,
events without `t` or without their key field are dropped; unknown or invalid fields are dropped. Stored record:
`{"ts":<server receipt ms>,"t","code","viewerId","sessionId","type","data":{…}}`.

| type | fields |
|---|---|
| `join` | `ua` chrome/safari/firefox/edge/samsung/opera/other · `os` ios/android/windows/macos/linux/chromeos/other · `device` mobile/tablet/desktop · `vw` `vh` `dpr` · `lang` (navigator.language) · `langs` (≤ 5) · `ref` qr/direct/link (`?src=qr` in the link → qr) · `returning` · `settings` (snapshot: ui, lang, mode, showOrig, dub, volume, sync, size, theme, autoScroll, showTimes, showDelay) |
| `setting` | `key` (ui, lang, mode, showOrig, dub, volume, sync, size, theme, autoScroll, showTimes, showDelay) · `value` (valid for the key) · `from` toolbar/sheet/auto |
| `audio` | `action` play/pause/mute/unmute/gap/drop/decode_error/unsupported · `ms` · `n` |
| `sample` | every 30 s while lines or clips flow: `textDelayMs` (median presenter `delayMs`), `voiceDelayMs`, `driftMs` (subtitle ↔ voice: render lateness after the clip start with sync on, clip start − text arrival with sync off), `lagMs` (arrival − line `ts`, includes clock skew), `queueMs`, `gaps` `gapMs` (silences 20 ms–3 s between consecutive clips), `drops`, `clips`, `lines`, `visible` |
| `visibility` | `state` hidden/visible |
| `ui` | `action` copy/sheet_open/sheet_close/more/reconnect/ended |
| `leave` | `durationMs` `visibleMs` `reason` (sent with `sendBeacon` on `pagehide`) |

The page sends batches every 15 s, at 100 queued events, when the tab is hidden and on `pagehide`.
Privacy: no IP is stored. The rate limit (30 batches/min per viewerId, 300 per IP) keys IPs by a salted hash held in
memory only. Storage: `<ROOMS_DIR>/events/<YYYY-MM-DD>/<CODE>.jsonl` (UTC day of receipt). Day directories older than
`ROOM_EVENTS_RETENTION_DAYS` (365) are deleted, so events outlive the room content.
Aggregates: `events`, `rooms`, `viewers`, `sessions`, `returningViewers`, `avgWatchMs`/`medianWatchMs` (the session's
`leave.durationMs`, else last − first event), `devices`, `browsers`, `referrers`, `languages` and `modes` (final per
session), `dubbingSessions`, `settingChanges`, `textDelayMs`/`voiceDelayMs`/`driftMs` as `{n,p50,p95}`, and `audio` as
`{gaps,gapMs,drops,decodeErrors}`.
## Storage, expiry, limits

- Files in `<DEPLOYMENTS_STATE_DIR>/rooms/` (the Railway volume; `ROOMS_DIR` overrides): `<CODE>.json` (meta, atomic
  write with `.bak`, the publish token only as a sha256) and `<CODE>.lines.jsonl` (appended; last record of an id wins).
- A room is held in memory while it is published to or watched, evicted after 15 min idle without viewers.
- Expiry: lazily on access, plus an hourly sweep that deletes rooms whose last activity (create, line, end) is older
  than the retention.
- Limits (env): `ROOMS_MAX_LINES` 20 000, `ROOMS_MAX_FIELD_CHARS` 2 000 per field, `ROOMS_MAX_ROOM_CHARS` 8 M total,
  `ROOMS_MAX_PER_HOUR` 60 rooms per key, `ROOMS_MAX_VIEWERS` 500 per room, `ROOMS_MAX_AUDIO_BYTES` 2 MB; at most 12
  languages; bodies capped at 16 KB (create), 256 KB (line), ~2.8 MB (audio).
- Transcript text is never logged.

| Env | Default |
|---|---|
| `ROOMS_PUBLIC_BASE_URL` | `https://live.ucast.me` |
| `ROOMS_PUBLIC_HOST` | `live.ucast.me` (empty = only `/live/<CODE>`) |
| `ROOMS_RETENTION_DAYS` | `30` |
