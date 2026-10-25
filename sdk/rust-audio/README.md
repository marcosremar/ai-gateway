# ai-gateway-audio (Rust)

On-device speech detection for apps of the ai-gateway, extracted from the ucast.me desktop app (`bc-audio`), which
uses this crate itself — one copy of the code for every app.

- **`SileroVad`**: Silero VAD v5 on ONNX Runtime (`ort` 2.0.0-rc.10, `load-dynamic`; the model is bundled, ~2 MB).
  512-sample frames at 16 kHz → speech probability.
- **`VadLevel`**: what the VAD hears, put at the level of normal speech (target −24 dBFS, up to +12 dB, average over
  3 s, never lowered, nothing under −60 dBFS raised). Silero judges loudness too: on the ucast.me benchmark a talk
  heard ~6 m away in a room with reverb and air-conditioning noise came out at speech probability ~0.05 for 40 s.
  With the level, Spanish WER 29.6 → 17.6 %, eaten words 17.2 → 4.4 %; clean talks, accents and conversations
  unchanged. Only the VAD's copy is levelled: the speech segments keep the audio as it came.
- **`Segmenter`**: probabilities → speech segments: hysteresis, pre/post padding, min/max length, a cut past the
  maximum that waits up to `end_grace_ms` for a pause and then cuts at the quietest point, drafts at pauses
  (`take_peek`) and on a timer (`peek_every_ms`).

- **`MicCheck`**: what is wrong with the microphone, from the audio itself, so an app can tell the person what to
  change. Fed each raw frame and the VAD's probability (no second VAD); a report over the last 30 s once there are
  8 s of sound. Measured on the ucast.me benchmark's room grid (`scripts/voice-level-bench/README.md` has the
  browser version's numbers too) — share of 10 s reports flagged, and the app's WER in that condition:

  | condition | WER | far/echo | noisy | quiet | clipping | hum |
  |---|---|---|---|---|---|---|
  | clean talk / good room (RT60 0.4 s) / conversations / accents | 6.8–7.6 % | 0–3 % | 0 | 0 | 0 | 0 |
  | room RT60 0.8 s at 3 m / 6 m | 10.7 / 17.2 % | 78 / 91 % | 0 | 0 | 0 | 0 |
  | room RT60 1.2 s | 40.8 % | 100 % | 0 | 0 | 0 | 0 |
  | babble at 10 dB | 33.7 % | 47 % | 0 | 0 | 0 | 0 |
  | noise at 5 dB | 18.0 % | 82 % | 82 % | 0 | 0 | 0 |
  | real table microphone (AMI sdm) | 37.8 % (headset 32.4 %) | 19 % | 10 % | 23 % | 0 | 6 % |
  | quiet microphone −25 dB | 7.0 % | 0 | 0 | 100 % | 0 | 0 |
  | clipped ×3 | 6.9 % | 0 | 0 | 0 | 85 % | 0 |
  | 50 Hz hum −35 dB / 60 Hz −55 dB | 7.2 / 6.9 % | 0 | 0 | 0 | 0 | 100 / 4 % |

  Only far/echo and noisy made the transcript worse (`MicIssue::hurts_transcription`); clipping, hum and a quiet
  microphone are real (an audience or a recording hears them) but were transcribed through.

Nothing here touches the network. ONNX Runtime is loaded at run time: set `ORT_DYLIB_PATH` or call
`use_onnx_runtime_at(path)` before the first `SileroVad::new()` (the library: microsoft/onnxruntime 1.22.x).

Most apps want it through the SDK: `ai-gateway-sdk = { …, features = ["audio"] }` gives `SpeechDetector` (level →
Silero → segmenter with the desktop app's settings, VAD created on the first frame) and
`GatewayClient::transcribe_speech`. The browser SDK has the same level in `sdk/browser/voice/voice-level.ts`.

```bash
cd sdk/rust-audio
ORT_DYLIB_PATH=/path/to/libonnxruntime.dylib cargo test
```
