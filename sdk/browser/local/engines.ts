import type { Footprint, LlmEngine, LocalDevice, LocalModel, SttEngine, TtsEngine } from './types';

type Sizes = Partial<Record<LocalDevice, Footprint>>;

interface FileProgress { status: string; file?: string; loaded?: number; total?: number }
type ProgressCallback = (event: FileProgress) => void;

export function fileProgress(onProgress: (progress: number) => void): ProgressCallback {
  const files = new Map<string, { loaded: number; total: number }>();
  return (event) => {
    if (event.status !== 'progress' || !event.file || !event.total) return;
    files.set(event.file, { loaded: event.loaded ?? 0, total: event.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    onProgress(loaded / total);
  };
}

function logprobOf(logits: ArrayLike<number>, index: number): number {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i]! > max) max = logits[i]!;
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i]! - max);
  return logits[index]! - max - Math.log(sum);
}

export function logprobMeter() {
  let previous: ArrayLike<number> | null = null;
  let sum = 0;
  let count = 0;
  return {
    observe: (ids: bigint[][], logits: { data: ArrayLike<number> }) => {
      if (previous) { sum += logprobOf(previous, Number(ids[0]!.at(-1))); count++; }
      previous = logits.data;
      return logits;
    },
    average: () => (count ? sum / count : undefined),
  };
}

type AsrOutput = { text: string } | Array<{ text: string }>;
export interface TransformersLike {
  env?: { backends: { onnx: { wasm?: { proxy?: boolean } } } };
  pipeline(task: 'automatic-speech-recognition', model: string, opts: { device: LocalDevice; dtype: unknown; progress_callback?: ProgressCallback }):
    Promise<(audio: Float32Array, opts: Record<string, unknown>) => Promise<AsrOutput>>;
}

export function whisperStt(o: { loadTransformers: () => Promise<TransformersLike>; model?: string; size?: Sizes }): LocalModel<SttEngine> {
  const id = o.model ?? 'onnx-community/whisper-base';
  return {
    id,
    size: o.size ?? { webgpu: { memoryMb: 320, downloadMb: 210 }, wasm: { memoryMb: 160, downloadMb: 80 } },
    async load({ device, onProgress }) {
      const { pipeline, env } = await o.loadTransformers();
      if (device === 'wasm' && env?.backends.onnx.wasm) env.backends.onnx.wasm.proxy = true;
      const asr = await pipeline('automatic-speech-recognition', id, {
        device, dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8', progress_callback: fileProgress(onProgress),
      });
      await asr(new Float32Array(16_000), { language: 'en' });
      return {
        async transcribe(audio, { language }) {
          const meter = logprobMeter();
          const out = await asr(audio, { language, task: 'transcribe', logits_processor: [meter.observe] });
          return { text: (Array.isArray(out) ? out[0]?.text : out.text) ?? '', avgLogprob: meter.average() };
        },
      };
    },
  };
}

const E2M: ReadonlyArray<[RegExp, string]> = ([
  ['a\u200dɪ', 'I'], ['a\u200dʊ', 'W'], ['d\u200dz', 'ʣ'], ['d\u200dʒ', 'ʤ'], ['e\u200dɪ', 'A'], ['o\u200dʊ', 'O'],
  ['ə\u200dʊ', 'Q'], ['s\u200ds', 'S'], ['t\u200ds', 'ʦ'], ['t\u200dʃ', 'ʧ'], ['ɔ\u200dɪ', 'Y'],
] as const).map(([from, to]) => [new RegExp(from, 'g'), to]);

export function espeakToKokoro(phonemes: string, text: string): string {
  const clauses = phonemes.split('\n').map(c => c.trim()).filter(Boolean);
  const marks = text.match(/[.,!?;:…]+/g) ?? [];
  const finalMark = text.trim().match(/[.!?…]+$/)?.[0] ?? '';
  const markAt = (i: number) => (marks.length === clauses.length ? marks[i]! : i === clauses.length - 1 ? finalMark : ',');
  const joined = clauses.map((c, i) => c + markAt(i)).join(' ');
  return E2M.reduce((s, [from, to]) => s.replace(from, to), joined)
    .replace(/[\u200d-]/g, '')
    .replace(/[ãẽĩõũ]/g, c => c.normalize('NFD'));
}

type InstantiateWasm = (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => object;
type EspeakFactory = (opts: { arguments: string[]; instantiateWasm?: InstantiateWasm }) =>
  Promise<{ FS: { readFile(path: string, opts: { encoding: 'utf8' }): string } }>;
export type Phonemize = (text: string, espeakVoice: string) => Promise<string>;

export function espeakPhonemizer(loadEspeak: () => Promise<EspeakFactory>, wasmUrl?: string): Phonemize {
  let compiled: Promise<WebAssembly.Module> | null = null;
  return async (text, voice) => {
    const module = wasmUrl ? await (compiled ??= WebAssembly.compileStreaming(fetch(wasmUrl)).catch((err: unknown) => { compiled = null; throw err; })) : null;
    const instantiateWasm: InstantiateWasm = (imports, done) => {
      void WebAssembly.instantiate(module!, imports).then(instance => done(instance, module!));
      return {};
    };
    const espeak = await (await loadEspeak())({
      arguments: ['--phonout', 'out', '-q', '-b', '1', '--ipa=3', '-v', voice, '--', text], ...(module ? { instantiateWasm } : {}),
    });
    return espeakToKokoro(espeak.FS.readFile('out', { encoding: 'utf8' }), text);
  };
}

interface RawAudioLike { audio: Float32Array; sampling_rate: number }
interface KokoroModel {
  generate(text: string, opts: { voice: string; speed?: number }): Promise<RawAudioLike>;
  generate_from_ids(ids: unknown, opts: { voice: string; speed?: number }): Promise<RawAudioLike>;
  tokenizer(text: string, opts: { truncation: boolean }): { input_ids: unknown };
}
export interface KokoroLike {
  KokoroTTS: { from_pretrained(id: string, opts: { dtype: string; device: LocalDevice; progress_callback?: ProgressCallback }): Promise<KokoroModel> };
}

export const KOKORO_VOICE = /^[abefhijpz][fm]_[a-z]+$/;
const ESPEAK_VOICE: Record<string, string> = { e: 'es', f: 'fr-fr', h: 'hi', i: 'it', p: 'pt-br' };

async function synthesize(tts: KokoroModel, text: string, voice: string, speed: number | undefined, phonemize?: Phonemize): Promise<RawAudioLike> {
  const lang = voice[0]!;
  if (lang === 'a' || lang === 'b') return tts.generate(text, { voice, speed });
  if (!phonemize || !ESPEAK_VOICE[lang]) throw new Error(`no phonemizer for voice ${voice}`);
  const { input_ids } = tts.tokenizer(await phonemize(text, ESPEAK_VOICE[lang]), { truncation: true });
  return tts.generate_from_ids(input_ids, { voice, speed });
}

export function kokoroTts(o: { loadKokoro: () => Promise<KokoroLike>; phonemize?: Phonemize; model?: string; size?: Sizes }): LocalModel<TtsEngine> {
  const id = o.model ?? 'onnx-community/Kokoro-82M-v1.0-ONNX';
  return {
    id,
    size: o.size ?? { webgpu: { memoryMb: 420, downloadMb: 330 }, wasm: { memoryMb: 180, downloadMb: 95 } },
    async load({ device, onProgress }) {
      const { KokoroTTS } = await o.loadKokoro();
      const tts = await KokoroTTS.from_pretrained(id, { dtype: device === 'webgpu' ? 'fp32' : 'q8', device, progress_callback: fileProgress(onProgress) });
      await tts.generate_from_ids(tts.tokenizer('ə', { truncation: true }).input_ids, { voice: 'af_heart' });
      return {
        async speak(text, { voice, fallbackVoice, speed }) {
          const chosen = [voice, fallbackVoice].find(v => v && KOKORO_VOICE.test(v));
          if (!chosen) throw new Error(`not a Kokoro voice: ${voice}`);
          const out = await synthesize(tts, text, chosen, speed, o.phonemize);
          return { samples: out.audio, rate: out.sampling_rate };
        },
      };
    },
  };
}

interface MlcChunk { choices: Array<{ delta?: { content?: string | null } }> }
interface MlcEngine {
  chat: { completions: { create(req: Record<string, unknown>): Promise<AsyncIterable<MlcChunk>> } };
  interruptGenerate(): void;
}
export interface WebLlmLike {
  CreateMLCEngine(model: string, config: { initProgressCallback?: (report: { progress: number }) => void }): Promise<MlcEngine>;
}

export function webLlm(o: { loadWebLlm: () => Promise<WebLlmLike>; model?: string; size?: Sizes }): LocalModel<LlmEngine> {
  const id = o.model ?? 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
  return {
    id,
    size: o.size ?? { webgpu: { memoryMb: 1000, downloadMb: 300 } },
    async load({ caps, onProgress }) {
      const { CreateMLCEngine } = await o.loadWebLlm();
      const engine = await CreateMLCEngine(caps.shaderF16 ? id : id.replace('q4f16_1', 'q4f32_1'), { initProgressCallback: r => onProgress(r.progress) });
      await engine.chat.completions.create({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
      return {
        async *stream(messages, opts, signal) {
          const stop = () => engine.interruptGenerate();
          signal.addEventListener('abort', stop);
          let finished = false;
          try {
            for await (const chunk of await engine.chat.completions.create({ ...opts, messages, stream: true })) {
              const delta = chunk.choices[0]?.delta?.content;
              if (delta) yield delta;
            }
            finished = true;
          } finally {
            signal.removeEventListener('abort', stop);
            if (!finished) stop();
          }
        },
      };
    },
  };
}
