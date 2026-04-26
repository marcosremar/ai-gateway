/**
 * SSEFrameParser — pure stateful parser for mixed binary/text SSE streams.
 *
 * Handles two frame types in the same byte stream:
 *   - Binary audio frames: \x00AUDI + uint32LE length + raw bytes
 *   - SSE text events: "event: type\ndata: json\n\n"
 *
 * Zero dependencies. Fully unit-testable with plain Uint8Array inputs.
 */

export type SSEFrame =
  | { type: 'binary'; data: Uint8Array }
  | { type: 'event'; eventType: string; eventData: string }

// Binary frame magic bytes: \x00 A U D I
const MAGIC_0 = 0x00
const MAGIC_1 = 0x41 // A
const MAGIC_2 = 0x55 // U
const MAGIC_3 = 0x44 // D
const MAGIC_4 = 0x49 // I
const HEADER_SIZE = 9 // 1 (marker) + 4 (magic) + 4 (uint32LE length)

export class SSEFrameParser {
  private buffer = new Uint8Array(0)

  /** Feed raw bytes from the stream. Returns all complete frames found. */
  feed(chunk: Uint8Array): SSEFrame[] {
    // Append to buffer
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged

    const frames: SSEFrame[] = []

    while (this.buffer.length > 0) {
      // Check for binary audio frame
      if (this.buffer[0] === MAGIC_0 && this.buffer.length >= HEADER_SIZE &&
          this.buffer[1] === MAGIC_1 && this.buffer[2] === MAGIC_2 &&
          this.buffer[3] === MAGIC_3 && this.buffer[4] === MAGIC_4) {
        // `<< 24` produces a signed 32-bit int — for lengths ≥ 2 GiB the
        // top bit flips to negative and the next bounds check passes
        // erroneously, slicing far past the actual buffer. Force unsigned
        // with `>>> 0` (or use DataView.getUint32 little-endian).
        const len = ((this.buffer[5] | (this.buffer[6] << 8) | (this.buffer[7] << 16) | (this.buffer[8] << 24)) >>> 0)
        if (this.buffer.length < HEADER_SIZE + len) break // need more data
        frames.push({ type: 'binary', data: this.buffer.slice(HEADER_SIZE, HEADER_SIZE + len) })
        this.buffer = this.buffer.slice(HEADER_SIZE + len)
        continue
      }

      // SSE text event — find \n\n delimiter
      const text = new TextDecoder().decode(this.buffer, { stream: true })
      const doubleNewline = text.indexOf('\n\n')
      if (doubleNewline === -1) break // need more data

      const eventBlock = text.slice(0, doubleNewline)
      const consumedBytes = new TextEncoder().encode(text.slice(0, doubleNewline + 2))
      this.buffer = this.buffer.slice(consumedBytes.length)

      if (!eventBlock.trim()) continue

      const lines = eventBlock.split('\n')
      let eventType = ''
      let eventData = ''

      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.slice(7)
        else if (line.startsWith('data: ')) eventData = line.slice(6)
      }

      if (eventType && eventData) {
        frames.push({ type: 'event', eventType, eventData })
      }
    }

    return frames
  }

  /** Reset parser state */
  reset(): void {
    this.buffer = new Uint8Array(0)
  }

  /** Get remaining unprocessed bytes (for debugging) */
  get remaining(): number {
    return this.buffer.length
  }
}
