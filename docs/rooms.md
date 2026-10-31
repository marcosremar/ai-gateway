# Live subtitle rooms

A presenter's desktop app (ucast.me) publishes each live subtitle line (original + translations) and optional dubbed
audio clips to a **room**; anyone scans a QR code to `https://live.ucast.me/<CODE>` and follows on their phone. The
transcript stays readable for `ROOMS_RETENTION_DAYS` (30) after the last activity. Code: `src/rooms/`, mounted by
`serve.ts` like `src/realtime` (customRoute for the key-authenticated create, the rest in front of the proxy).

## HTTP API

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /v1/rooms` | gateway key | `{"title"?, "originalLang"?, "languages": ["en","es"], "serverDub"?, "youtubeUrl"?}` | `201 {"code","publishToken","url","expiresAt"}` |
| `PATCH /v1/rooms/:code` | publish token (or the creating / an admin gateway key) | `{"youtubeUrl": "<link>" \| null}` and/or `{"serverDub": true \| false}` (the app's "Dublagem" switch; off = text only, the open pages lose the listen button) | `200 {"code","youtubeUrl","serverDub"}` |
| `POST /v1/rooms/:code/lines` | publish token (or the creating / an admin gateway key) | `{"id", "original", "originalLang"?, "translations": {"en": "…"}, "ts"?, "delayMs"?, "speechMs"?, "draft"?}` | `204` |
| `POST /v1/rooms/:code/audio` | publish token | `{"lineId", "lang", "wav": "<base64>"}` (≤ 2 MB decoded) | `204` (broadcast only, never stored) |
| `PUT /v1/rooms/:code/voice` | publish token (or the creating / an admin gateway key) | `{"lang", "ref_audio": "data:audio/…;base64,…", "ref_text"}` (≤ 512 KB decoded) | `204` (memory only, never served) |
| `POST /v1/rooms/:code/end` | publish token | — | `204` |
| `GET /v1/rooms/:code` | public, CORS `*` | — | `200 {"code","title","originalLang","languages","createdAt","ended","expiresAt","youtubeUrl","lines":[…]}` / `404` |
| `GET /v1/rooms/:code/ws` | public WebSocket | — | see below |

- Code: 6 characters of `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L); lower case is accepted in URLs.
- `id` is monotonic per room; re-sending an id replaces that line (idempotent). Out-of-order ids are kept in id order.
- `expiresAt` in the GET body is an addition to the original contract (the page shows it after the end).
- `delayMs` (additive, optional): ms from the end of speech to the subtitle being ready, an integer 0–120000 (else 400).
- `speechMs` (additive, optional): how long the speaker took to say the line, ms, 0–120000. The server dub speaks at the speaker's pace: letters of `original` per second against Kokoro's 14, clamped to 0.85–1.2×, multiplied by the catch-up speed (≤ 1.3×).
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
`{"type":"audio","lineId","lang","wav"}`, `{"type":"audio-chunk","lineId","lang","seq","rate","pcm"}` (a piece of a
server-voiced line while it is being synthesized, see below), `{"type":"update","youtubeUrl","dubLangs"?,"listenLangs"?}` (room fields
changed; the language lists when the speaker's voice switches them, see below), `{"type":"ended"}`. Client → server: `{"type":"ping"}` (→ `{"type":"pong"}`)
and, optionally, `{"type":"listen","lang":"en"|null,"view":"en"|null,"chunks":true?}`: once sent, audio clips arrive only for `lang`
(`null` = none), so viewers who do not listen to the dubbing do not download it; `view` (additive) is the language on
screen, which makes the server translate lines into a `listenLangs` language for a reader; `chunks` (additive) asks
for server-voiced lines as `audio-chunk` pieces instead of one `audio` clip. The server pings every 25 s.

## Server dubbing

When the presenter sends text only, the gateway voices the lines itself with Kokoro 82M (`hexgrad/kokoro-82m`) through
OpenRouter (`OPENROUTER_API_KEY`, mp3, ~$0.62 per million characters). Code: `src/rooms/dub.ts`, wired in `serve.ts`.

- Voices (primary subtag): en `af_heart`, fr `ff_siwis`, es `ef_dora`, pt `pf_dora`, it `if_sara`, ja `jf_alpha`,
  zh `zf_xiaobei`, hi `hf_alpha`. Other languages are not voiced.
- **Pocket TTS first (user decision 2026-10-19)**: with `POCKET_TTS_API_KEY` set (the `pocket` provider is mounted, see
  below) the rooms speak Pocket's languages with Pocket (`pocketTts`, src/tts): en `alba`, fr `estelle`, de `juergen`,
  pt `rafael`, es `lola`, it `giovanni`, nl `daan` — the voice recorded in each language (any Pocket voice speaks every
  language, but with its own accent; a room knows nothing of the speaker's gender). German and Dutch become dubbable
  (`dubLangs` / `listenLangs`). Order per line: the speaker's clone (below) → Pocket → Kokoro. A Pocket 503 `loading`
  (a language loaded on its first request: de, it, nl… unless in `POCKET_PRELOAD`) or `busy`, an error, or no first
  audio within 4 s (`POCKET_FIRST_AUDIO_MS`) → that line goes to Kokoro (own server, then OpenRouter); a language only
  Pocket speaks (de, nl) loses that line's voice. Loading/busy never feed the breaker (`cold`/`saturated`, neutral);
  real failures do (`tts:pocket:pocket`, shared with the app chains' `pocket` link). Streamed like Kokoro (24 kHz PCM
  pieces to the page). **No speed**: Pocket has none (the server ignores `speed`), so Pocket lines get neither the
  speaker's pace nor the catch-up speed — Pocket speaks ~2× faster than real time, the backlog bound (4 waiting) and
  the page's 6 s drop still apply. **One call at a time per room language** (`TtsStream` `maxParallel` 1): the server
  speaks one sentence at a time per language and a second call waits ≤ 2 s then gets 503 `busy`, which would switch
  that line to Kokoro's (other) voice. Without the key: Kokoro alone, as before.
- Spend only on demand: a line+language is synthesized only while at least one viewer has sent `listen` for that
  language (a viewer that never sent `listen` does not count) and the line has a non-empty translation for it.
- The presenter wins: in a language the presenter has sent clips in, the server waits `ROOM_SERVER_DUB_WAIT_MS` (1500)
  after a line (elsewhere it voices at once — the wait was 1.5 s of delay on every line of rooms with no presenter
  voice; the one first line that may get both voices is played once: the page ignores a second clip of a line), skips a line+language the
  presenter sent a clip for (checked again before delivering), and leaves a language alone while its presenter sent a clip in that language
  in the last `ROOM_SERVER_DUB_PRESENTER_QUIET_MS` (60000). Other languages are still voiced: the desktop app dubs one
  language while viewers may listen to another.
- Through the gateway TTS module (`src/tts`): each room language is a `TtsStream` — one Kokoro call per waiting line,
  so more calls run at once while the provider is slow (up to `TTS_MAX_PARALLEL`, 6) and none is ever sent twice (no
  hedge: no extra spend); clips delivered in id order (a slow line holds the ones behind it, never blocks their
  synthesis; a translation goes out as soon as it is ready); past `TTS_MAX_WAITING` (4) waiting lines the oldest is
  dropped, a line older than one already voiced is skipped, and each line+language is voiced once (later corrections
  of the same id are not re-voiced). Synthesis is `kokoroTts`: the gateway's own routing (`routeRequest`: circuit
  breakers, per-call timeout, link-reorder ranks equivalent Kokoro links by latency once there is more than one).
- Catching up: the server tracks per language until when the listeners' clips play back to back (`clipDurationMs`:
  the PCM length; for an mp3 clip `mp3DurationMs` counts the frames, since a VBR mp3 glued from several pieces fools
  both the size and ffprobe) and asks Kokoro for `speed` = 1 + queued audio / 20 s, at most 1.3 (`catchUpSpeed`; queued audio = what is
  scheduled + the lines still being voiced × the average clip). Measured
  on Kokoro: 1.3 → 18 % shorter. Simulated on a real 2 h room (593 lines, Kokoro 15 chars/s): dropped sentences on the
  page 13.5 % (6 s cap, no speed-up) → 0.2 % (25 s cap), voice delay p50 2.6 → 4.0 s, p95 10.5 → 15.0 s (long
  sentences dominate: a 300-character line is a 20 s clip).
- Realtime dubbing, a per-room option (`PATCH {"steadyDub": true}`, the app's Advanced → "Dublagem em tempo real", off by default; user decision 2026-10-31: no LLM, it changed the meaning): no line is dropped. The voice loses what says nothing (`withoutFiller`: phrases said twice in a row, filler alone between punctuation, per language), every voice runs at 1.1× and up to 1.5× as the queue grows (`steadySpeed`; Pocket and the clone time-stretched by `PcmStretcher`, same pitch), Pocket and Kokoro clips lose leading/trailing silence (`trimClip`), lines waiting from 8 s of queue or a full line go out together, at most 4 per clip, and the page never drops (`dubBacklogS`). The subtitle stays whole.
  Kokoro only (user decision 2026-10-17: no paid fallback voice — ElevenLabs/MAI-Voice cost 25–30× more): each call
  has `TTS_CALL_TIMEOUT_MS` (15 s; the OpenRouter SDK client has no timeout of its own); a failed or stuck call
  loses that line's voice (its text stays). Kokoro on OpenRouter (DeepInfra, Together) answered in 0.7–2.9 s per
  sentence on 2026-10-16 and in 6–25 s on 2026-10-17; with the calls in parallel the voice then lags by about one call
  instead of falling further behind. OpenRouter ignores `provider` routing on `/audio/speech` (measured 2026-10-17: a
  request pinned to Together was served by DeepInfra), so the only way to pick the faster Kokoro is a second source
  (another link in `kokoroTts`), which link-reorder then ranks automatically. Failures are logged, never surface to the publisher.
- Streamed voice: Kokoro is asked for a streamed WAV (OpenRouter `pcm`, 24 kHz s16 mono; `pcmOfWavStream` drops the
  header, keeps the samples aligned and gives up after 15 s without bytes). Viewers that sent `"chunks":true` get the
  head line's PCM as it arrives, in pieces of at least 250 ms:
  `{"type":"audio-chunk","lineId","lang","seq","rate":24000,"pcm":"<base64 s16le>"}` (seq from 0); the other listeners
  get the whole line as `{"type":"audio","lineId","lang","wav":"<base64 WAV>","format":"wav"}` once it is complete.
  A clip the server voiced also carries `"engine"`: `"clone"` (Qwen3-TTS in the speaker's voice), `"pocket"` or
  `"kokoro"`. `__tests__/room-dub-live.test.ts` (`ROOMS_LIVE_URL`, `GATEWAY_API_KEY`; `ROOM_DUB_CLONE=1`,
  `ROOM_DUB_STT_MODEL`, `ROOM_DUB_EXPECT_ENGINE`) checks a French speaker dubbed in English on a running gateway.
  Lines still go out in id order: a line synthesized while an earlier one is still streaming waits and is sent right
  after it. Measured 2026-10-18 on OpenRouter Kokoro (typical lines, 72–168 chars): first audio 0.7–6.5 s after the
  request (queueing upstream, not length), the whole clip 0.4–0.65 s later — that is what streaming saves. Splitting a
  sentence at its first comma saved ~80 ms (median 1050 → 969 ms over 9 pairs), so lines are not split. Cost: PCM is
  ~64 KB/s of speech on the wire (base64) vs ~7.5 KB/s for Kokoro's 60 kbit/s mp3. Only to that language's listeners.
- Own Kokoro (`docker/kokoro-stream`, models in `marcosremar2/kokoro-82m-streaming-onnx`): with `KOKORO_STREAM_URL`
  and `KOKORO_STREAM_API_KEY` set it is the first Kokoro link and OpenRouter the second (a voice it lacks — ja, zh —
  or a 503 `busy` falls through). Kokoro split into two ONNX parts: the text/prosody part and the harmonic source run
  on the whole sentence; the vocoder (~97 % of the CPU time) runs in windows of frames. It is Kokoro's own generator
  with its instance norms (statistics over the whole sentence) replaced by fixed scale/shift, fine-tuned 1 h 20
  against the original (`training/`), so a sentence streamed in windows is identical to the whole one (≥ 93 dB SNR)
  and sounds like the original (Whisper WER 2.7 % vs 2.7 %, DNSMOS 3.43 vs 3.41 on 25 sentences). The leading pause
  token (0.2–0.5 s of silence) is skipped, long first sentences start with their first clause, and each sentence's
  first window has its own 8-thread session (`KOKORO_OPENING_THREADS`; later windows `KOKORO_LATER_THREADS`, 2).
  Measured 2026-10-18 on an Apple M5 CPU (loaded): first 250 ms of voice 0.14–0.22 s after the request (stock Kokoro:
  whole sentence 0.25–0.7 s, voice after 0.2–0.4 s of silence); local room line → first piece on the page p50
  ~150–250 ms with one language, ~250–370 ms with two at once (the machine's load swings it), vs 11.7 s on OpenRouter
  that night. Pauses as quiet as the stock model (−45 dB); TorchStream's running statistics left −20 to −30 dB of noise.
  Portuguese (2026-10-18): stressed é/ê, ó/ô come from Wiktionary (`vowels.py`, `pt_vowels.tsv`, same table as the
  desktop app); `normalize.py` writes ordinals, decimals, phone numbers, units, Av./nº and acronyms as people say them
  ("IBGE" spelled, "SUS" read as a word). Whisper round trip on 105 pt sentences: 4.7 % WER. The server loads the
  espeak-ng 1.52 bundled with espeakng-loader itself — misaki only sets a library on macOS/Windows, so on Linux it failed.
  On a GPU: install onnxruntime-gpu and set `KOKORO_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider` (default CPU).
- **Own speech server in the app chains** (2026-10-19, `src/gateway/providers/cloud/kokoro-stream/route-tts.ts`): the
  same server is also a link of the app TTS aliases — `{"provider": "kokoro-stream", "model": "hexgrad/kokoro-82m"}`
  (mounted with `KOKORO_STREAM_API_KEY`) and `{"provider": "pocket", "model": "pocket"}` (mounted with
  `POCKET_TTS_API_KEY`; `POCKET_TTS_URL`, default `KOKORO_STREAM_URL`). Why: 2026-10-19 right after a deploy both
  babelcast GPUs were off and OpenRouter timed out at the 8 s TTS budget, so the app's dubbing line got 503. Only wav/pcm
  requests go to it (mp3 & co. → 415, the chain moves on without feeding a breaker). The voice comes from the request's
  `language` ("Portuguese", "pt", "pt-BR"…): Kokoro keeps a voice it has in that language, else `af_heart`/`ef_dora`/
  `ff_siwis`/`pf_dora`/`if_sara`/`hf_alpha` (all feminine — the only voices exported, `export.py`); Pocket keeps a Pocket
  voice the app names (`rafael`, `estelle`, `alba`…), else the language's voice by the gender of a Qwen3 preset ("Ryan"
  → pt `rafael`, en `marius`; "Vivian" → pt `estelle`, en `alba`). No language it speaks → refused, next link. Time to
  first audio: hedge 1.5 s (`OWN_TTS_HEDGE_MS`) — the cloud link behind it starts in parallel — and 4 s limit
  (`OWN_TTS_TIMEOUT_MS`); a stuck synthesis falls back instead of handing out a silent stream (the provider now resolves
  at the first PCM bytes). Order: after the deployments, BEFORE OpenRouter (next to the gateway, first audio
  ~0.15–0.4 s, no per-call cost); behind a hanging OpenRouter it would still answer through the cloud hedge
  (min(4 s, half the budget left)), but ~4 s late. The fallback probe speaks "Bom dia." to it with `language: pt`. It is
  not a cloud link: a chain of only these still gets the OpenRouter default appended.
- **Pocket TTS** (Kyutai, CPU, `docker/kokoro-stream/pocket.py`): `"model": "pocket"` on the same `/v1/audio/speech`,
  off unless `POCKET_TTS=1` on the server. One model per language (en fr de pt es it nl, ~220 MB each), loaded in the
  background — at start for `POCKET_PRELOAD` (e.g. `pt,en,fr,es`), else on the first request, which gets 503 `loading`
  (the gateway speaks that line with Kokoro). One sentence at a time per language (`POCKET_WAIT_S`, 2 s, then 503
  `busy`); `POCKET_THREADS` (4) torch threads; `POCKET_QUANTIZE=1` int8. A language not used for `POCKET_IDLE_UNLOAD_S`
  (900 s; 0 = never) is unloaded (model and voice states dropped, memory given back) and loads again on its next
  request — preloaded ones too; Kokoro stays loaded as the always-on fallback. Predefined voices only (public weights without
  voice cloning, no HF token). `speed` is ignored. Measured on this laptop's CPU (Core Ultra 7, loaded): first audio
  0.16 s, 3.8 s of speech in 1.8 s; load + warm-up of one language ~60 s. The image bakes the weights and default voices
  of `POCKET_BAKE` (pt,en,fr,es,it,de) at build (`WITH_POCKET=0` leaves Pocket out: no torch).
  **Own model per language** (`POCKET_CUSTOM`, `<language> <voice> <config.yaml> <voice.safetensors>`, comma-separated):
  that language loads its own config and speaks only its fixed voice, whatever Pocket voice the gateway names (rooms
  send pt `rafael`; predefined voices do not run on other weights), numbers through `normalize.py` as always; `/health`
  shows `pocket.custom`. Brazilian Portuguese = [Erinome](https://huggingface.co/marcosremar2/pocket-tts-erinome-pt)
  (6 layers, fine-tuned from Kyutai's `portuguese_24l` and distilled): `POCKET_CUSTOM="pt erinome
  hf://marcosremar2/pocket-tts-erinome-pt/erinome_6l.yaml@3d1c596927606badfd643a01682b0feedcd58daa
  hf://marcosremar2/pocket-tts-erinome-pt/erinome_6l_voice.safetensors@3d1c596927606badfd643a01682b0feedcd58daa"` (one
  line). The image bakes it at build (the Dockerfile's `POCKET_CUSTOM` build arg defaults to it; Railway passes the
  service variable as that build arg), but the server only uses it with `POCKET_CUSTOM` set at run time.
- Deploying the server: no image is built by hand. `.github/workflows/kokoro-stream.yml` builds it on every PR that
  touches it and pushes `ghcr.io/<owner>/kokoro-stream:<date>` from main; or a Railway service builds it from the repo
  (root `docker/kokoro-stream`, config `docker/kokoro-stream/railway.json`). The server's `KOKORO_API_KEY` is the
  gateway's `KOKORO_STREAM_API_KEY` (and `POCKET_TTS_API_KEY` when Pocket is on); `KOKORO_STREAM_URL` =
  `http://<service>.railway.internal:<port>/v1` (private network, not a local link: no `localLinkRefusal`).
- Off everywhere with `ROOM_SERVER_DUB=0`; per room with `"serverDub": false` in `POST /v1/rooms` (default true).
- With server dubbing on, the GET body / snapshot carries `dubLangs` (additive): the languages a listener can hear
  (server-voiced unless the room opted out, plus those the presenter sent clips for). The page offers dubbing ("Écouter le doublage")
  only for those; without `dubLangs` (server dubbing off) it offers every translation language as before.
- Languages the presenter does not publish: the snapshot carries `listenLangs` (additive) = the Kokoro languages that are
  neither a room language nor the spoken one (en, fr, es, pt, it, ja, zh, hi minus those; + de, nl with Pocket). The page lists them in its
  language menu; for a viewer that listens to or reads one, the server translates each final line from the original
  (`openRouterTranslate`: OpenRouter `google/gemini-2.5-flash-lite`, reasoning off, 6 s), stores it on the line
  (`translations[lang]`, broadcast as a `line` update so every viewer of that language sees it) and voices it for the
  listeners. Switching language catches up from the latest line. Never into the spoken language; nothing without a
  translator. In GPU mode the desktop app voices its own output language (cloned voice on the GPU) and sends the clips,
  which win for that language; every other language comes from OpenRouter as in API mode.

### In the speaker's voice (GPU mode)

When the presenter's app is in GPU mode it sends the voice of the person speaking: `PUT /v1/rooms/:code/voice`
`{"lang": "<spoken language>", "ref_audio": "data:audio/ogg;base64,…", "ref_text": "<exactly what it says>"}` — the
same 5–8 s reference its own dubbing clones (`bc-pipeline` `VoiceCloner`), once per spoken language and again when
another person starts speaking. API and Local mode never send it.

- Privacy: the reference is the speaker's voice. Kept in memory only (`RoomDubber` state, one per spoken language, the
  latest replaces the previous one), never written to the room store, never in the GET body, the WS snapshot or any
  message; dropped when the room ends or leaves memory (evicted, expired, gateway restart). `ref_audio` must be a
  `data:audio/…;base64` URL (never a URL the gateway would fetch), at most 512 KB decoded; `ref_text` non-empty.
  Accepted and ignored (204) when server dubbing is off.
- Synthesis: `deploymentClone` (`src/tts`) — Qwen3-TTS 0.6B **Base** (`Qwen/Qwen3-TTS-12Hz-0.6B-Base`) on the
  deployment `ROOM_VOICE_CLONE_DEPLOYMENT` (default `babelcast-tts-clone`, the first link of the babelcast app's
  `babelcast-tts`), through `routeRequest` (one request per sentence, no hedge, 15 s), as WAV with `task_type: "Base"`,
  `ref_audio`, `ref_text` and the target `language`. Used only while that deployment has a ready replica: the room
  never wakes it (`noWake` lease, no wait); cold → Kokoro as above. A line is voiced in the voice of the reference for
  its `originalLang`; no reference for that language, or the clone call failed → Pocket, then Kokoro (a language neither
  speaks then has no voice for that line). No catch-up `speed` on the clone.
- Languages: while cloning (a reference arrived and the deployment is serving), `dubLangs` / `listenLangs` follow
  Qwen3-TTS — en, zh, ja, ko, de, fr, ru, pt, es, it (Korean and Russian become available, Hindi and Dutch do not);
  otherwise Kokoro's plus Pocket's. When a reference switches them, open pages get `{"type":"update"}` with the new lists.

## Viewer pages

Local preview: `bun --watch scripts/room-page-demo.ts` serves a demo room on `http://localhost:4610/live/<CODE>` (real rooms code, lines every 5 s, silent server voice) and restarts on every edit of `src/rooms/page.ts`. The pages use the self-hosted Bricolage Grotesque (OFL, `src/rooms/fonts`, served at `/live/fonts/*` with a one-year cache).

- `https://<ROOMS_PUBLIC_HOST>/<CODE>` (Host header match) and `/live/<CODE>` on any host: the room page (French by default, one
  self-contained HTML document, CSP with a per-response nonce, no CDN). Default language: the viewer's saved choice
  for that room, else the first browser language the room publishes (primary subtag: `en-US` → `en`), else the room's
  first target language; the original only when the room has no translations. The live line and the original under it
  are always one line each: the font shrinks down to 70 %, then only the end of the sentence is shown behind "…".
  Dubbing ("Écouter le doublage") plays clips with Web Audio: one AudioContext, back-to-back scheduling with 10 ms fades (no
  clicks; the `audio-chunk` pieces of one line join without a fade, it fades in only at its start or after a gap),
  oldest pending lines dropped whole (never part of a line) when more than 25 s is queued. While it is on, the live line switches to a line
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
