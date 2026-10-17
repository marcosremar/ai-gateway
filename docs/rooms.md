# Live subtitle rooms

A presenter's desktop app (ucast.me) publishes each live subtitle line (original + translations) and optional dubbed
audio clips to a **room**; anyone scans a QR code to `https://live.ucast.me/<CODE>` and follows on their phone. The
transcript stays readable for `ROOMS_RETENTION_DAYS` (30) after the last activity. Code: `src/rooms/`, mounted by
`serve.ts` like `src/realtime` (customRoute for the key-authenticated create, the rest in front of the proxy).

## HTTP API

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /v1/rooms` | gateway key | `{"title"?, "originalLang"?, "languages": ["en","es"], "serverDub"?, "youtubeUrl"?}` | `201 {"code","publishToken","url","expiresAt"}` |
| `PATCH /v1/rooms/:code` | publish token (or the creating / an admin gateway key) | `{"youtubeUrl": "<link>" \| null}` | `200 {"code","youtubeUrl"}` |
| `POST /v1/rooms/:code/lines` | publish token (or the creating / an admin gateway key) | `{"id", "original", "originalLang"?, "translations": {"en": "…"}, "ts"?, "delayMs"?, "draft"?}` | `204` |
| `POST /v1/rooms/:code/audio` | publish token | `{"lineId", "lang", "wav": "<base64>"}` (≤ 2 MB decoded) | `204` (broadcast only, never stored) |
| `POST /v1/rooms/:code/end` | publish token | — | `204` |
| `GET /v1/rooms/:code` | public, CORS `*` | — | `200 {"code","title","originalLang","languages","createdAt","ended","expiresAt","youtubeUrl","lines":[…]}` / `404` |
| `GET /v1/rooms/:code/ws` | public WebSocket | — | see below |

- Code: 6 characters of `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L); lower case is accepted in URLs.
- `id` is monotonic per room; re-sending an id replaces that line (idempotent). Out-of-order ids are kept in id order.
- `expiresAt` in the GET body is an addition to the original contract (the page shows it after the end).
- `delayMs` (additive, optional): ms from the end of speech to the subtitle being ready, an integer 0–120000 (else 400).
  Stored and served back on the line (GET and WS); the page shows the median of the last 10 as "atraso 1,8 s".
- `draft` (additive, optional): `true` = the presenter will still grow this line (same `id`). The server dub never voices
  a draft; it voices the version without `draft`. Anything but `true` is ignored (absent = final, as with older apps).
- `youtubeUrl` (additive, optional): where the same session is live on YouTube — the presenter's app sends the channel
  link (`https://www.youtube.com/channel/<id>/live`) and, once the broadcast is found, `https://youtu.be/<id>`. Strictly
  validated: an `https:` URL on `youtube.com`, `www.youtube.com`, `m.youtube.com` or `youtu.be`, no credentials, no port,
  ASCII only, at most 200 characters (else 400); `null` / `""` = none. Settable at creation and with `PATCH` (also after
  the end — the recording keeps the link); kept in the room meta, served in GET and the WS snapshot, and every change
  is pushed to open pages as `{"type":"update","youtubeUrl"}`. Older metas without it serve `null`.
- Errors: `{"error":{"message","type"}}` — 400 bad body, 401 no/invalid token, 403 a gateway key that did not create
  the room, 404 unknown or expired, 409 room ended / full, 413 too large, 429 too many rooms created (per key per hour).

## WebSocket

Server → client: `{"type":"snapshot","room":<GET body>}` on connect, then `{"type":"line","line"}`,
`{"type":"audio","lineId","lang","wav"}`, `{"type":"update","youtubeUrl"}` (room fields changed), `{"type":"ended"}`. Client → server: `{"type":"ping"}` (→ `{"type":"pong"}`)
and, optionally, `{"type":"listen","lang":"en"|null,"view":"en"|null}`: once sent, audio clips arrive only for `lang`
(`null` = none), so viewers who do not listen to the dubbing do not download it; `view` (additive) is the language on
screen, which makes the server translate lines into a `listenLangs` language for a reader. The server pings every 25 s.

## Server dubbing

When the presenter sends text only, the gateway voices the lines itself with Kokoro 82M (`hexgrad/kokoro-82m`) through
OpenRouter (`OPENROUTER_API_KEY`, mp3, ~$0.62 per million characters). Code: `src/rooms/dub.ts`, wired in `serve.ts`.

- Voices (primary subtag): en `af_heart`, fr `ff_siwis`, es `ef_dora`, pt `pf_dora`, it `if_sara`, ja `jf_alpha`,
  zh `zf_xiaobei`, hi `hf_alpha`. Other languages are not voiced.
- Spend only on demand: a line+language is synthesized only while at least one viewer has sent `listen` for that
  language (a viewer that never sent `listen` does not count) and the line has a non-empty translation for it.
- The presenter wins: in a language the presenter has sent clips in, the server waits `ROOM_SERVER_DUB_WAIT_MS` (1500)
  after a line (elsewhere it voices at once — the wait was 1.5 s of delay on every line of rooms with no presenter
  voice; the one first line that may get both voices is played once: the page ignores a second clip of a line), skips a line+language the
  presenter sent a clip for (checked again before delivering), and leaves a language alone while its presenter sent a clip in that language
  in the last `ROOM_SERVER_DUB_PRESENTER_QUIET_MS` (60000). Other languages are still voiced: the desktop app dubs one
  language while viewers may listen to another.
- In order and bounded: per room and language one call in flight, every final line voiced in id order (each at least the
  wait after it arrived); past 4 waiting lines the oldest is dropped, a line older than one already voiced is skipped,
  and each line+language is voiced once (later corrections of the same id are not re-voiced).
- Catching up: the server tracks per language until when the listeners' clips play back to back (`mp3DurationMs`
  counts the mp3 frames: Kokoro's mp3 is VBR and glued from several pieces, so neither the size nor ffprobe's estimate
  is right) and asks Kokoro for `speed` = 1 + queued audio / 20 s, at most 1.3 (MAI-Voice is never sped up). Measured
  on Kokoro: 1.3 → 18 % shorter. Simulated on a real 2 h room (593 lines, Kokoro 15 chars/s): dropped sentences on the
  page 13.5 % (6 s cap, no speed-up) → 0.2 % (25 s cap), voice delay p50 2.6 → 4.0 s, p95 10.5 → 15.0 s (long
  sentences dominate: a 300-character line is a 20 s clip).
  Each attempt has `ROOM_DUB_ATTEMPT_TIMEOUT_MS` (8 s; the OpenRouter SDK client has no timeout of its own): a stuck or
  failed Kokoro call is aborted and the line goes to MAI-Voice 2.1 Flash (`microsoft/mai-voice-2.1-flash`; en
  `en-US-Harper`, fr `fr-FR-Soleil`, pt `pt-BR-Luana`; other languages have no fallback), so a language is held at most
  ~16 s. Failures are logged, never surface to the publisher.
- Server clips go out as `{"type":"audio","lineId","lang","wav":"<base64 mp3>","format":"mp3"}` (`wav` keeps its name;
  `format` is additive, absent = WAV) to the viewers listening to that language only.
- Off everywhere with `ROOM_SERVER_DUB=0`; per room with `"serverDub": false` in `POST /v1/rooms` (default true).
- With server dubbing on, the GET body / snapshot carries `dubLangs` (additive): the languages a listener can hear
  (server-voiced unless the room opted out, plus those the presenter sent clips for). The page offers dubbing ("Écouter le doublage")
  only for those; without `dubLangs` (server dubbing off) it offers every translation language as before.
- Languages the presenter does not publish: the snapshot carries `listenLangs` (additive) = the Kokoro languages that are
  neither a room language nor the spoken one (en, fr, es, pt, it, ja, zh, hi minus those). The page lists them in its
  language menu; for a viewer that listens to or reads one, the server translates each final line from the original
  (`openRouterTranslate`: OpenRouter `google/gemini-2.5-flash-lite`, reasoning off, 6 s), stores it on the line
  (`translations[lang]`, broadcast as a `line` update so every viewer of that language sees it) and voices it for the
  listeners. Switching language catches up from the latest line. Never into the spoken language; nothing without a
  translator. In GPU mode the desktop app voices its own output language (cloned voice on the GPU) and sends the clips,
  which win for that language; every other language comes from OpenRouter as in API mode.

## Viewer pages

- `https://<ROOMS_PUBLIC_HOST>/<CODE>` (Host header match) and `/live/<CODE>` on any host: the room page (French by default, one
  self-contained HTML document, CSP with a per-response nonce, no CDN). Default language: the viewer's saved choice
  for that room, else the first browser language the room publishes (primary subtag: `en-US` → `en`), else the room's
  first target language; the original only when the room has no translations. The live line and the original under it
  are always one line each: the font shrinks down to 70 %, then only the end of the sentence is shown behind "…".
  Dubbing ("Écouter le doublage") plays clips with Web Audio: one AudioContext, back-to-back scheduling with 10 ms fades (no
  clicks), oldest pending clips dropped when more than 25 s is queued. While it is on, the live line switches to a line
  when its clip starts playing (a line without a clip within 4 s is shown anyway) and the delay indicator shows the
  voice delay ("voz 3,2 s" = delayMs + wait until the clip played). Indicator: neutral < 3 s, amber 3–6 s, red above.
  Mobile unlock, inside the tap: `navigator.audioSession.type = 'playback'` and a silent `<audio>` played (otherwise the
  iPhone ringer switch mutes Web Audio), the AudioContext created/resumed and a 1-sample buffer started. A context the
  OS suspends (screen lock, call) is resumed by the next tap. The toggle shows its state under the label, in the
  interface language: off · loading the voice · playing · "tap here to turn the sound on" · decode errors. `listen` is
  re-sent on every reconnect.
- Every display setting is the viewer's own (gear → "Réglages d'affichage": bottom sheet on phones, popover from 768 px),
  kept in that browser's localStorage per app — `ucast-settings-<app>`, where `<app>` is the first 12 hex of sha256 of the
  gateway key user that created the room (all activation keys of the desktop app share one), read once from the older
  `ucast-settings` as a fallback; the language per room in `ucast-lang-<CODE>`: interface language (Français by
  default, Português, English), subtitle language, mode
  (Tradução / Só transcrição / Bilíngue / Só texto completo), original under the translation, dubbing on/off + volume +
  "sincronizar legenda com a voz", text size A−/A+ (live line 20–56 px, transcript 14–24 px), theme (escuro / claro /
  automático), auto-scroll, timestamps, delay indicator. Only the languages the room publishes are offered.
- Quick modes on the toolbar (icons with a tooltip on hover/focus and on tap, the current one pressed; their own row
  under 768 px): translated subtitles, dual subtitles (bilingual), transcript, full text. The dubbed voice stays on the
  dubbing toggle next to the language.
- Karaoke: the words already said are coloured one by one on the live line and the current transcript line. Lines carry
  no word timestamps, so the times are an estimate spread by word length: over the real duration of the dubbed clip from
  its start when the voice is on (sync), else over `speechMs` (15 characters/s of the original) from the line's arrival.
- When the room has a `youtubeUrl`, the toolbar shows a compact "Regarder sur YouTube" link in the interface language
  (YouTube icon; "YouTube" under 480 px), opening in a new tab (`rel="noopener noreferrer"`); it appears, changes or
  disappears live with the `update` message. The page re-checks the link (https + YouTube host) before using it as an `href`.
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
| `ui` | `action` copy/sheet_open/sheet_close/more/reconnect/ended/youtube (tapped the YouTube link) |
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
