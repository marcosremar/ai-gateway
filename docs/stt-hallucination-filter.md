# STT hallucination filter

Speech models invent text on silence and noise. In a class test Whisper wrote "E aí" on 3 of 6 silent clips and the NPC
answered as if the student had spoken. The filter lives in the gateway so that every client and every STT provider gets it.

## Entry points

| Entry point (live) | Filtered? | How |
|---|---|---|
| `POST /v1/audio/transcriptions` | yes | `src/gateway/proxy/routes/audio-transcriptions.ts` → `stt-filter.ts` → `src/stt-hallucination-filter.ts`; asks providers for segments (`wantSegments`) |
| `POST /v1/s2s`, composed path (and the hedge) | yes | loopback calls the route above; `filtered` event + empty `done`, no LLM/TTS call |
| `POST /v1/s2s`, primary (speech-stack replica) | yes | `src/s2s/route.ts` filters the `transcript` event, cancels the replica stream, lease released healthy |
| `/v1/deployments/:name/invoke/...` | no, by design | raw passthrough to the replica (load tests); use the two routes above |
| `/ws/audio-stream` (replica streaming STT) | no | the gateway answers every WebSocket upgrade except dev HMR with 410, so nothing live reaches it through the gateway; a client talking to a replica directly bypasses the gateway |
| SDK `GatewayClient` direct fallback (gateway down) | yes | `sdk/node/direct-fallback.ts` runs the same library locally (blocklist + metadata when the provider is Whisper) |
| legacy `server/*` handlers, `src/modules/*`, `src/sdk/client.ts` (`/v1/transcribe`) | not mounted by `serve.ts` | `server/ai-handlers.ts` still uses the library with its own defaults; untouched |

## Where the metadata comes from

| Provider | Metadata |
|---|---|
| OpenAI-compatible (Groq, Fireworks…), Ollama, self-hosted OpenAI server, OpenAI `whisper-1` | `verbose_json` segments (`stt-segments.ts`) |
| OpenAI `gpt-4o-*transcribe`, Deepgram, ElevenLabs, Modal/MLX variants | none: blocklist only |
| Deployment replica (`DeploymentSTTProvider`) | asks `verbose_json`; a replica that refuses it (4xx) is asked again with `json` and remembered |
| speech-stack replica (`docker/speech-stack`) | flat `no_speech_prob`, `avg_logprob`, `compression_ratio` on the transcript event and the STT route (needs a rebuilt image; older images send text only) |

## Rules

1. Metadata layer: a segment is dropped when `no_speech_prob` > 0.6, or `compression_ratio` > 2.4, or `avg_logprob` < -1.0.
   A provider with one flat set of metrics is judged as a single segment.
2. Blocklist layer (`src/data/whisper-hallucinations.json`, matched after normalizing case, punctuation and hyphens):
   - high-confidence phrases (boilerplate vocabulary such as amara/legendas/inscreva-se/merci d'avoir regardé, or 6+ words, or
     the explicit "e aí" listed by the owner) are dropped in any language, with or without metadata;
   - ambiguous phrases (short or generic: "eu não sei", "muito bom", "ainda não"…) are dropped only for the request language and
     only when the answer's `no_speech_prob` >= 0.4;
   - learner-safe words ("sim", "não", "oi", "obrigado", "tchau", "bom dia", "merci", "oui"…) are never dropped by the blocklist alone.

3. Pattern layer (`src/stt-hallucination-patterns.ts`, high confidence, any language; QA 2026-10-07 on Whisper large-v3:
   "Legenda por Sônia Ruberti" over room tone and music, "E aí ♫ E aí E aí…" over keyboard clicks both passed the blocklist):
   - `pattern_credits`: a subtitle/caption credit line of at most 12 words — "Legenda(s) por/pela…", "Legendado por…",
     "Legendas pela comunidade…", "Sous-titres réalisés par…", "Sous-titrage…", "Subtitles/Captions by…", "Subtítulos por/realizados
     por…", "Subtitulado por…" (regex on the normalized text, so any name follows; "legenda, por favor" is not one);
   - `music`: text wrapped in ♪♫, mostly made of them, or carrying them around a loop;
   - `repetition`: the same 1–3-word phrase repeated back to back covering ≥ 70 % of the words — 3 repeats of a 2–3-word
     phrase, 4 of a single word ("sim sim", "não, não" and "sim, sim, sim" stay).
   Off with the config field `patternFilterEnabled: false` (the env switch `STT_HALLUCINATION_FILTER=0` turns all layers off).

Measured on 242 plausible A1 utterances (`__tests__/unit/stt-filter/a1-utterances.json`, repeated answers such as "sim sim",
"não, não", "oui, oui, oui" and "legenda, por favor" added on 2026-10-07): 0 dropped by the blocklist and the patterns.
Known cost: a learner who says exactly "E aí" is dropped; so is a word said four times in a row, or a phrase three times.

Every `200` of the STT route carries `X-STT-Filtered`: the reason codes, `none` when the answer was kept, `off` when the
filter did not run, plus `X-STT-Raw-Length` — so a client can count kept / filtered / unfiltered answers.

## Design choices to pilot and pre-register

The thresholds (-1.0 instead of the library's -0.8, 0.4 for ambiguous phrases), the 6-word cut, the learner-safe list, the
ALWAYS_BLOCK list and the pattern limits (12-word credit lines, 70 % loop coverage, 3/4 repeats) are design choices, not published values. They should be piloted against recorded silent and real clips
(false-drop rate on learner speech, false-keep rate on silence) and pre-registered before they count in a study. Each threshold
has an env override (`docs/api/http.md`).

## Sources

- Radford, A., Kim, J. W., Xu, T., Brockman, G., McLeavey, C., Sutskever, I. (2023). Robust Speech Recognition via Large-Scale
  Weak Supervision. ICML 2023 (PMLR 202). arXiv:2212.04356 — no-speech/log-probability/compression-ratio signals and 0.6, -1.0, 2.4.
- Koenecke, A., Choi, A. S. G., Mei, K. X., Schellmann, H., Sloane, M. (2024). Careless Whisper: Speech-to-Text Hallucination
  Harms. ACM FAccT 2024, DOI 10.1145/3630106.3658996 — about 1% of Whisper transcripts contain invented phrases; pauses trigger them.
  (Both references checked against the publisher/arXiv listings on 2026-10-06.)
- Blocklist data: sachaarbonel/whisper-hallucinations (community dataset, not peer reviewed).
