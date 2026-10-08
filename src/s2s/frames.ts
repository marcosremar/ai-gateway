/**
 * Speech-to-speech wire format, the same one the speech-stack image speaks (docker/speech-stack/server.py), so a client
 * reads one protocol whether the answer came from the GPU or from the gateway's composed fallback.
 *
 *   binary (default, `application/x-aigw-s2s`):  [1 byte kind][4 bytes big-endian length][payload]
 *       kind E = one JSON event · kind A = raw PCM s16le mono (sample rate in the `audio_format` event, 24 kHz default)
 *   `?format=ndjson` (`application/x-ndjson`): one JSON object per line; audio as {"type":"audio","pcm":<base64>}
 *
 * Events: route · transcript · llm_first_token · sentence · audio_format · first_audio · opener · deadline_missed · done · error.
 */

export type S2SEvent = { type: string; [key: string]: unknown };
export type S2SFormat = 'binary' | 'ndjson';

export const S2S_CONTENT_TYPE: Record<S2SFormat, string> = {
  binary: 'application/x-aigw-s2s',
  ndjson: 'application/x-ndjson',
};

function frame(kind: 'E' | 'A', payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind.charCodeAt(0);
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

const encoder = new TextEncoder();

export function encodeEvent(event: S2SEvent, format: S2SFormat): Uint8Array {
  const json = JSON.stringify(event);
  return format === 'ndjson' ? encoder.encode(json + '\n') : frame('E', encoder.encode(json));
}

export function encodeAudio(pcm: Uint8Array, format: S2SFormat): Uint8Array {
  return format === 'ndjson'
    ? encoder.encode(JSON.stringify({ type: 'audio', pcm: Buffer.from(pcm).toString('base64') }) + '\n')
    : frame('A', pcm);
}

export type DecodedFrame = { kind: 'event'; event: S2SEvent; raw: Uint8Array } | { kind: 'audio'; pcm: Uint8Array; raw: Uint8Array };

/** Incremental decoder of the binary format: feed chunks as they arrive, get whole frames back. */
export class FrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): DecodedFrame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const frames: DecodedFrame[] = [];
    while (this.buf.length >= 5) {
      const size = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(1, false);
      if (this.buf.length < 5 + size) break;
      const raw = this.buf.slice(0, 5 + size);
      const payload = raw.subarray(5);
      const kind = String.fromCharCode(raw[0]);
      if (kind === 'A') frames.push({ kind: 'audio', pcm: payload, raw });
      else frames.push({ kind: 'event', event: JSON.parse(new TextDecoder().decode(payload)) as S2SEvent, raw });
      this.buf = this.buf.slice(5 + size);
    }
    return frames;
  }

  /** Bytes of an incomplete frame left over (a stream that ended mid-frame was cut). */
  get pending(): number { return this.buf.length; }
}
