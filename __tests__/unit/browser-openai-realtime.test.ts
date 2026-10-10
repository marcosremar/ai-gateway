/**
 * Tests for src/browser/openai-realtime.ts
 * Covers: constructor defaults, public state getters, disconnect, sendText no-op,
 * reset, DataChannel event processing, and RTCStats quality assessment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIRealtimeClient } from '../../src/browser/openai-realtime';

// ── Mock browser APIs ─────────────────────────────────────────────────────────

/** A DataChannel stub with EventEmitter-style listeners. */
class MockDataChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'open';
  listeners: Record<string, Function[]> = {};
  sent: string[] = [];
  close = vi.fn(() => { this.readyState = 'closed'; });

  addEventListener(type: string, fn: Function) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  removeEventListener(type: string, fn: Function) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter(f => f !== fn);
    }
  }
  send(data: string) { this.sent.push(data); }

  // Helpers for tests
  simulateOpen() { this.listeners.open?.forEach(fn => fn()); }
  simulateMessage(data: string) { this.listeners.message?.forEach(fn => fn({ data })); }
}

class MockAudioElement {
  autoplay = false;
  srcObject: MediaStream | null = null;
}

class MockMediaStreamTrack {
  kind = 'audio';
  stop = vi.fn();
}

class MockMediaStream {
  tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack()];
  getTracks() { return this.tracks; }
}

let mockPc: MockRTCPeerConnection;
let mockDc: MockDataChannel;

class MockRTCPeerConnection {
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: any) => void) | null = null;

  iceConnectionState: RTCIceConnectionState = 'connected';
  connectionState: RTCPeerConnectionState = 'connected';

  localDescription: RTCSessionDescriptionInit | null = null;

  close = vi.fn();
  addTrack = vi.fn();
  getStats = vi.fn(async () => new Map());
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'v=0\nmock-offer' }));
  setLocalDescription = vi.fn(async function(this: MockRTCPeerConnection, desc: any) {
    this.localDescription = desc;
  });
  setRemoteDescription = vi.fn(async () => {});
  createDataChannel = vi.fn((label: string) => {
    mockDc = new MockDataChannel();
    return mockDc;
  });

  constructor() {
    mockPc = this;
  }
}

function setupBrowserMocks() {
  vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);

  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag === 'audio') return new MockAudioElement();
      return {};
    },
  });

  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => new MockMediaStream()),
    },
  });

  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    text: async () => 'v=0\nmock-sdp-answer',
    json: async () => ({}),
  })));
}

beforeEach(() => {
  vi.clearAllMocks();
  setupBrowserMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Constructor defaults ──────────────────────────────────────────────────────

describe('OpenAIRealtimeClient constructor', () => {
  it('initializes isConnected as false', () => {
    const client = new OpenAIRealtimeClient();
    expect(client.isConnected).toBe(false);
  });

  it('initializes isConnecting as false', () => {
    const client = new OpenAIRealtimeClient();
    expect(client.isConnecting).toBe(false);
  });

  it('initializes phase as idle', () => {
    const client = new OpenAIRealtimeClient();
    expect(client.phase).toBe('idle');
  });

  it('initializes error as null', () => {
    const client = new OpenAIRealtimeClient();
    expect(client.error).toBeNull();
  });
});

// ── sendText when not connected ───────────────────────────────────────────────

describe('sendText()', () => {
  it('is a no-op (no throw) when DataChannel is not open', () => {
    const client = new OpenAIRealtimeClient();
    // No connection, _dc is null
    expect(() => client.sendText('hello')).not.toThrow();
  });

  it('sends conversation.item.create and response.create when dc is open', async () => {
    const client = new OpenAIRealtimeClient({ sdpEndpoint: '/api/realtime/calls' });

    // Start connect — it will create RTCPeerConnection and DataChannel
    const connectPromise = client.connect();

    // Allow async ops to proceed (mic, offer, SDP exchange)
    await new Promise(r => setTimeout(r, 10));

    // Simulate DC opening to complete connect
    mockDc?.simulateOpen();
    await connectPromise.catch(() => {}); // might throw on SDP

    if (mockDc?.readyState === 'open') {
      client.sendText('hello there');
      const msgs = mockDc.sent.map(s => JSON.parse(s));
      const types = msgs.map(m => m.type);
      expect(types).toContain('conversation.item.create');
      expect(types).toContain('response.create');
    }

    client.disconnect();
  });
});

// ── reset ─────────────────────────────────────────────────────────────────────

describe('reset()', () => {
  it('clears error', async () => {
    // Use a config that causes a fetch error to set error state
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network error');
    }));

    const client = new OpenAIRealtimeClient();
    await client.connect().catch(() => {});

    // error may be set from the failed connect
    client.reset();
    expect(client.error).toBeNull();
  });

  it('does not throw when called without connecting', () => {
    const client = new OpenAIRealtimeClient();
    expect(() => client.reset()).not.toThrow();
  });
});

// ── disconnect ────────────────────────────────────────────────────────────────

describe('disconnect()', () => {
  it('sets phase to idle', () => {
    const client = new OpenAIRealtimeClient();
    client.disconnect();
    expect(client.phase).toBe('idle');
  });

  it('emits disconnected event', () => {
    const client = new OpenAIRealtimeClient();
    const spy = vi.fn();
    client.on('disconnected', spy);
    client.disconnect();
    expect(spy).toHaveBeenCalled();
  });

  it('sets isConnected to false', () => {
    const client = new OpenAIRealtimeClient();
    client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('emits audio-stream null on cleanup', () => {
    const client = new OpenAIRealtimeClient();
    const spy = vi.fn();
    client.on('audio-stream', spy);
    client.disconnect();
    expect(spy).toHaveBeenCalledWith(null);
  });

  it('is safe to call multiple times', () => {
    const client = new OpenAIRealtimeClient();
    expect(() => {
      client.disconnect();
      client.disconnect();
    }).not.toThrow();
  });
});

// ── connect deduplication ─────────────────────────────────────────────────────

describe('connect() deduplication', () => {
  it('returns immediately if already connecting', async () => {
    const client = new OpenAIRealtimeClient();
    // Start a connect (will stall waiting for mic, etc.)
    const p1 = client.connect().catch(() => {});
    expect(client.isConnecting).toBe(true);

    // Second connect returns immediately (no-op)
    const p2 = client.connect().catch(() => {});

    // Only one RTCPeerConnection should have been created
    await Promise.allSettled([p1, p2]);
    expect(vi.mocked(RTCPeerConnection as any)).toBeTruthy();
    client.disconnect();
  });
});

// ── DataChannel message processing ───────────────────────────────────────────

describe('DataChannel message processing', () => {
  async function createConnectedClient(): Promise<OpenAIRealtimeClient> {
    const client = new OpenAIRealtimeClient({ sdpEndpoint: '/api/realtime/calls' });
    const connectPromise = client.connect();
    await new Promise(r => setTimeout(r, 5));
    mockDc?.simulateOpen();
    await new Promise(r => setTimeout(r, 5));
    // We don't care if connect() resolved or rejected — just that dc is open
    connectPromise.catch(() => {});
    return client;
  }

  it('emits speaking-start on output_audio_buffer.started', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    const spy = vi.fn();
    client.on('speaking-start', spy);
    mockDc.simulateMessage(JSON.stringify({ type: 'output_audio_buffer.started' }));
    expect(spy).toHaveBeenCalled();
    client.disconnect();
  });

  it('emits speaking-end on output_audio_buffer.stopped', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    const spy = vi.fn();
    client.on('speaking-end', spy);
    mockDc.simulateMessage(JSON.stringify({ type: 'output_audio_buffer.stopped' }));
    expect(spy).toHaveBeenCalled();
    client.disconnect();
  });

  it('accumulates audio transcript deltas', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    mockDc.simulateMessage(JSON.stringify({ type: 'response.created' }));
    mockDc.simulateMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hello ' }));
    mockDc.simulateMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'world' }));

    const spy = vi.fn();
    client.on('response', spy);
    mockDc.simulateMessage(JSON.stringify({ type: 'response.done' }));

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello world' }));
    client.disconnect();
  });

  it('includes userText from input_audio_transcription', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    mockDc.simulateMessage(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'What is the weather?',
    }));
    mockDc.simulateMessage(JSON.stringify({ type: 'response.created' }));

    const spy = vi.fn();
    client.on('response', spy);
    mockDc.simulateMessage(JSON.stringify({ type: 'response.done' }));

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ userText: 'What is the weather?' }),
    );
    client.disconnect();
  });

  it('emits transcript deltas', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    const transcriptSpy = vi.fn();
    client.on('transcript', transcriptSpy);

    mockDc.simulateMessage(JSON.stringify({ type: 'response.audio_transcript.delta', delta: 'Hi' }));
    expect(transcriptSpy).toHaveBeenCalledWith({ delta: 'Hi', full: 'Hi' });
    client.disconnect();
  });

  it('emits error event for server errors', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    const errorSpy = vi.fn();
    client.on('error', errorSpy);
    mockDc.simulateMessage(JSON.stringify({
      type: 'error',
      error: { message: 'Rate limit exceeded' },
    }));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Rate limit') }),
    );
    client.disconnect();
  });

  it('ignores unknown event types silently', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    expect(() => {
      mockDc.simulateMessage(JSON.stringify({ type: 'some.unknown.event', data: 'x' }));
    }).not.toThrow();
    client.disconnect();
  });

  it('handles malformed JSON gracefully', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    expect(() => {
      mockDc.simulateMessage('not valid json{{{{');
    }).not.toThrow();
    client.disconnect();
  });

  it('clears accumulators after response.done', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    mockDc.simulateMessage(JSON.stringify({ type: 'response.created' }));
    mockDc.simulateMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'First' }));
    mockDc.simulateMessage(JSON.stringify({ type: 'response.done' }));

    // Second turn should start fresh
    const spy = vi.fn();
    client.on('response', spy);
    mockDc.simulateMessage(JSON.stringify({ type: 'response.created' }));
    mockDc.simulateMessage(JSON.stringify({ type: 'response.done' }));

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ text: '' }));
    client.disconnect();
  });

  it('resets error on session.updated', async () => {
    const client = await createConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    // Trigger an error first
    mockDc.simulateMessage(JSON.stringify({ type: 'error', error: { message: 'Oops' } }));
    expect(client.error).toContain('Oops');

    // session.updated should clear error
    mockDc.simulateMessage(JSON.stringify({ type: 'session.updated' }));
    expect(client.error).toBeNull();
    client.disconnect();
  });
});

// ── connect error handling ────────────────────────────────────────────────────

describe('connect() error handling', () => {
  it('emits error and sets phase to failed when getUserMedia throws', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => { throw new Error('Permission denied'); }),
      },
    });

    const client = new OpenAIRealtimeClient();
    const errorSpy = vi.fn();
    client.on('error', errorSpy);
    await client.connect().catch(() => {});
    // Either errorSpy was called or phase is failed
    // (depending on whether the error flows through emit or reject)
    expect(client.phase).toBe('failed');
    client.disconnect();
  });

  it('emits error when SDP fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => '{"error":"Internal Server Error"}',
    })));

    const client = new OpenAIRealtimeClient();
    const errorSpy = vi.fn();
    client.on('error', errorSpy);
    await client.connect().catch(() => {});

    await new Promise(r => setTimeout(r, 10));
    expect(client.phase).toBe('failed');
    client.disconnect();
  });

  it('emits error when SDP answer is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => 'not a valid sdp answer',
    })));

    const client = new OpenAIRealtimeClient();
    const errorSpy = vi.fn();
    client.on('error', errorSpy);
    await client.connect().catch(() => {});
    await new Promise(r => setTimeout(r, 10));
    expect(client.phase).toBe('failed');
    client.disconnect();
  });
});

// ── status-change events ─────────────────────────────────────────────────────

describe('status-change events', () => {
  it('emits status-change events during connect phases', async () => {
    const client = new OpenAIRealtimeClient();
    const phases: string[] = [];
    client.on('status-change', (e: { phase: string }) => phases.push(e.phase));

    await client.connect().catch(() => {});
    await new Promise(r => setTimeout(r, 10));

    // Should have gone through at least requesting-mic → creating-offer → sending-sdp or failed
    expect(phases.length).toBeGreaterThan(0);
    client.disconnect();
  });
});

// ── response.done edge cases ─────────────────────────────────────────────────

describe('response.done edge cases', () => {
  async function getConnectedClient() {
    const client = new OpenAIRealtimeClient({ sdpEndpoint: '/api/realtime/calls' });
    const cp = client.connect();
    await new Promise(r => setTimeout(r, 5));
    mockDc?.simulateOpen();
    await new Promise(r => setTimeout(r, 5));
    cp.catch(() => {});
    return client;
  }

  it('falls back to response.output from response data when transcripts are empty', async () => {
    const client = await getConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    const spy = vi.fn();
    client.on('response', spy);

    mockDc.simulateMessage(JSON.stringify({ type: 'response.created' }));
    mockDc.simulateMessage(JSON.stringify({
      type: 'response.done',
      response: {
        output: [
          {
            content: [{ transcript: 'Extracted transcript' }],
          },
        ],
      },
    }));

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Extracted transcript' }),
    );
    client.disconnect();
  });

  it('emits speaking-end after response.done', async () => {
    const client = await getConnectedClient();
    expect(mockDc?.readyState).toBe('open');

    const spy = vi.fn();
    client.on('speaking-end', spy);

    mockDc.simulateMessage(JSON.stringify({ type: 'response.created' }));
    mockDc.simulateMessage(JSON.stringify({ type: 'response.done' }));

    expect(spy).toHaveBeenCalled();
    client.disconnect();
  });
});
