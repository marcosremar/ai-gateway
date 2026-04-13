/**
 * WebSocket transport — persistent binary audio streaming.
 *
 * Ported from `use-ws-transport.ts`, removing all React dependencies.
 * Supports: logging, typed errors, input validation, auth error detection,
 * streaming audio chunks, and request guards.
 */

import type { Transport, WebSocketConfig, ProcessingStage, SpeechResponse } from './types';
import { float32ToWavBuffer, combineWavChunksToBase64 } from './audio';
import { createLogger } from './logger';

const DEFAULT_PING_INTERVAL = 25_000;
const DEFAULT_CONNECTION_TIMEOUT = 10_000;

export class WebSocketTransport implements Transport {
  readonly protocol = 'websocket' as const;

  onResponse: ((r: SpeechResponse) => void) | null = null;
  onStageChange: ((stage: ProcessingStage) => void) | null = null;
  onError: ((error: string, httpStatus?: number) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onAudioChunk: ((chunk: Uint8Array) => void) | null = null;

  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private audioChunks: Blob[] = [];
  private currentTranscript = '';
  private currentResponse = '';
  private config: WebSocketConfig;
  private sending = false;
  private log = createLogger('WS');

  constructor(config: WebSocketConfig) {
    this.config = config;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<boolean> {
    if (this.isConnected()) return true;

    const { url, token, connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT } = this.config;

    const tokenParam = token
      ? (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`
      : '';

    this.log.debug('connecting to', url);

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.log.warn('connection timeout after', connectionTimeoutMs, 'ms');
        this.cleanupSocket();
        resolve(false);
      }, connectionTimeoutMs);

      const ws = new WebSocket(url + tokenParam);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.log.info('connected');
        this.startPing(ws);
        // Send config message with system prompt if provided
        if (this.config.systemPrompt) {
          ws.send(JSON.stringify({ type: 'config', systemPrompt: this.config.systemPrompt }));
        }
        this.onStageChange?.('idle');
        resolve(true);
      };

      ws.onmessage = (event) => this.handleMessage(event);

      ws.onerror = () => {
        clearTimeout(timeout);
        this.log.error('connection error');
        this.onError?.('WebSocket connection error');
        resolve(false);
      };

      ws.onclose = (event) => {
        clearTimeout(timeout);
        this.stopPing();
        this.ws = null;
        this.sending = false;
        this.log.debug('closed, code:', event.code);
        if (event.code !== 1000) {
          this.onDisconnect?.();
        }
      };

      this.ws = ws;
    });
  }

  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      this.log.debug('disconnecting');
      this.ws.close(1000, 'User disconnected');
      this.ws = null;
    }
    this.sending = false;
  }

  async sendAudio(data: Float32Array): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('WebSocket not connected');
    }
    if (data.length === 0) {
      this.log.warn('sendAudio called with empty audio, ignoring');
      return;
    }
    if (this.sending) {
      this.log.warn('sendAudio called while already sending, ignoring');
      return;
    }

    this.sending = true;
    this.onStageChange?.('stt');
    this.audioChunks = [];
    this.currentTranscript = '';
    this.currentResponse = '';

    this.log.debug('sending audio,', data.length, 'samples');
    const wavBuffer = float32ToWavBuffer(data);
    this.ws?.send(wavBuffer);
  }

  async sendText(text: string): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('WebSocket not connected');
    }
    const trimmed = text.trim();
    if (!trimmed) {
      this.log.warn('sendText called with empty text, ignoring');
      return;
    }
    if (this.sending) {
      this.log.warn('sendText called while already sending, ignoring');
      return;
    }

    this.sending = true;
    this.onStageChange?.('llm');
    this.audioChunks = [];
    this.currentResponse = '';

    this.log.debug('sending text:', trimmed.slice(0, 50));
    this.ws?.send(JSON.stringify({ type: 'text', text: trimmed }));
  }

  /** Update the auth token (used after token refresh). */
  updateToken(token: string): void {
    this.config = { ...this.config, token };
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async handleMessage(event: MessageEvent): Promise<void> {
    if (event.data instanceof Blob) {
      this.audioChunks.push(event.data);
      // Emit streaming audio chunk
      try {
        const ab = await event.data.arrayBuffer();
        this.onAudioChunk?.(new Uint8Array(ab));
      } catch { /* ignore chunk read errors */ }
      return;
    }

    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'pong') return;

      if (msg.status === 'processing') {
        this.onStageChange?.(msg.stage as ProcessingStage);
        if (msg.transcript) this.currentTranscript = msg.transcript;
        if (msg.response) this.currentResponse = msg.response;
      }

      if (msg.status === 'complete') {
        const uint8Chunks: Uint8Array[] = [];
        for (const blob of this.audioChunks) {
          const ab = await blob.arrayBuffer();
          uint8Chunks.push(new Uint8Array(ab));
        }
        const audioBase64 = combineWavChunksToBase64(uint8Chunks);

        this.onResponse?.({
          text: msg.response || this.currentResponse || '',
          audio: audioBase64,
          visemes: [],
          duration: 0,
          userText: msg.transcript || this.currentTranscript || '',
          timing: msg.timing,
        });

        this.onStageChange?.('complete');
        this.audioChunks = [];
        this.currentTranscript = '';
        this.currentResponse = '';
        this.sending = false;
      }

      if (msg.status === 'error') {
        this.log.error('server error:', msg.message);
        this.onError?.(msg.message || 'Unknown error');
        this.onStageChange?.('idle');
        this.sending = false;
      }
    } catch {
      // Ignore JSON parse errors for non-JSON messages
    }
  }

  private startPing(ws: WebSocket): void {
    const interval = this.config.pingIntervalMs ?? DEFAULT_PING_INTERVAL;
    this.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, interval);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private cleanupSocket(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.sending = false;
  }
}
