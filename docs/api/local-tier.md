# Local tier (browser)

`@parle/ai-gateway/local` runs STT, TTS and a small LLM on the user's device (WebGPU, else WASM) and falls back to the
gateway. The gateway stays the path that always answers: every local miss — refused stage, model still loading, error,
deadline, low confidence — goes to the gateway client the app passes in.

**Nothing changes for an app that does not opt in.** The default policy of every stage is `gateway-only`: the call goes
straight to the gateway client with the same request object, no device probe, no model download.

## Opting in

The SDK has no dependency on the model libraries. The app injects loaders, the same way the voice SDK takes
`loadOrt: () => import('onnxruntime-web/wasm')`, and pins the versions itself:

```ts
import { GatewayClient } from '@parle/ai-gateway/client';
import { createLocalTier, espeakPhonemizer, kokoroTts, webLlm, whisperStt } from '@parle/ai-gateway/local';

const gateway = new GatewayClient({ baseUrl, apiKey });
const local = createLocalTier({
  gateway,
  policy: { stt: 'local-first', tts: 'local-first', llm: 'gateway-first' },
  models: {
    stt: whisperStt({ loadTransformers: () => import('@huggingface/transformers') }),               // 4.3.0
    tts: kokoroTts({
      loadKokoro: () => import('kokoro-js'),                                                       // 1.2.1
      phonemize: espeakPhonemizer(() => import('espeak-ng').then(m => m.default), espeakWasmUrl), // 1.0.2
    }),
    llm: webLlm({ loadWebLlm: () => import('@mlc-ai/web-llm') }),                                   // 0.2.85
  },
  telemetry,                         // the browser emitter of @parle/ai-gateway/telemetry (optional)
  onProgress: p => showLoad(p),      // { stage, model, device, status, progress 0..1, loadMs }
});

void local.prefetch();               // background download + warm-up; cached by the libraries (Cache Storage)
const { text, servedBy, reason } = await local.transcribe({ file: wav, model: 'parle-stt', language: 'pt' });
const speech = await local.speak({ model: 'parle-tts', input: 'Bom dia!', voice: 'br-f-01', fallback_voice: 'pf_dora' });
const reply = await local.chatStream({ model: 'parle-llm', messages });
```

`transcribe`, `speak`, `chat` and `chatStream` take the `GatewayClient` request (`transcribe`, `speech`, `chat`,
`chatStream`) and return its result plus `servedBy: 'local' | 'gateway'` and `reason` (why the gateway served a call
the policy wanted local, or `gateway_error` when gateway-first fell back to the device). A local answer carries
`served.provider = 'local:<model id>'`; local speech is always `audio/wav`, whatever `response_format` asked.

| policy | behaviour |
|---|---|
| `gateway-only` (default) | gateway only; the local tier is never touched |
| `local-first` | device first; on a miss, the gateway. A model still loading answers from the gateway at once (`loading`) |
| `gateway-first` | gateway first; when it fails, the device (waiting for the model within the stage deadline); both fail → the gateway error |

| reason | meaning |
|---|---|
| `refused` | the capability check kept the stage off this device (`admission()` says why) |
| `loading` | the model is not ready yet |
| `error` | the model failed to load, or the call threw (e.g. a voice Kokoro cannot phonemize) |
| `timeout` | the stage deadline passed (`deadlineMs`, default STT 8 s, TTS 8 s, LLM 15 s; LLM streams: to the first token). A loaded stage that misses its deadline once is sent to the gateway for the rest of the session |
| `low_confidence` | STT: empty text or average token log-probability below `minAvgLogprob` (default −1, Whisper's own `logprob_threshold`, Radford et al. 2023, arXiv:2212.04356); TTS: silent output; LLM: empty answer |
| `gateway_error` | gateway-first: the gateway failed and the device answered |

A call the caller aborted (`signal`) is not retried anywhere.

## Capability check and memory budget

`admission()` probes `navigator.gpu.requestAdapter()` (WebGPU, `shader-f16`), the mobile flag, `deviceMemory` and
`navigator.storage.estimate()`, then admits stages in the order TTS, STT, LLM while they fit a memory budget: WebGPU
first, the WASM variant when the WebGPU one does not fit, refused (`unsupported`, `over_budget`, `storage`) otherwise.

The default budget is **350 MB on a phone** (the parle iPhone 12 loses the tab above ~1.1 GB of WebContent, and the
page itself needs most of that) and `deviceMemory × 256 MB` (else 2 GB) on a computer. On a phone that is TTS + STT on
WASM and no LLM. Pass `budgetMb` to change it. Footprints are estimates (download size, plus runtime overhead); each
adapter takes `size` to override them.

| stage | model (default) | WebGPU | WASM |
|---|---|---|---|
| STT | `onnx-community/whisper-base` (transformers.js) | encoder fp32 + decoder q4: 210 MB download, ~320 MB | q8: 80 MB, ~160 MB |
| TTS | `onnx-community/Kokoro-82M-v1.0-ONNX` (kokoro-js) | fp32: 330 MB, ~420 MB | q8: 95 MB, ~180 MB |
| LLM | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` (web-llm; q4f32 without `shader-f16`) | ~300 MB, ~1 GB VRAM | — |

`whisperStt({ model: 'onnx-community/whisper-tiny', size })` and `webLlm({ model: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', size })`
swap the model.

Kokoro voices: English (`a*`, `b*`) go through kokoro-js; Portuguese (`pf_dora`, `pm_alex`, `pm_santa`), French
(`ff_siwis`), Spanish, Italian and Hindi need `phonemize` (kokoro-js 1.2.1 only phonemizes English). `espeakPhonemizer`
runs espeak-ng (WASM, all languages, GPL-3.0, ~18 MB) with the voice's espeak language (`pt-br`, `fr-fr`…) and maps
its IPA to Kokoro's symbols the way Kokoro's own G2P does; the wasm module is compiled once (≈ 20 ms per call instead of
≈ 370 ms). The voice is `voice` when it is a Kokoro voice, else `fallback_voice`.

## Privacy

With `local-first`, a call the device serves never leaves it: the audio, the text and the reply stay in the page
(`servedBy: 'local'`). A fallback sends the request to the gateway exactly as `gateway-only` would; `servedBy` says
which happened. Telemetry carries codes and durations only (below), never audio or text. The models are downloaded
from Hugging Face (and the web-llm model library from GitHub) and cached by the libraries in Cache Storage.

## Telemetry

With `telemetry` (the browser emitter), each call emits `local.call` (`durMs`; attrs `stage`, `policy`, `served_by`,
`reason`, `device`) and each model load `local.load` (`durMs`; attrs `stage`, `model`, `device`, `ok`). Calls of a
`gateway-only` stage are counted too, so the local share of an app is `served_by = local` over all `local.call`.

## Measured (Apple M5, 10-core GPU, WebGPU, Chromium; 15/10/2026)

Text: «Olá! Eu queria um pão francês e um café, por favor.», voice `pf_dora`, round trip TTS → STT.

| stage | load, cold (parallel download) | load, cached | warm call |
|---|---|---|---|
| STT whisper-base WebGPU | 33 s | 1.9–2.6 s | 0.4–0.7 s for 3.2 s of audio, exact transcript, avg log-prob −0.10 |
| TTS Kokoro fp32 WebGPU | 44 s | 17–23 s (see below) | 0.55–0.6 s for 3.2 s of audio (first call 1.0 s: espeak compile) |
| LLM Qwen2.5-0.5B q4f16 | 34 s | 2.6–3.1 s | first token 25–70 ms, 0.2–0.4 s per short answer |

Phone profile (mobile user agent, 350 MB budget, WASM on the same CPU, single thread): STT 4.3 s for 3.2 s of audio,
TTS 9.6 s (the first call missed the deadline, so the next ones went to the gateway), LLM refused. A real phone is
slower; on phones without WebGPU, `gateway-first` (the device as the offline backup) is the realistic policy.

## Limits

- Kokoro on WASM runs on the calling thread (kokoro-js does not expose ONNX Runtime's proxy worker): the page freezes
  while it synthesizes, and the deadline can only be checked afterwards. Whisper on WASM runs in ONNX Runtime's proxy
  worker. An app that needs local TTS on a phone without WebGPU should run the tier in a worker.
- Kokoro fp16 on WebGPU is smaller and faster but its Portuguese came back unintelligible (Whisper heard «Olá!
  Equilhinho!»), so WebGPU uses fp32. The 326 MB fp32 file was not stored in Cache Storage by the embedded Chromium
  used for the measurement (`Cache.put` failed), so it downloaded again on each visit there.
- Kokoro reads at most 510 phoneme tokens per call (longer text is truncated).
- No `dispose()`: one tier per page.
- WASM threads need cross-origin isolation (COOP/COEP); without it ONNX Runtime uses one thread.

## Demo

`bun --port=5181 examples/local-tier/index.html`: choose a policy per stage and a budget, load the models, speak,
transcribe (the microphone, or the synthesized speech), chat; each call shows `servedBy`, the reason, the latency, and
for speech the duration, peak and RMS (a silent output is flagged). The gateway can be a stub, a gateway that always
fails, or a real one (URL and key kept in memory only).
