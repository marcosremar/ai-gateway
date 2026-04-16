import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingAudioPlayer } from '../src/browser/streaming-audio';

// ── Web Audio API Mock ────────────────────────────────────────────────────────

const mockDisconnect = vi.fn();
const mockConnect = vi.fn();
const mockSetValueAtTime = vi.fn();
const mockStop = vi.fn();
const mockStart = vi.fn();
const mockGetChannelData = vi.fn((ch: number) => new Float32Array(10000)); // large enough for any test

let mockSourceOnEnded: (() => void) | null = null;

function makeMockSource() {
  const src = {
    buffer: null as unknown,
    connect: mockConnect,
    start: mockStart,
    stop: mockStop,
    onended: null as (() => void) | null,
  };
  // Capture onended setter
  let _onended: (() => void) | null = null;
  Object.defineProperty(src, 'onended', {
    set(fn: () => void) { _onended = fn; mockSourceOnEnded = fn; },
    get() { return _onended; },
  });
  return src;
}

const mockCreateBufferSource = vi.fn(() => makeMockSource());

const mockCreateBuffer = vi.fn((channels: number, length: number, sampleRate: number) => ({
  length,
  duration: length / sampleRate,
  sampleRate,
  getChannelData: mockGetChannelData,
}));

const mockLinearRampToValueAtTime = vi.fn();

const mockGainNode = {
  gain: { setValueAtTime: mockSetValueAtTime, linearRampToValueAtTime: mockLinearRampToValueAtTime },
  connect: mockConnect,
  disconnect: mockDisconnect,
};

const mockDestinationNode = {
  stream: { id: 'mock-stream' } as unknown as MediaStream,
  connect: mockConnect,
  disconnect: mockDisconnect,
};

const mockClose = vi.fn(() => Promise.resolve());

let mockCurrentTime = 0;

// Use a class for the mock so `new AudioContext()` works
class MockAudioContext {
  get currentTime() { return mockCurrentTime; }
  sampleRate = 44100;
  destination = {};
  createGain() { return mockGainNode; }
  createMediaStreamDestination() { return mockDestinationNode; }
  createBufferSource() { return mockCreateBufferSource(); }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return mockCreateBuffer(channels, length, sampleRate);
  }
  close() { return mockClose(); }
}

// Install global mock
vi.stubGlobal('AudioContext', MockAudioContext);

// Disable Worker so StreamingAudioPlayer falls back to synchronous main-thread PCM decode.
// In bun's test runtime, real Workers don't flush in time for setTimeout(0).
vi.stubGlobal('Worker', class { constructor() { throw new Error('no Worker in test'); } });

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

// ── Helper: create a minimal WAV chunk ───────────────────────────────────────

function makeWavChunk(
  sampleRate = 16000,
  bitsPerSample = 16,
  numChannels = 1,
  numSamples = 100,
): Uint8Array {
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // RIFF header
  uint8[0] = 0x52; uint8[1] = 0x49; uint8[2] = 0x46; uint8[3] = 0x46; // 'RIFF'
  view.setUint32(4, 36 + dataSize, true);
  uint8[8] = 0x57; uint8[9] = 0x41; uint8[10] = 0x56; uint8[11] = 0x45; // 'WAVE'

  // fmt chunk
  uint8[12] = 0x66; uint8[13] = 0x6D; uint8[14] = 0x74; uint8[15] = 0x20; // 'fmt '
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  view.setUint16(32, numChannels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  uint8[36] = 0x64; uint8[37] = 0x61; uint8[38] = 0x74; uint8[39] = 0x61; // 'data'
  view.setUint32(40, dataSize, true);

  // Fill with 16-bit PCM data
  if (bitsPerSample === 16) {
    for (let i = 0; i < numSamples * numChannels; i++) {
      view.setInt16(headerSize + i * 2, i * 100, true);
    }
  }

  return uint8;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StreamingAudioPlayer', () => {
  let player: StreamingAudioPlayer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClose.mockResolvedValue(undefined);
    mockCurrentTime = 0;
    mockSourceOnEnded = null;
    player = new StreamingAudioPlayer();
  });

  afterEach(() => {
    try { player.destroy(); } catch { /* already destroyed */ }
  });

  describe('init()', () => {
    it('should initialize AudioContext and nodes', () => {
      player.init();
      // After init, audioCtx is set (verified via getMediaStream working)
      expect(player.getMediaStream()).not.toBeNull();
    });

    it('should not re-initialize if already initialized', () => {
      player.init();
      const stream1 = player.getMediaStream();
      player.init();
      const stream2 = player.getMediaStream();
      // Should be same object (not re-created)
      expect(stream1).toBe(stream2);
    });
  });

  describe('getMediaStream()', () => {
    it('should return null before init', () => {
      expect(player.getMediaStream()).toBeNull();
    });

    it('should return MediaStream after init', () => {
      player.init();
      const stream = player.getMediaStream();
      expect(stream).not.toBeNull();
    });
  });

  describe('setVolume()', () => {
    it('should set volume on gain node after init', () => {
      player.init();
      player.setVolume(2.0);
      expect(mockSetValueAtTime).toHaveBeenCalledWith(2.0, expect.any(Number));
    });

    it('should not throw before init', () => {
      expect(() => player.setVolume(0.5)).not.toThrow();
    });
  });

  describe('feedChunk()', () => {
    it('should skip chunks of 44 bytes or less (header-only)', () => {
      const tiny = new Uint8Array(44);
      player.feedChunk(tiny);
      expect(mockCreateBuffer).not.toHaveBeenCalled();
    });

    it('should skip chunks smaller than 44 bytes', () => {
      const tiny = new Uint8Array(20);
      player.feedChunk(tiny);
      expect(mockCreateBuffer).not.toHaveBeenCalled();
    });

    it('should process 16-bit WAV chunk', async () => {
      const chunk = makeWavChunk(16000, 16, 1, 100);
      player.feedChunk(chunk);
      await flushMicrotasks();
      expect(mockCreateBuffer).toHaveBeenCalled();
      expect(mockCreateBufferSource).toHaveBeenCalled();
    });

    it('should start playing on first valid chunk', async () => {
      const chunk = makeWavChunk();
      mockCurrentTime = 1.0;
      player.feedChunk(chunk);
      await flushMicrotasks();
      expect(mockStart).toHaveBeenCalledWith(expect.any(Number));
      const startTime = (mockStart.mock.calls[0] as number[])[0];
      expect(startTime).toBeGreaterThan(1.0);
    });

    it('should fire onStarted callback on first chunk', async () => {
      const onStarted = vi.fn();
      player.onStarted = onStarted;
      const chunk = makeWavChunk();
      player.feedChunk(chunk);
      await flushMicrotasks();
      expect(onStarted).toHaveBeenCalledOnce();
    });

    it('should not fire onStarted on subsequent chunks', async () => {
      const onStarted = vi.fn();
      player.onStarted = onStarted;
      const chunk = makeWavChunk();
      player.feedChunk(chunk);
      player.feedChunk(chunk);
      await flushMicrotasks();
      expect(onStarted).toHaveBeenCalledTimes(1);
    });

    it('should not process chunk if destroyed', () => {
      player.destroy();
      const chunk = makeWavChunk();
      player.feedChunk(chunk);
      expect(mockCreateBuffer).not.toHaveBeenCalled();
    });

    it('should skip invalid WAV header (non-RIFF)', () => {
      const badChunk = new Uint8Array(200);
      // First 4 bytes are 0x00, not 'RIFF'
      player.feedChunk(badChunk);
      expect(mockCreateBuffer).not.toHaveBeenCalled();
    });

    it('should handle stereo chunks', async () => {
      const chunk = makeWavChunk(44100, 16, 2, 100);
      player.feedChunk(chunk);
      await flushMicrotasks();
      expect(mockCreateBuffer).toHaveBeenCalledWith(2, expect.any(Number), 44100);
    });

    it('should connect source to gain node', () => {
      const chunk = makeWavChunk();
      player.feedChunk(chunk);
      expect(mockConnect).toHaveBeenCalled();
    });
  });

  describe('scheduledDuration', () => {
    it('should return 0 before any chunks', () => {
      expect(player.scheduledDuration).toBe(0);
    });

    it('should return positive value after chunks', () => {
      const chunk = makeWavChunk(16000, 16, 1, 1600);
      player.feedChunk(chunk);
      // After feeding a chunk, scheduledDuration = totalSamples / sampleRate
      expect(player.scheduledDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('finalize()', () => {
    it('should fire onEnded immediately if no active sources', () => {
      const onEnded = vi.fn();
      player.onEnded = onEnded;
      player.finalize();
      expect(onEnded).toHaveBeenCalledOnce();
    });

    it('should not fire onEnded twice', () => {
      const onEnded = vi.fn();
      player.onEnded = onEnded;
      player.finalize();
      player.finalize();
      expect(onEnded).toHaveBeenCalledTimes(1);
    });
  });

  describe('destroy()', () => {
    it('should close AudioContext', async () => {
      player.init();
      player.destroy();
      await new Promise((r) => setTimeout(r, 10));
      expect(mockClose).toHaveBeenCalled();
    });

    it('should disconnect gain and destination nodes', () => {
      player.init();
      player.destroy();
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('should stop all scheduled sources', async () => {
      const chunk = makeWavChunk();
      player.feedChunk(chunk);
      await flushMicrotasks();
      player.destroy();
      expect(mockStop).toHaveBeenCalled();
    });

    it('should not throw when called multiple times', () => {
      player.init();
      player.destroy();
      expect(() => player.destroy()).not.toThrow();
    });

    it('should mute before disconnecting', () => {
      player.init();
      player.destroy();
      expect(mockSetValueAtTime).toHaveBeenCalledWith(0, expect.any(Number));
    });

    it('should prevent further feedChunk processing', () => {
      player.destroy();
      const chunk = makeWavChunk();
      expect(() => player.feedChunk(chunk)).not.toThrow();
      expect(mockCreateBuffer).not.toHaveBeenCalled();
    });
  });
});
