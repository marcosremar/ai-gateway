/**
 * What the browser SDK's `createMicCheck` would tell the person, with the probabilities the real pipeline gives
 * (`createVoiceActivityPipeline`, level on, Silero on onnxruntime-node; null where the RMS gate kept Silero off).
 * One report every 10 s; prints the share of reports with each issue per set.
 *
 * usage: ORT_NODE=<onnxruntime-node> bun scripts/voice-level-bench/mic-check.ts <set dir>...
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSileroVad, SILERO_FRAME_SAMPLES } from '../../sdk/browser/voice/silero';
import { createVoiceActivityPipeline, type VoiceFrameClassifier } from '../../sdk/browser/voice/voice-activity';
import { createMicCheck, type MicIssue } from '../../sdk/browser/voice/mic-check';

const ort = await import(process.env.ORT_NODE ?? 'onnxruntime-node');
const model = new Uint8Array(readFileSync(new URL('../../sdk/browser/voice/silero_vad.onnx', import.meta.url)));

function readWav(path: string): Float32Array {
  const b = readFileSync(path);
  let pos = 12;
  while (pos + 8 <= b.length) {
    const size = b.readUInt32LE(pos + 4);
    if (b.toString('ascii', pos, pos + 4) === 'data') {
      const out = new Float32Array(Math.floor(size / 2));
      for (let i = 0; i < out.length; i += 1) out[i] = b.readInt16LE(pos + 8 + 2 * i) / 32768;
      return out;
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error(`no data in ${path}`);
}

const ISSUES: MicIssue[] = ['farOrEcho', 'noisy', 'tooQuiet', 'clipping', 'hum'];
for (const dir of process.argv.slice(2)) {
  const counts = new Map<MicIssue, number>();
  let reports = 0;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
    const audio = readWav(join(dir, name));
    const silero = await createSileroVad(ort as never, model);
    let last: number | null = null;
    const spy: VoiceFrameClassifier = { async probability(f) { last = await silero.probability(f); return last; }, reset: () => silero.reset() };
    const pipeline = createVoiceActivityPipeline(spy, () => {});
    const check = createMicCheck();
    for (let i = 0, n = 0; i + SILERO_FRAME_SAMPLES <= audio.length; i += SILERO_FRAME_SAMPLES, n += 1) {
      const frame = audio.slice(i, i + SILERO_FRAME_SAMPLES);
      last = null;
      await pipeline.push(frame);
      check.push(frame, last);
      if (n % 312 === 311) {
        const r = check.report();
        if (r) { reports += 1; for (const issue of r.issues) counts.set(issue, (counts.get(issue) ?? 0) + 1); }
      }
    }
  }
  const pct = (i: MicIssue) => `${i} ${((100 * (counts.get(i) ?? 0)) / Math.max(reports, 1)).toFixed(0).padStart(3)}%`;
  console.log(`${dir.split('/').slice(-2).join('/').padEnd(28)} n=${String(reports).padStart(3)}  ${ISSUES.map(pct).join('  ')}`);
}
