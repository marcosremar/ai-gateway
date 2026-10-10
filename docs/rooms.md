# Live subtitle rooms

A presenter's desktop app (ucast.me) publishes each live subtitle line (original + translations) and optional dubbed
audio clips to a **room**; anyone scans a QR code to `https://live.ucast.me/<CODE>` and follows on their phone. The
transcript stays readable for `ROOMS_RETENTION_DAYS` (30) after the last activity. Code: `src/rooms/`, mounted by
`serve.ts` like `src/realtime` (customRoute for the key-authenticated create, the rest in front of the proxy).

## HTTP API

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /v1/rooms` | gateway key | `{"title"?, "originalLang"?, "languages": ["en","es"]}` | `201 {"code","publishToken","url","expiresAt"}` |
| `POST /v1/rooms/:code/lines` | publish token (or the creating / an admin gateway key) | `{"id", "original", "originalLang"?, "translations": {"en": "…"}, "ts"?}` | `204` |
| `POST /v1/rooms/:code/audio` | publish token | `{"lineId", "lang", "wav": "<base64>"}` (≤ 2 MB decoded) | `204` (broadcast only, never stored) |
| `POST /v1/rooms/:code/end` | publish token | — | `204` |
| `GET /v1/rooms/:code` | public, CORS `*` | — | `200 {"code","title","originalLang","languages","createdAt","ended","expiresAt","lines":[…]}` / `404` |
| `GET /v1/rooms/:code/ws` | public WebSocket | — | see below |

- Code: 6 characters of `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L); lower case is accepted in URLs.
- `id` is monotonic per room; re-sending an id replaces that line (idempotent). Out-of-order ids are kept in id order.
- `expiresAt` in the GET body is an addition to the original contract (the page shows it after the end).
- Errors: `{"error":{"message","type"}}` — 400 bad body, 401 no/invalid token, 403 a gateway key that did not create
  the room, 404 unknown or expired, 409 room ended / full, 413 too large, 429 too many rooms created (per key per hour).

## WebSocket

Server → client: `{"type":"snapshot","room":<GET body>}` on connect, then `{"type":"line","line"}`,
`{"type":"audio","lineId","lang","wav"}`, `{"type":"ended"}`. Client → server: `{"type":"ping"}` (→ `{"type":"pong"}`)
and, optionally, `{"type":"listen","lang":"en"|null}`: once sent, audio clips arrive only for that language (`null` =
none), so viewers who do not listen to the dubbing do not download it. The server pings every 25 s.

## Viewer pages

- `https://<ROOMS_PUBLIC_HOST>/<CODE>` (Host header match) and `/live/<CODE>` on any host: the room page (pt-BR, one
  self-contained HTML document, CSP with a per-response nonce, no CDN).
- `https://<ROOMS_PUBLIC_HOST>/` and `/live`: "Digite o código da sessão". Unknown/expired code: a 404 page.
- Other paths on the public host (e.g. `/health`, `/v1/…`) reach the gateway as usual.

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
