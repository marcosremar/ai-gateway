/**
 * Does the browser SDK's VAD (`sdk/browser/voice`) find the speech, with and without `createVoiceLevel`?
 *
 * Runs the real pipeline (`createVoiceActivityPipeline`: RMS gate → level → Silero v5 on onnxruntime-node) over WAV
 * sets whose JSON lists the speech stretches (`clips`: start/end in s — the ucast.me benchmark's sets,
 * `~/.ucast-build/benchmark/sets/<scenario>/<lang>/`), and compares the frames in stage `speech` with them:
 * - found = share of the reference speech time the pipeline was in `speech` (±0.3 s at each edge not counted),
 * - false = share of the time with nobody speaking (gaps ≥ 1 s) it was in `speech`.
 *
 * usage: [ORT_NODE=<path to onnxruntime-node>] bun scripts/voice-level-bench/bench.ts <set dir>...
 *   (onnxruntime-node is not a dependency of the gateway: point ORT_NODE at an install, e.g. a consumer app's)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSileroVad, SILERO_FRAME_SAMPLES } from '../../sdk/browser/voice/silero';
import { createVoiceActivityPipeline } from '../../sdk/browser/voice/voice-activity';
import { createVoiceLevel } from '../../sdk/browser/voice/voice-level';

const ort = await import(process.env.ORT_NODE ?? 'onnxruntime-node');
const RATE = 16_000;
const FRAME_S = SILERO_FRAME_SAMPLES / RATE;
const EDGE_S = 0.3;
const model = new Uint8Array(readFileSync(new URL('../../sdk/browser/voice/silero_vad.onnx', import.meta.url)));

function readWav(path: string): Float32Array {
  const b = readFileSync(path);
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i += 1) out[i] = b.readInt16LE(pos + 8 + 2 * i) / 32768;
      return out;
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${path}`);
}

interface Clip { start: number; end: number }

async function speechFrames(audio: Float32Array, level: boolean): Promise<boolean[]> {
  const vad = await createSileroVad(ort as never, model);
  const pipeline = createVoiceActivityPipeline(vad, () => {}, undefined, level ? createVoiceLevel() : null);
  const out: boolean[] = [];
  for (let i = 0; i + SILERO_FRAME_SAMPLES <= audio.length; i += SILERO_FRAME_SAMPLES) {
    await pipeline.push(audio.slice(i, i + SILERO_FRAME_SAMPLES));
    out.push(pipeline.stage() === 'speech');
  }
  return out;
}

function score(frames: boolean[], clips: Clip[], seconds: number) {
  let speech = 0, found = 0, quiet = 0, falseOn = 0;
  const gaps: Clip[] = [];
  let last = 0;
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    if (c.start - last >= 1) gaps.push({ start: last + EDGE_S, end: c.start - EDGE_S });
    last = Math.max(last, c.end);
  }
  if (seconds - last >= 1) gaps.push({ start: last + EDGE_S, end: seconds });
  frames.forEach((on, i) => {
    const t = (i + 0.5) * FRAME_S;
    if (clips.some((c) => t >= c.start + EDGE_S && t <= c.end - EDGE_S)) { speech += 1; if (on) found += 1; }
    else if (gaps.some((g) => t >= g.start && t <= g.end)) { quiet += 1; if (on) falseOn += 1; }
  });
  return { speech, found, quiet, falseOn };
}

const totals = new Map<string, { speech: number; found: number; quiet: number; falseOn: number }>();
for (const dir of process.argv.slice(2)) {
  for (const variant of ['without', 'level'] as const) {
    const sum = { speech: 0, found: 0, quiet: 0, falseOn: 0 };
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
      const meta = JSON.parse(readFileSync(join(dir, name.replace(/\.wav$/, '.json')), 'utf8'));
      const clips: Clip[] = meta.noSpeech ? [] : meta.clips?.length ? meta.clips : [{ start: 0, end: meta.seconds }];
      const s = score(await speechFrames(readWav(join(dir, name)), variant === 'level'), clips, meta.seconds);
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += s[k];
    }
    const key = `${dir.split('/').slice(-2).join('/')} ${variant}`;
    totals.set(key, sum);
    const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : '—');
    console.log(`${key.padEnd(28)} found ${pct(sum.found, sum.speech).padStart(5)} %   false ${pct(sum.falseOn, sum.quiet).padStart(5)} %   (${(sum.speech * FRAME_S / 60).toFixed(1)} min speech, ${(sum.quiet * FRAME_S / 60).toFixed(1)} min quiet)`);
  }
}
