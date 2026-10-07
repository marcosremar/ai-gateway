import { readFileSync } from 'fs';

export function tone(seconds: number, rate: number, freq = 210): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    const w = (2 * Math.PI * freq * i) / rate;
    out[i] = Math.round(32767 * (0.25 * Math.sin(w) + 0.1 * Math.sin(2 * w) + 0.05 * Math.sin(3 * w)));
  }
  return out;
}

export function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const silence = (seconds: number, rate: number) => new Int16Array(Math.round(seconds * rate));

export function wav(pcm: Int16Array, rate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.byteLength, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([head, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

export function readWav(path: string): { pcm: Int16Array; rate: number } {
  const b = readFileSync(path);
  const fmt = b.indexOf('fmt ');
  const data = b.indexOf('data');
  if (b.toString('ascii', 0, 4) !== 'RIFF' || fmt < 0 || data < 0) throw new Error(`${path}: not a WAV file`);
  const [format, channels, rate, bits] = [b.readUInt16LE(fmt + 8), b.readUInt16LE(fmt + 10), b.readUInt32LE(fmt + 12), b.readUInt16LE(fmt + 22)];
  if (format !== 1 || channels !== 1 || bits !== 16) throw new Error(`${path}: need PCM16 mono (got format ${format}, ${channels} ch, ${bits} bit): ffmpeg -i in -ac 1 -c:a pcm_s16le out.wav`);
  const size = Math.min(b.readUInt32LE(data + 4), b.length - data - 8) & ~1;
  return { pcm: new Int16Array(b.buffer.slice(b.byteOffset + data + 8, b.byteOffset + data + 8 + size)), rate };
}

export function voiced(pcm: Int16Array, threshold = 0.02): Int16Array {
  const loud = (i: number) => Math.abs(pcm[i]) >= threshold * 32768;
  let start = 0;
  let end = pcm.length;
  while (end > 0 && !loud(end - 1)) end--;
  while (start < end && !loud(start)) start++;
  return pcm.subarray(start, end);
}

export function clip16k(path: string): Int16Array {
  const { pcm, rate } = readWav(path);
  return voiced(resample(pcm, rate, 16000));
}

export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm;
  const out = new Int16Array(Math.round((pcm.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const x = (i * from) / to;
    const a = Math.floor(x);
    out[i] = Math.round(pcm[a] + ((pcm[Math.min(a + 1, pcm.length - 1)] ?? 0) - pcm[a]) * (x - a));
  }
  return out;
}

export function rms(pcm: Int16Array): number {
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return pcm.length ? Math.sqrt(s / pcm.length) / 32768 : 0;
}
