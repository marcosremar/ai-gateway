/**
 * Decoder of the speech-to-speech wire format (`application/x-aigw-s2s`, src/s2s/frames.ts):
 *
 *   [1 byte kind][4 bytes big-endian length][payload]   kind E = one JSON event · kind A = raw PCM s16le mono
 *
 * Chunks may split a frame anywhere (header included); frames are returned whole. Browser-safe (no Buffer).
 */

import type { S2SEvent, S2SFrame } from './gateway-types';

const KIND_EVENT = 'E'.charCodeAt(0);
const KIND_AUDIO = 'A'.charCodeAt(0);

export class S2SFrameDecoder {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private readonly text = new TextDecoder();

  /** Bytes of an incomplete frame held back (non-zero at the end of a stream = the stream was cut). */
  get pending(): number { return this.size; }

  push(chunk: Uint8Array): S2SFrame[] {
    if (chunk.length) { this.chunks.push(chunk); this.size += chunk.length; }
    const frames: S2SFrame[] = [];
    while (this.size >= 5) {
      const head = this.peek(5);
      const length = new DataView(head.buffer, head.byteOffset, 5).getUint32(1, false);
      if (this.size < 5 + length) break;
      const raw = this.take(5 + length);
      const payload = raw.subarray(5);
      if (raw[0] === KIND_AUDIO) frames.push({ kind: 'audio', pcm: payload });
      else if (raw[0] === KIND_EVENT) frames.push({ kind: 'event', event: JSON.parse(this.text.decode(payload)) as S2SEvent });
      else throw new Error(`s2s: unknown frame kind 0x${raw[0].toString(16)}`);
    }
    return frames;
  }

  /** First `n` bytes without consuming them (n ≤ size). */
  private peek(n: number): Uint8Array {
    if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
    return this.gather(n, false);
  }

  private take(n: number): Uint8Array {
    if (this.chunks[0].length === n) { this.size -= n; return this.chunks.shift()!; }
    if (this.chunks[0].length > n) {
      const out = this.chunks[0].slice(0, n);
      this.chunks[0] = this.chunks[0].subarray(n);
      this.size -= n;
      return out;
    }
    return this.gather(n, true);
  }

  private gather(n: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    let i = 0;
    while (at < n) {
      const c = this.chunks[i];
      const part = c.subarray(0, Math.min(c.length, n - at));
      out.set(part, at);
      at += part.length;
      if (consume) {
        if (part.length === c.length) { this.chunks.shift(); continue; }
        this.chunks[0] = c.subarray(part.length);
      } else {
        i++;
      }
    }
    if (consume) this.size -= n;
    return out;
  }
}
