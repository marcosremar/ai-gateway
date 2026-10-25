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
