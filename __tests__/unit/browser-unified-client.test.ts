/**
 * Tests for src/browser/unified-client.ts
 * Uses vi.mock to intercept dynamic imports of openai-realtime and speech-client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TypedEmitter } from '../../src/browser/emitter';

// ── Mock dynamic imports ─────────────────────────────────────────────────────

// Mock OpenAIRealtimeClient
class MockRealtimeClient extends TypedEmitter<any> {
  connect = vi.fn(async () => {
    this.emit('connected', {});
  });
  disconnect = vi.fn();
  sendText = vi.fn();
}

// Mock SpeechClient
class MockSpeechClient extends TypedEmitter<any> {
  connect = vi.fn(async () => {
    this.emit('connected', {});
  });
  disconnect = vi.fn();
  sendAudio = vi.fn(async () => {});
  sendText = vi.fn();
}

let mockRealtimeInstance: MockRealtimeClient;
let mockSpeechInstance: MockSpeechClient;

vi.mock('../../src/browser/openai-realtime', () => ({
  OpenAIRealtimeClient: class {
    constructor(opts: any) {
      mockRealtimeInstance = new MockRealtimeClient();
      return mockRealtimeInstance;
    }
  },
}));

vi.mock('../../src/browser/speech-client', () => ({
  SpeechClient: class {
    constructor(config: any) {
      mockSpeechInstance = new MockSpeechClient();
      return mockSpeechInstance;
    }
  },
}));

// ── Import after mocking ─────────────────────────────────────────────────────

import { UnifiedSpeechClient } from '../../src/browser/unified-client';
import type { UnifiedSpeechClientConfig } from '../../src/browser/unified-client';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<UnifiedSpeechClientConfig> = {}): UnifiedSpeechClientConfig {
  return {
    pipeline: { discoveryEndpoint: '/api/health' },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('UnifiedSpeechClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('activeTransport is none initially', () => {
      const client = new UnifiedSpeechClient(makeConfig());
      expect(client.activeTransport).toBe('none');
    });

    it('isConnected is false initially', () => {
      const client = new UnifiedSpeechClient(makeConfig());
      expect(client.isConnected).toBe(false);
    });
  });

  describe('pipeline-only strategy', () => {
    it('connects via pipeline when strategy is pipeline-only', async () => {
      const client = new UnifiedSpeechClient(makeConfig({ strategy: 'pipeline-only' }));
      const connectedEvent = vi.fn();
      client.on('connected', connectedEvent);

      await client.connect();

      expect(connectedEvent).toHaveBeenCalledWith({ transport: 'pipeline' });
      expect(client.activeTransport).toBe('pipeline');
      expect(client.isConnected).toBe(true);
    });

    it('emits error when no transport configured', async () => {
      const client = new UnifiedSpeechClient({ strategy: 'pipeline-only' }); // no pipeline config
      const errorEvent = vi.fn();
      client.on('error', errorEvent);
      await client.connect();
      expect(errorEvent).toHaveBeenCalledWith(
        expect.objectContaining({ fatal: true, transport: 'none' }),
      );
    });
  });

  describe('realtime-first strategy', () => {
    it('connects via realtime when config provided', async () => {
      const client = new UnifiedSpeechClient(makeConfig({
        realtime: { model: 'gpt-4o-mini-realtime-preview' },
        strategy: 'realtime-first',
      }));
      const connectedEvent = vi.fn();
      client.on('connected', connectedEvent);

      await client.connect();

      expect(connectedEvent).toHaveBeenCalledWith({ transport: 'realtime' });
      expect(client.activeTransport).toBe('realtime');
    });

    it('falls back to pipeline when realtime throws', async () => {
      const client = new UnifiedSpeechClient(makeConfig({
        realtime: { model: 'gpt-4o-mini-realtime-preview' },
        strategy: 'realtime-first',
      }));
      const fallbackEvent = vi.fn();
      const connectedEvent = vi.fn();
      client.on('fallback', fallbackEvent);
      client.on('connected', connectedEvent);

      // Make realtime connect throw
      vi.mocked(mockRealtimeInstance?.connect ?? vi.fn()).mockRejectedValueOnce(new Error('WebRTC failed'));

      // Need to wait for connect which triggers dynamic import
      // Override the dynamic mock behavior via a fresh mock instance
      const mockModule = await import('../../src/browser/openai-realtime');
      // @ts-ignore
      mockModule.OpenAIRealtimeClient = class {
        connect = vi.fn(async () => { throw new Error('WebRTC failed'); });
        disconnect = vi.fn();
        on = vi.fn();
        off = vi.fn();
        emit = vi.fn();
        removeAllListeners = vi.fn();
      };

      await client.connect();

      // Should have fallen back to pipeline
      expect(connectedEvent).toHaveBeenCalledWith({ transport: 'pipeline' });
    });
  });

  describe('disconnect', () => {
    it('sets activeTransport to none', async () => {
      const client = new UnifiedSpeechClient(makeConfig());
      await client.connect();
      expect(client.isConnected).toBe(true);
      client.disconnect();
      expect(client.activeTransport).toBe('none');
      expect(client.isConnected).toBe(false);
    });

    it('emits disconnected event', async () => {
      const client = new UnifiedSpeechClient(makeConfig());
      await client.connect();
      const disconnectedEvent = vi.fn();
      client.on('disconnected', disconnectedEvent);
      client.disconnect();
      expect(disconnectedEvent).toHaveBeenCalledWith({ reason: 'user' });
    });

    it('does not emit disconnected when already disconnected', () => {
      const client = new UnifiedSpeechClient(makeConfig());
      const disconnectedEvent = vi.fn();
      client.on('disconnected', disconnectedEvent);
      client.disconnect(); // already disconnected
      expect(disconnectedEvent).not.toHaveBeenCalled();
    });

    it('calls disconnect on pipeline client', async () => {
      const client = new UnifiedSpeechClient(makeConfig({ strategy: 'pipeline-only' }));
      await client.connect();
      const disconnectSpy = vi.spyOn(mockSpeechInstance, 'disconnect');
      client.disconnect();
      expect(disconnectSpy).toHaveBeenCalled();
    });
  });

  describe('sendAudio', () => {
    it('sends audio to pipeline transport', async () => {
      const client = new UnifiedSpeechClient(makeConfig({ strategy: 'pipeline-only' }));
      await client.connect();
      const audio = new Float32Array([0.1, 0.2]);
      const sendSpy = vi.spyOn(mockSpeechInstance, 'sendAudio');
      await client.sendAudio(audio);
      expect(sendSpy).toHaveBeenCalledWith(audio);
    });

    it('no-op when not connected', async () => {
      const client = new UnifiedSpeechClient(makeConfig({ strategy: 'pipeline-only' }));
      // Don't connect
      await expect(client.sendAudio(new Float32Array())).resolves.not.toThrow();
    });
  });

  describe('sendText', () => {
    it('sends text to pipeline transport', async () => {
      const client = new UnifiedSpeechClient(makeConfig({ strategy: 'pipeline-only' }));
      await client.connect();
      const sendSpy = vi.spyOn(mockSpeechInstance, 'sendText');
      client.sendText('hello');
      expect(sendSpy).toHaveBeenCalledWith('hello');
    });

    it('no-op when not connected', () => {
      const client = new UnifiedSpeechClient(makeConfig());
      expect(() => client.sendText('hello')).not.toThrow();
    });
  });

  describe('destroy', () => {
    it('sets destroyed flag and clears listeners', async () => {
      const client = new UnifiedSpeechClient(makeConfig());
      await client.connect();
      client.destroy();
      expect(client.activeTransport).toBe('none');
      // After destroy, connect is a no-op
      await expect(client.connect()).resolves.not.toThrow();
      expect(client.activeTransport).toBe('none'); // still none
    });
  });

  describe('event forwarding from pipeline', () => {
    it('forwards stage-change events', async () => {
      const client = new UnifiedSpeechClient(makeConfig({ strategy: 'pipeline-only' }));
      const stageChange = vi.fn();
      client.on('stage-change', stageChange);
      await client.connect();
      mockSpeechInstance.emit('stage-change', { stage: 'processing' });
      expect(stageChange).toHaveBeenCalledWith({ stage: 'processing' });
    });

    it('forwards audio-chunk events', async () => {
      const client = new UnifiedSpeechClient(makeConfig({ strategy: 'pipeline-only' }));
      const audioChunk = vi.fn();
      client.on('audio-chunk', audioChunk);
      await client.connect();
      const chunk = new Uint8Array([1, 2, 3]);
      mockSpeechInstance.emit('audio-chunk', { chunk });
      expect(audioChunk).toHaveBeenCalledWith({ chunk });
    });

    it('forwards response events from pipeline', async () => {
      const client = new UnifiedSpeechClient(makeConfig({ strategy: 'pipeline-only' }));
      const responseEvent = vi.fn();
      client.on('response', responseEvent);
      await client.connect();
      mockSpeechInstance.emit('response', {
        text: 'response text',
        userText: 'user said',
        audio: 'base64audio',
        visemes: [],
        duration: 1.0,
      });
      expect(responseEvent).toHaveBeenCalledWith(expect.objectContaining({
        text: 'response text',
        transport: 'pipeline',
      }));
    });

    it('forwards error events', async () => {
      const client = new UnifiedSpeechClient(makeConfig({ strategy: 'pipeline-only' }));
      const errorEvent = vi.fn();
      client.on('error', errorEvent);
      await client.connect();
      mockSpeechInstance.emit('error', { message: 'connection error' });
      expect(errorEvent).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'connection error', transport: 'pipeline' }),
      );
    });
  });
});
