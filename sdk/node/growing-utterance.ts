/**
 * One open sentence transcribed by repeated `POST /v1/audio/transcriptions`.
 *
 * Each draft uploads only the audio since the previous draft, plus {@link DRAFT_OVERLAP_SAMPLES}.
 * The final is not this: the caller sends the whole sentence once. A tail whose overlap does not
 * match is dropped and the next draft sends the whole sentence.
 */

/** Samples a draft sends again so the new words join the line already showing (2 s at 16 kHz). */
export const DRAFT_OVERLAP_SAMPLES = 2 * 16_000;

export interface DraftPiece {
  /** First sample of the audio the caller is holding. */
  start: number;
  /** The transcript must continue the line already showing. */
  continued: boolean;
}

export class GrowingUtterance {
  private covered = 0;
  private hypothesis = '';

  reset(): void {
    this.covered = 0;
    this.hypothesis = '';
  }

  /** `null` when `heard` was already transcribed. A shorter buffer (a new sentence) clears the cursor. */
  piece(heard: number): DraftPiece | null {
    if (this.covered > heard) this.reset();
    if (this.hypothesis && heard <= this.covered) return null;
    const continued = this.covered > DRAFT_OVERLAP_SAMPLES && heard > this.covered;
    return { start: continued ? this.covered - DRAFT_OVERLAP_SAMPLES : 0, continued };
  }

  /**
   * `transcript` is what the model returned for the piece. The string is the whole line to show.
   * `null` on a continuation that does not overlap: the cursor is cleared.
   */
  accept(continued: boolean, transcript: string, heard: number): string | null {
    if (!continued) {
      if (!transcript.trim()) return null;
      this.hypothesis = transcript;
      this.covered = heard;
      return this.hypothesis;
    }
    const line = joinOverlap(this.hypothesis, transcript);
    if (line == null) {
      this.reset();
      return null;
    }
    this.hypothesis = line;
    this.covered = heard;
    return line;
  }
}

/** 16 kHz mono PCM16 WAV of `samples` (values already in the int16 range). */
export function wavPcm16(samples: ArrayLike<number>): Uint8Array {
  const data = samples.length * 2;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 36 + data, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8); // WAVEfmt 
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36); // data
  view.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-32768, Math.min(32767, samples[i] | 0));
    view.setInt16(44 + i * 2, v, true);
  }
  return out;
}

function bare(word: string): string {
  return word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function joinOverlap(prev: string, next: string): string | null {
  const prevW = prev.split(/\s+/).filter(Boolean);
  const nextW = next.split(/\s+/).filter(Boolean);
  if (!prevW.length) return next;
  if (!nextW.length) return prev;
  const limit = Math.min(12, prevW.length, nextW.length);
  for (let k = limit; k >= 1; k--) {
    const tail = prevW.slice(-k).map(bare);
    for (let skip = 0; skip < 3 && skip + k <= nextW.length; skip++) {
      const head = nextW.slice(skip, skip + k).map(bare);
      if (tail.every((w, i) => w === head[i])) {
        const rest = nextW.slice(skip + k);
        return rest.length ? `${prev} ${rest.join(' ')}` : prev;
      }
    }
  }
  return null;
}
