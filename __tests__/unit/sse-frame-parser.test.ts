import { describe, it, expect } from 'vitest';
import { SSEFrameParser, type SSEFrame } from '../../src/browser/sse-frame-parser';

const encoder = new TextEncoder();

function sseEvent(eventType: string, data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

function binaryFrame(payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(9);
  header[0] = 0x00;
  header[1] = 0x41; // A
  header[2] = 0x55; // U
  header[3] = 0x44; // D
  header[4] = 0x49; // I
  const view = new DataView(header.buffer);
  view.setUint32(5, payload.length, true);
  const result = new Uint8Array(header.length + payload.length);
  result.set(header);
  result.set(payload, header.length);
  return result;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

describe('SSEFrameParser', () => {
  it('parses a single SSE text event', () => {
    const parser = new SSEFrameParser();
    const frames = parser.feed(sseEvent('status', { stage: 'stt' }));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('event');
    if (frames[0].type === 'event') {
      expect(frames[0].eventType).toBe('status');
      expect(JSON.parse(frames[0].eventData)).toEqual({ stage: 'stt' });
    }
  });

  it('parses a single binary frame', () => {
    const parser = new SSEFrameParser();
    const audio = new Uint8Array([10, 20, 30, 40, 50]);
    const frames = parser.feed(binaryFrame(audio));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('binary');
    if (frames[0].type === 'binary') {
      expect(frames[0].data).toEqual(audio);
    }
  });

  it('parses interleaved text and binary frames', () => {
    const parser = new SSEFrameParser();
    const audio = new Uint8Array([1, 2, 3]);
    const data = concat(
      sseEvent('transcript', { transcript: 'hello' }),
      binaryFrame(audio),
      sseEvent('complete', { response: 'world' }),
    );
    const frames = parser.feed(data);
    expect(frames).toHaveLength(3);
    expect(frames[0].type).toBe('event');
    expect(frames[1].type).toBe('binary');
    expect(frames[2].type).toBe('event');
  });

  it('handles partial data across multiple feeds', () => {
    const parser = new SSEFrameParser();
    const full = sseEvent('status', { stage: 'tts' });
    // Split in the middle
    const part1 = full.slice(0, 10);
    const part2 = full.slice(10);

    expect(parser.feed(part1)).toHaveLength(0); // incomplete
    const frames = parser.feed(part2);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('event');
  });

  it('handles partial binary frame across feeds', () => {
    const parser = new SSEFrameParser();
    const audio = new Uint8Array(100).fill(42);
    const full = binaryFrame(audio);
    // Split: header + partial payload
    const part1 = full.slice(0, 20);
    const part2 = full.slice(20);

    expect(parser.feed(part1)).toHaveLength(0);
    const frames = parser.feed(part2);
    expect(frames).toHaveLength(1);
    if (frames[0].type === 'binary') {
      expect(frames[0].data.length).toBe(100);
      expect(frames[0].data[0]).toBe(42);
    }
  });

  it('handles empty feed', () => {
    const parser = new SSEFrameParser();
    expect(parser.feed(new Uint8Array(0))).toHaveLength(0);
  });

  it('skips empty SSE blocks', () => {
    const parser = new SSEFrameParser();
    const data = encoder.encode('\n\n\n\n');
    expect(parser.feed(data)).toHaveLength(0);
  });

  it('handles multiple events in one feed', () => {
    const parser = new SSEFrameParser();
    const data = concat(
      sseEvent('status', { stage: 'stt' }),
      sseEvent('transcript', { transcript: 'hi' }),
      sseEvent('response', { response: 'hello' }),
    );
    const frames = parser.feed(data);
    expect(frames).toHaveLength(3);
    expect(frames.every(f => f.type === 'event')).toBe(true);
  });

  it('reports remaining bytes', () => {
    const parser = new SSEFrameParser();
    const partial = encoder.encode('event: status\ndata:');
    parser.feed(partial);
    expect(parser.remaining).toBeGreaterThan(0);
  });

  it('reset clears buffer', () => {
    const parser = new SSEFrameParser();
    parser.feed(encoder.encode('event: partial'));
    expect(parser.remaining).toBeGreaterThan(0);
    parser.reset();
    expect(parser.remaining).toBe(0);
  });

  it('handles large binary payload', () => {
    const parser = new SSEFrameParser();
    const bigAudio = new Uint8Array(50000);
    for (let i = 0; i < bigAudio.length; i++) bigAudio[i] = i & 0xFF;
    const frames = parser.feed(binaryFrame(bigAudio));
    expect(frames).toHaveLength(1);
    if (frames[0].type === 'binary') {
      expect(frames[0].data.length).toBe(50000);
      expect(frames[0].data[0]).toBe(0);
      expect(frames[0].data[255]).toBe(255);
    }
  });
});
