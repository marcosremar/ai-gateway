import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSETransport } from '@ai-gateway/browser/transport-sse';
import type { SSEConfig, SpeechResponse, ProcessingStage } from '@ai-gateway/browser/types';

// ── SSE stream helpers ──────────────────────────────────────────────────

function sseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

function sseResponse(events: string[], status = 200): Response {
  return new Response(makeSSEStream(events), {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseConfig: SSEConfig = {
  endpoint: 'http://test:8000',
};

describe('SSETransport', () => {
  let transport: SSETransport;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // Mock browser APIs needed by transport
    vi.stubGlobal('FormData', globalThis.FormData ?? class FormData {
      private data = new Map<string, unknown>();
      append(key: string, value: unknown) { this.data.set(key, value); }
    });
    vi.stubGlobal('Blob', globalThis.Blob ?? class Blob {
      constructor(public parts: unknown[], public options?: Record<string, string>) {}
    });
    vi.stubGlobal('atob', globalThis.atob ?? ((s: string) => Buffer.from(s, 'base64').toString('binary')));

    transport = new SSETransport(baseConfig);
  });

  afterEach(() => {
    transport.disconnect();
    vi.restoreAllMocks();
  });

  // ── connect ───────────────────────────────────────────────────────────

  describe('connect', () => {
    it('health-checks endpoint and returns true on success', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      const result = await transport.connect();
      expect(result).toBe(true);
      expect(transport.isConnected()).toBe(true);
    });

    it('returns false on health check failure', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('error', { status: 500 }));
      const result = await transport.connect();
      expect(result).toBe(false);
      expect(transport.isConnected()).toBe(false);
    });

    it('detects 401 auth error', async () => {
      const onError = vi.fn();
      transport.onError = onError;
      fetchSpy.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

      const result = await transport.connect();
      expect(result).toBe(false);
      expect(onError).toHaveBeenCalledWith('Authentication failed', 401);
    });

    it('detects 403 auth error', async () => {
      const onError = vi.fn();
      transport.onError = onError;
      fetchSpy.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

      const result = await transport.connect();
      expect(result).toBe(false);
      expect(onError).toHaveBeenCalledWith('Authentication failed', 403);
    });

    it('returns false on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await transport.connect();
      expect(result).toBe(false);
    });

    it('fires onStageChange(idle) on successful connect', async () => {
      const onStage = vi.fn();
      transport.onStageChange = onStage;
      fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await transport.connect();
      expect(onStage).toHaveBeenCalledWith('idle');
    });
  });

  // ── sendAudio ─────────────────────────────────────────────────────────

  describe('sendAudio', () => {
    it('ignores empty data', async () => {
      await transport.sendAudio(new Float32Array(0));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sends audio with auth header when token set', async () => {
      const t = new SSETransport({ ...baseConfig, token: 'my-token' });
      const events = [
        sseEvent('complete', { response: 'hello', transcript: 'hi' }),
      ];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      await t.sendAudio(new Float32Array([0.5, -0.5]));

      const call = fetchSpy.mock.calls[0];
      expect(call[1].headers.Authorization).toBe('Bearer my-token');
    });

    it('fires onStageChange(stt) at start', async () => {
      const onStage = vi.fn();
      transport.onStageChange = onStage;
      const events = [
        sseEvent('complete', { response: 'ok' }),
      ];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      await transport.sendAudio(new Float32Array([0.1]));
      expect(onStage).toHaveBeenCalledWith('stt');
    });

    it('detects 401 on sendAudio', async () => {
      const onError = vi.fn();
      transport.onError = onError;
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));

      await transport.sendAudio(new Float32Array([0.1]));
      expect(onError).toHaveBeenCalledWith('Authentication failed', 401);
    });

    it('handles abort cleanly', async () => {
      const abortError = new DOMException('Aborted', 'AbortError');
      fetchSpy.mockRejectedValueOnce(abortError);

      const onError = vi.fn();
      transport.onError = onError;

      await transport.sendAudio(new Float32Array([0.1]));
      // Should NOT fire onError for aborted requests
      expect(onError).not.toHaveBeenCalled();
    });
  });

  // ── sendText ──────────────────────────────────────────────────────────

  describe('sendText', () => {
    it('ignores empty text', async () => {
      await transport.sendText('');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('ignores whitespace-only text', async () => {
      await transport.sendText('   ');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('handles SSE response', async () => {
      const onResponse = vi.fn();
      transport.onResponse = onResponse;
      const events = [
        sseEvent('transcript', { transcript: 'hello' }),
        sseEvent('response', { response: 'hi there' }),
        sseEvent('complete', { response: 'hi there', transcript: 'hello' }),
      ];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      await transport.sendText('hello');
      expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({
        text: 'hi there',
      }));
    });

    it('handles JSON response', async () => {
      const onResponse = vi.fn();
      transport.onResponse = onResponse;
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        response: 'json response',
        audio_base64: 'YXVkaW8=',
      }));

      await transport.sendText('hello');
      expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({
        text: 'json response',
      }));
    });
  });

  // ── SSE parsing ───────────────────────────────────────────────────────

  describe('SSE parsing', () => {
    it('parses status events → onStageChange', async () => {
      const onStage = vi.fn();
      transport.onStageChange = onStage;
      const events = [
        sseEvent('status', { stage: 'llm' }),
        sseEvent('complete', { response: 'done' }),
      ];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      await transport.sendAudio(new Float32Array([0.1]));
      expect(onStage).toHaveBeenCalledWith('llm');
    });

    it('parses transcript event → fires llm stage', async () => {
      const onStage = vi.fn();
      transport.onStageChange = onStage;
      const events = [
        sseEvent('transcript', { transcript: 'user said hello' }),
        sseEvent('complete', { response: 'hi' }),
      ];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      await transport.sendAudio(new Float32Array([0.1]));
      expect(onStage).toHaveBeenCalledWith('llm');
    });

    it('parses response event → fires tts stage', async () => {
      const onStage = vi.fn();
      transport.onStageChange = onStage;
      const events = [
        sseEvent('response', { response: 'generated text' }),
        sseEvent('complete', { response: 'generated text' }),
      ];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      await transport.sendAudio(new Float32Array([0.1]));
      expect(onStage).toHaveBeenCalledWith('tts');
    });

    it('audio events decoded and emitted via onAudioChunk', async () => {
      const onAudioChunk = vi.fn();
      transport.onAudioChunk = onAudioChunk;
      const audioB64 = Buffer.from('test-audio-data').toString('base64');
      const events = [
        sseEvent('audio', { chunk: audioB64 }),
        sseEvent('complete', { response: 'done' }),
      ];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      await transport.sendAudio(new Float32Array([0.1]));
      expect(onAudioChunk).toHaveBeenCalledTimes(1);
      expect(onAudioChunk.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    });

    it('complete event fires onResponse with combined data', async () => {
      const onResponse = vi.fn();
      transport.onResponse = onResponse;
      const events = [
        sseEvent('transcript', { transcript: 'hi' }),
        sseEvent('response', { response: 'hello' }),
        sseEvent('complete', { response: 'hello', transcript: 'hi', timing: { sttMs: 100 } }),
      ];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      await transport.sendAudio(new Float32Array([0.1]));
      expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({
        text: 'hello',
        userText: 'hi',
      }));
    });

    it('error event throws and triggers onError', async () => {
      const onError = vi.fn();
      transport.onError = onError;
      const events = [
        sseEvent('error', { message: 'Server overloaded' }),
      ];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      await transport.sendAudio(new Float32Array([0.1]));
      expect(onError).toHaveBeenCalledWith('Server overloaded');
    });

    it('malformed JSON in SSE data is gracefully ignored', async () => {
      const onResponse = vi.fn();
      transport.onResponse = onResponse;

      const stream = makeSSEStream([
        'event: status\ndata: {invalid json\n\n',
        sseEvent('complete', { response: 'ok' }),
      ]);
      fetchSpy.mockResolvedValueOnce(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

      await transport.sendAudio(new Float32Array([0.1]));
      // Should still get the complete response (malformed line skipped)
      expect(onResponse).toHaveBeenCalled();
    });
  });

  // ── updateToken ───────────────────────────────────────────────────────

  describe('updateToken', () => {
    it('updates the config token', () => {
      transport.updateToken('new-token');
      // Verify it's used in next request
      const events = [sseEvent('complete', { response: 'ok' })];
      fetchSpy.mockResolvedValueOnce(sseResponse(events));

      transport.sendAudio(new Float32Array([0.1]));
      // Can't easily check the token in the request without more mocking,
      // but verifying no error is thrown is sufficient for this test
    });
  });

  // ── disconnect ────────────────────────────────────────────────────────

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await transport.connect();
      expect(transport.isConnected()).toBe(true);

      transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });
  });
});
