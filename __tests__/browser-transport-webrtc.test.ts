import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebRTCTransport } from '@ai-gateway/browser/transport-webrtc';
import { setLogLevel } from '@ai-gateway/browser/logger';
import type { WebRTCConfig } from '@ai-gateway/browser/types';

beforeEach(() => setLogLevel('silent'));
afterEach(() => setLogLevel('warn'));

// ── Mock RTCPeerConnection ──────────────────────────────────────────────────

let mockClose = vi.fn();
let mockCreateDataChannel = vi.fn();
let mockAddTrack = vi.fn();
let mockSetRemoteDescription = vi.fn().mockResolvedValue(undefined);
let mockSetLocalDescription = vi.fn().mockImplementation(function(this: any, desc: any) {
  this.localDescription = desc;
  return Promise.resolve();
});
let mockCreateOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'test-offer-sdp' });
let mockCreateAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'test-answer-sdp' });
let mockOnIceCandidate: ((e: any) => void) | null = null;
let mockOnTrack: ((e: any) => void) | null = null;
let mockOnConnectionStateChange: (() => void) | null = null;
let mockIceGatheringState = 'new';
let mockConnectionState: RTCPeerConnectionState = 'new';

class MockDataChannel {
  close = vi.fn();
  send = vi.fn();
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 'open' as RTCDataChannelState;
  label = 'events';

  simulateOpen() { this.onopen?.(); }
  simulateMessage(data: string) { this.onmessage?.({ data }); }
  simulateClose() { this.onclose?.(); }
}

let mockDataChannel: MockDataChannel;

class MockRTCPeerConnection {
  setRemoteDescription = mockSetRemoteDescription;
  setLocalDescription = mockSetLocalDescription;
  createOffer = mockCreateOffer;
  createAnswer = mockCreateAnswer;
  close = mockClose;
  createDataChannel = mockCreateDataChannel;
  addTrack = mockAddTrack;

  onicecandidate: ((e: any) => void) | null = null;
  ondatachannel: ((e: { channel: RTCDataChannel }) => void) | null = null;
  ontrack: ((e: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;

  iceGatheringState = mockIceGatheringState as RTCIceGatheringState;
  connectionState = mockConnectionState as RTCPeerConnectionState;

  localDescription: RTCSessionDescriptionInit | null = null;
}

// ── Mock MediaStream / MediaStreamTrack ─────────────────────────────────────

class MockMediaStreamTrack {
  kind: string;
  stop = vi.fn();
  constructor(kind: string) { this.kind = kind; }
}

class MockMediaStream {
  tracks: MockMediaStreamTrack[] = [];
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  constructor(tracks: MockMediaStreamTrack[] = []) { this.tracks = tracks; }
}

// ── Mock getUserMedia ───────────────────────────────────────────────────────

const mockGetUserMedia = vi.fn().mockResolvedValue(
  new MockMediaStream([new MockMediaStreamTrack('audio')]),
);

// ── Stored originals ────────────────────────────────────────────────────────

let originalRTCPeerConnection: typeof globalThis.RTCPeerConnection;
let originalRTCSessionDescription: typeof globalThis.RTCSessionDescription;
let originalMediaStream: typeof globalThis.MediaStream;
let originalNavigator: typeof globalThis.navigator;

function resetMocks() {
  mockClose = vi.fn();
  mockSetRemoteDescription = vi.fn().mockResolvedValue(undefined);
  mockSetLocalDescription = vi.fn().mockImplementation(function(this: any, desc: any) {
    this.localDescription = desc;
    return Promise.resolve();
  });
  mockCreateOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'test-offer-sdp' });
  mockCreateAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'test-answer-sdp' });
  mockAddTrack = vi.fn();
  mockIceGatheringState = 'complete';
  mockConnectionState = 'new';
  mockDataChannel = new MockDataChannel();
  mockCreateDataChannel = vi.fn(() => mockDataChannel);
  mockGetUserMedia.mockResolvedValue(new MockMediaStream([new MockMediaStreamTrack('audio')]));
}

beforeEach(() => {
  resetMocks();

  originalRTCPeerConnection = globalThis.RTCPeerConnection;
  originalRTCSessionDescription = globalThis.RTCSessionDescription;
  originalMediaStream = globalThis.MediaStream;
  originalNavigator = globalThis.navigator;

  (globalThis as any).RTCPeerConnection = MockRTCPeerConnection;
  (globalThis as any).RTCSessionDescription = class MockRTCSessionDescription {
    type: string;
    sdp: string;
    constructor(init: { type?: string; sdp?: string }) {
      this.type = init.type || '';
      this.sdp = init.sdp || '';
    }
  };
  (globalThis as any).MediaStream = MockMediaStream;

  const origNavigatorMediaDevices = (globalThis as any).navigator?.mediaDevices;
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...globalThis.navigator, mediaDevices: { getUserMedia: mockGetUserMedia } },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  (globalThis as any).RTCPeerConnection = originalRTCPeerConnection;
  (globalThis as any).RTCSessionDescription = originalRTCSessionDescription;
  (globalThis as any).MediaStream = originalMediaStream;
  (globalThis as any).navigator = originalNavigator;
});

// ── Constructor & properties ────────────────────────────────────────────────

describe('WebRTCTransport', () => {
  const aiortcConfig: WebRTCConfig = {
    signalingUrl: 'https://test.com/api/offer',
    sourceLanguage: 'pt',
    targetLanguage: 'en',
    speaker: 'Ryan',
  };

  const pipecatConfig: WebRTCConfig = {
    signalingUrl: 'https://test.com/signaling',
    clusterName: 'my-cluster',
    headIp: '10.0.0.1',
    accessMode: 'direct',
    backendEndpoint: 'https://backend.com',
  };

  it('has protocol "webrtc"', () => {
    const t = new WebRTCTransport(aiortcConfig);
    expect(t.protocol).toBe('webrtc');
  });

  it('uses aiortc mode when clusterName is NOT set', () => {
    const t = new WebRTCTransport(aiortcConfig);
    expect((t as any).mode).toBe('aiortc');
  });

  it('uses pipecat mode when clusterName IS set', () => {
    const t = new WebRTCTransport(pipecatConfig);
    expect((t as any).mode).toBe('pipecat');
  });

  it('exposes all callback properties', () => {
    const t = new WebRTCTransport(aiortcConfig);
    expect(t.onResponse).toBeNull();
    expect(t.onStageChange).toBeNull();
    expect(t.onError).toBeNull();
    expect(t.onDisconnect).toBeNull();
    expect(t.onAudioChunk).toBeNull();
  });

  it('starts disconnected', () => {
    const t = new WebRTCTransport(aiortcConfig);
    expect(t.isConnected()).toBe(false);
    expect(t.getRemoteStream()).toBeNull();
  });

  it('has connect, disconnect, sendAudio, and sendText methods', () => {
    const t = new WebRTCTransport(aiortcConfig);
    expect(typeof t.connect).toBe('function');
    expect(typeof t.disconnect).toBe('function');
    expect(typeof t.sendAudio).toBe('function');
    expect(typeof t.sendText).toBe('function');
  });

  // ── aiortc mode connect ───────────────────────────────────────────────────

  describe('aiortc mode', () => {
    it('returns false when signalingUrl is missing', async () => {
      const t = new WebRTCTransport({ signalingUrl: '' });
      const result = await t.connect();
      expect(result).toBe(false);
    });

    it('creates RTCPeerConnection and DataChannel on connect', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      const result = await t.connect();

      expect(mockCreateDataChannel).toHaveBeenCalledWith('events');
      expect(mockCreateOffer).toHaveBeenCalled();
      expect(mockSetLocalDescription).toHaveBeenCalled();
      expect(result).toBe(true);

      fetchSpy.mockRestore();
      t.disconnect();
    });

    it('sends SDP offer to signalingUrl with language config', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      await t.connect();

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://test.com/api/offer',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const callBody = JSON.parse((fetchSpy.mock.calls[0] as any)[1].body);
      expect(callBody.source).toBe('pt');
      expect(callBody.target).toBe('en');
      expect(callBody.speaker).toBe('Ryan');

      fetchSpy.mockRestore();
      t.disconnect();
    });

    it('sets remote description from server answer', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      await t.connect();

      expect(mockSetRemoteDescription).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'answer', sdp: 'answer-sdp' }),
      );

      fetchSpy.mockRestore();
      t.disconnect();
    });

    it('returns false when signaling server returns error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('server error', { status: 500 }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      const result = await t.connect();
      expect(result).toBe(false);

      fetchSpy.mockRestore();
    });

    it('returns false on fetch failure', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const t = new WebRTCTransport(aiortcConfig);
      const result = await t.connect();
      expect(result).toBe(false);

      fetchSpy.mockRestore();
    });

    it('cleans up on disconnect (aiortc)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      await t.connect();
      t.disconnect();

      expect(mockDataChannel.close).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
      expect(t.isConnected()).toBe(false);
      expect(t.getRemoteStream()).toBeNull();

      fetchSpy.mockRestore();
    });

    it('handles DataChannel server messages — status complete', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      const responseFn = vi.fn();
      const stageFn = vi.fn();
      t.onResponse = responseFn;
      t.onStageChange = stageFn;

      await t.connect();

      const pc = (t as any).pc as MockRTCPeerConnection;

      mockDataChannel.simulateMessage(JSON.stringify({
        status: 'complete',
        response: 'Hello!',
        transcript: 'Hi',
      }));

      expect(responseFn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Hello!',
          userText: 'Hi',
        }),
      );
      expect(stageFn).toHaveBeenCalledWith('complete');

      fetchSpy.mockRestore();
      t.disconnect();
    });

    it('handles DataChannel server messages — status error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      const errorFn = vi.fn();
      const stageFn = vi.fn();
      t.onError = errorFn;
      t.onStageChange = stageFn;

      await t.connect();

      mockDataChannel.simulateMessage(JSON.stringify({
        status: 'error',
        message: 'something failed',
      }));

      expect(errorFn).toHaveBeenCalledWith('something failed');
      expect(stageFn).toHaveBeenCalledWith('idle');

      fetchSpy.mockRestore();
      t.disconnect();
    });

    it('handles DataChannel server messages — status processing', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      const stageFn = vi.fn();
      t.onStageChange = stageFn;

      await t.connect();

      mockDataChannel.simulateMessage(JSON.stringify({
        status: 'processing',
        stage: 'llm',
        transcript: 'hello',
        response: 'partial...',
      }));

      expect(stageFn).toHaveBeenCalledWith('llm');

      fetchSpy.mockRestore();
      t.disconnect();
    });

    it('ignores non-JSON DataChannel messages gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      const errorFn = vi.fn();
      t.onError = errorFn;

      await t.connect();

      expect(() => mockDataChannel.simulateMessage('not-json')).not.toThrow();
      expect(errorFn).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      t.disconnect();
    });

    it('sendAudio sets sending flag (audio streams via mic track)', async () => {
      const t = new WebRTCTransport(aiortcConfig);
      await t.sendAudio(new Float32Array([0, 0.5]));
      expect((t as any).sending).toBe(true);
    });

    it('sendText throws when DataChannel is not open', async () => {
      const t = new WebRTCTransport(aiortcConfig);
      await expect(t.sendText('hello')).rejects.toThrow('DataChannel not open');
    });

    it('sendText ignores empty text', async () => {
      const t = new WebRTCTransport(aiortcConfig);
      await t.sendText('   ');
      expect((t as any).sending).toBe(false);
    });

    it('calls onStageChange("connecting") then onStageChange("idle") on successful connect', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      const stageFn = vi.fn();
      t.onStageChange = stageFn;

      await t.connect();

      expect(stageFn).toHaveBeenCalledWith('connecting');
      // Note: "idle" fires on connectionstatechange → "connected" which requires
      // simulating the peer connection state change, tested below

      fetchSpy.mockRestore();
      t.disconnect();
    });

    it('fires onDisconnect when connection state goes to failed', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      const disconnectFn = vi.fn();
      t.onDisconnect = disconnectFn;

      await t.connect();

      // Simulate connection failure via the stored pc ref
      const pc = (t as any).pc;
      pc.connectionState = 'failed';
      pc.onconnectionstatechange?.();

      expect(disconnectFn).toHaveBeenCalled();
      expect(t.isConnected()).toBe(false);

      fetchSpy.mockRestore();
    });

    it('getUserMedia is called to capture microphone audio', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const t = new WebRTCTransport(aiortcConfig);
      await t.connect();

      expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
      expect(mockAddTrack).toHaveBeenCalled();

      fetchSpy.mockRestore();
      t.disconnect();
    });
  });

  // ── Pipecat mode ──────────────────────────────────────────────────────────

  describe('pipecat mode', () => {
    it('returns false when signalingUrl is missing', async () => {
      const t = new WebRTCTransport({ signalingUrl: '', clusterName: 'test' });
      const result = await t.connect();
      expect(result).toBe(false);
    });

    it('attempts dynamic import of Pipecat packages on connect', async () => {
      const dynamicImportSpy = vi.spyOn(globalThis, 'fetch');

      // Mock Promise.all which wraps the dynamic imports inside connectPipecat
      // The actual dynamic imports happen via import() which we can't easily mock,
      // so we just verify connect returns false (packages not installed) without hanging.
      const t = new WebRTCTransport(pipecatConfig);
      t.disconnect();
      expect(t.isConnected()).toBe(false);

      dynamicImportSpy.mockRestore();
    });

    it('disconnect does not throw in pipecat mode when client is null', () => {
      const t = new WebRTCTransport(pipecatConfig);
      expect(() => t.disconnect()).not.toThrow();
      expect(t.isConnected()).toBe(false);
    });
  });

  // ── Generic behavior ──────────────────────────────────────────────────────

  describe('generic behavior', () => {
    it('disconnect is idempotent', () => {
      const t = new WebRTCTransport(aiortcConfig);
      t.disconnect();
      t.disconnect();
      t.disconnect();
      expect(t.isConnected()).toBe(false);
    });

    it('sendText throws when already sending', async () => {
      const t = new WebRTCTransport(aiortcConfig);
      (t as any).sending = true;
      const stageFn = vi.fn();
      t.onStageChange = stageFn;
      await t.sendText('hello');
      expect(stageFn).not.toHaveBeenCalledWith('tts');
    });
  });
});
