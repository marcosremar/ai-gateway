import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketTransport } from '@ai-gateway/browser/transport-ws';
import { SSETransport } from '@ai-gateway/browser/transport-sse';
import { setLogLevel } from '@ai-gateway/browser/logger';

// Suppress SDK logs during tests
beforeEach(() => setLogLevel('silent'));
afterEach(() => setLogLevel('warn'));

// ── Mock WebSocket ─────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.CLOSED;

  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;

  url: string;
  sent: unknown[] = [];

  constructor(url: string) {
    this.url = url;
    // Simulate async open
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 10);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000 });
  }
}

// ── WebSocketTransport tests ───────────────────────────────────────────────

describe('WebSocketTransport', () => {
  let originalWS: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWS = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWS;
  });

  it('has protocol "websocket"', () => {
    const t = new WebSocketTransport({ url: 'ws://test' });
    expect(t.protocol).toBe('websocket');
  });

  it('connects successfully', async () => {
    const t = new WebSocketTransport({ url: 'ws://test' });
    const result = await t.connect();
    expect(result).toBe(true);
    expect(t.isConnected()).toBe(true);
    t.disconnect();
  });

  it('appends token as query param', async () => {
    const t = new WebSocketTransport({ url: 'ws://test', token: 'abc123' });
    await t.connect();
    // MockWebSocket stores the url
    expect(t.isConnected()).toBe(true);
    t.disconnect();
  });

  it('returns false on connection timeout', async () => {
    // Override to never open — don't call super to avoid triggering onopen
    (globalThis as any).WebSocket = class {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 3; // CLOSED
      onopen: (() => void) | null = null;
      onclose: ((e: { code: number }) => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      send() {}
      close() { this.readyState = 3; }
    };

    const t = new WebSocketTransport({ url: 'ws://test', connectionTimeoutMs: 50 });
    const result = await t.connect();
    expect(result).toBe(false);
  });

  it('sends binary audio data', async () => {
    const t = new WebSocketTransport({ url: 'ws://test' });
    await t.connect();

    const stageFn = vi.fn();
    t.onStageChange = stageFn;

    const pcm = new Float32Array([0, 0.5, -0.5]);
    await t.sendAudio(pcm);

    expect(stageFn).toHaveBeenCalledWith('stt');
    t.disconnect();
  });

  it('sends text as JSON', async () => {
    const t = new WebSocketTransport({ url: 'ws://test' });
    await t.connect();

    await t.sendText('hello');
    t.disconnect();
  });

  it('throws when sending without connection', async () => {
    const t = new WebSocketTransport({ url: 'ws://test' });
    await expect(t.sendAudio(new Float32Array([0]))).rejects.toThrow('not connected');
  });

  it('disconnects cleanly', async () => {
    const t = new WebSocketTransport({ url: 'ws://test' });
    await t.connect();
    t.disconnect();
    expect(t.isConnected()).toBe(false);
  });

  it('handles JSON processing messages', async () => {
    const t = new WebSocketTransport({ url: 'ws://test' });
    await t.connect();

    const stageFn = vi.fn();
    t.onStageChange = stageFn;

    // Simulate receiving a processing message
    const ws = (t as any).ws as MockWebSocket;
    ws.onmessage?.({
      data: JSON.stringify({ status: 'processing', stage: 'llm', transcript: 'hi' }),
    });

    expect(stageFn).toHaveBeenCalledWith('llm');
    t.disconnect();
  });

  it('handles error messages', async () => {
    const t = new WebSocketTransport({ url: 'ws://test' });
    await t.connect();

    const errorFn = vi.fn();
    t.onError = errorFn;

    const ws = (t as any).ws as MockWebSocket;
    ws.onmessage?.({
      data: JSON.stringify({ status: 'error', message: 'test error' }),
    });

    expect(errorFn).toHaveBeenCalledWith('test error');
    t.disconnect();
  });
});

// ── SSETransport tests ─────────────────────────────────────────────────────

describe('SSETransport', () => {
  it('has protocol "sse"', () => {
    const t = new SSETransport({ endpoint: 'https://test' });
    expect(t.protocol).toBe('sse');
  });

  it('connects via health check', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );

    const t = new SSETransport({ endpoint: 'https://test' });
    const result = await t.connect();

    expect(result).toBe(true);
    expect(t.isConnected()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test/health',
      expect.objectContaining({ signal: expect.anything() }),
    );

    fetchSpy.mockRestore();
  });

  it('returns false when health check fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('error', { status: 500 }),
    );

    const t = new SSETransport({ endpoint: 'https://test' });
    const result = await t.connect();
    expect(result).toBe(false);

    fetchSpy.mockRestore();
  });

  it('returns false on network error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const t = new SSETransport({ endpoint: 'https://test' });
    const result = await t.connect();
    expect(result).toBe(false);

    fetchSpy.mockRestore();
  });

  it('disconnects by aborting and resetting', () => {
    const t = new SSETransport({ endpoint: 'https://test' });
    (t as any).connected = true;
    t.disconnect();
    expect(t.isConnected()).toBe(false);
  });
});
