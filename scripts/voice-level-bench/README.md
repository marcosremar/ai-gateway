# Browser VAD with and without the level (`createVoiceLevel`)

Why `sdk/browser/voice` levels what Silero hears by default: measured 2026-10-25 with `bench.ts` — the browser
SDK's real pipeline (`createVoiceActivityPipeline`, Silero v5 on onnxruntime-node, default tuning) over the
ucast.me benchmark sets (`~/.ucast-build/benchmark/sets`, marcosremar2/ucast-benchmark; `room` = the talks heard
~6 m away in a simulated room with reverb RT60 0.8 s and air-conditioning noise at 15 dB).

```bash
ORT_NODE=<path to an onnxruntime-node install> bun scripts/voice-level-bench/bench.ts <set dir>...
```

found = share of the reference speech the pipeline was in `speech` (±0.3 s at each edge not counted); false = share
of the gaps ≥ 1 s between transcribed segments it was in `speech` (in talks those gaps hold laughter, applause and
untranscribed speech, so it is an upper bound); noise-only files (no speech at all) measure false alarms cleanly.

| set | found without → with | false without → with |
|---|---|---|
| room es | 47.6 → **74.0 %** | 1.1 → 2.2 % |
| room pt | 81.2 → 83.7 % | 7.6 → 9.5 % |
| room fr | 86.8 → 87.4 % | 8.2 → 10.2 % |
| room en | 95.4 → 95.5 % | — |
| talk es / fr / pt / en | 91.6 / 90.1 / 91.1 / 98.2 → 91.6 / 90.6 / 91.3 / 98.4 % | es 2.0 → 2.4, fr 7.9 → 9.5, pt 12.4 = 12.4 % |
| accent en (EdAcc) | 88.9 → 89.0 % | — |
| conversation en / pt / es / de | 72.9 / 91.5 / 99.9 / 80.0 → 73.1 / 93.1 / 99.9 / 80.4 % | en 0.5 → 0.3 % |
| **noise only**: air conditioning −50/−40/−30 dBFS, white noise −50/−40/−30 dBFS, digital silence (2 min each) | — | **0.0 → 0.0 %** in all |

Decision: on by default. It finds more speech in every set and never less, a far voice in the room most
(es +26 points), and it never turns noise into speech; the extra "false" in the talks' gaps is real sound heard a
little more, like the speech. `createVoiceActivityPipeline(..., null)` turns it off.

## Microphone advice (`createMicCheck`), 2026-10-25

`mic-check.ts` feeds `createMicCheck` the probabilities the real pipeline gives (null where the RMS gate kept Silero
off); one report every 10 s, share of reports with each issue:

| set | far/echo | noisy | quiet | clipping | hum |
|---|---|---|---|---|---|
| clean talks es/pt, accent en, conversations pt/de, good room (RT60 0.4 s) | 0–7 % | 0 | 0 | 0 | 0–2 % |
| room RT60 0.8 s at 3 m / 6 m, RT60 1.2 s | 87 / 96 / 100 % | 0 | 0 | 0 | 0–2 % |
| babble 10 dB / noise 5 dB | 64 / 85 % | 0 / 74 % | 0 | 0 | 0 |
| real table microphone (AMI sdm) | 18 % | 11 % | 3 % | 0 | 11 % |
| quiet −25 dB / 50 Hz hum −35 dB / 60 Hz hum −55 dB | 0 | 0 | 91 / 0 / 0 % | 0 | 2 / 100 / 5 % |

Same thresholds as the Rust `MicCheck`; the Rust numbers (the desktop app's way) are in `sdk/rust-audio/README.md`.
