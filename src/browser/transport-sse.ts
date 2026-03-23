/**
 * SSE transport — stateless HTTP POST with Server-Sent Events streaming.
 *
 * Ported from `use-sse-transport.ts`, removing all React dependencies.
 * Supports: logging, input validation, auth error detection (401),
 * streaming audio chunks, and request guards.
 */

import type { Transport, SSEConfig, ProcessingStage, SpeechResponse, TimingInfo } from './types';
import { float32ToWavBuffer, combineWavChunksToBase64 } from './audio';
import { createLogger } from './logger';

const DEFAULT_HEALTH_TIMEOUT = 15_000;

export class SSETransport implements Transport {
  readonly protocol = 'sse' as const;

  onResponse: ((r: SpeechResponse) => void) | null = null;
  onStageChange: ((stage: ProcessingStage) => void) | null = null;
  onError: ((error: string, httpStatus?: number) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onAudioChunk: ((chunk: Uint8Array) => void) | null = null;

  private abortController: AbortController | null = null;
  private connected = false;
  private sending = false;
  private config: SSEConfig;
  private log = createLogger('SSE');

  constructor(config: SSEConfig) {
    this.config = config;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * For SSE, "connect" means health-checking the endpoint.
   */
  async connect(): Promise<boolean> {
    const { endpoint, healthCheckTimeoutMs = DEFAULT_HEALTH_TIMEOUT, healthPath = '/health' } = this.config;
    const healthUrl = healthPath.startsWith('http') ? healthPath : `${endpoint}${healthPath}`;
    this.log.debug('health check', healthUrl);

    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(healthCheckTimeoutMs),
        credentials: 'include', // Send auth cookies (required for /api/speech/health)
      });

      if (res.status === 401 || res.status === 403) {
        this.log.warn('auth error on health check, status:', res.status);
        this.onError?.('Authentication failed', res.status);
        return false;
      }

      if (res.ok) {
        this.connected = true;
        this.log.info('connected (health OK)');
        this.onStageChange?.('idle');
        return true;
      }

      this.log.warn('health check failed, status:', res.status);
      return false;
    } catch (err) {
      this.log.error('health check error:', err);
      return false;
    }
  }

  disconnect(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.connected = false;
    this.sending = false;
    this.log.debug('disconnected');
  }

  async sendAudio(data: Float32Array): Promise<void> {
    const { endpoint, token, audioPath = '/api/stream-audio', systemPrompt, history, language } = this.config;

    if (data.length === 0) {
      this.log.warn('sendAudio called with empty audio, ignoring');
      return;
    }
    if (this.sending) {
      this.log.warn('sendAudio called while already sending, ignoring');
      return;
    }

    if (this.abortController) this.abortController.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.sending = true;

    this.onStageChange?.('stt');

    try {
      const wavBuffer = float32ToWavBuffer(data);
      const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });

      const formData = new FormData();
      formData.append('audio', wavBlob, 'recording.wav');
      if (systemPrompt) formData.append('system_prompt', systemPrompt);
      if (history && history.length > 0) formData.append('history', JSON.stringify(history));
      if (language) formData.append('language', language);

      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const url = audioPath.startsWith('http') ? audioPath : `${endpoint}${audioPath}`;
      this.log.debug('POST', audioPath, data.length, 'samples', language ? `lang=${language}` : '');
      const res = await fetch(url, {
        method: 'POST',
        body: formData,
        headers,
        signal: abortController.signal,
      });

      if (res.status === 401 || res.status === 403) {
        this.sending = false;
        this.onError?.('Authentication failed', res.status);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      if (!res.body) throw new Error('No response body (SSE stream expected)');

      await this.parseSSEStream(res.body);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.sending = false;
        return;
      }
      this.log.error('sendAudio error:', err);
      this.onError?.(err instanceof Error ? err.message : 'Unknown error');
      this.onStageChange?.('idle');
    } finally {
      this.sending = false;
    }
  }

  async sendText(text: string): Promise<void> {
    const { endpoint, token, audioPath = '/api/stream-audio', systemPrompt, history } = this.config;

    const trimmed = text.trim();
    if (!trimmed) {
      this.log.warn('sendText called with empty text, ignoring');
      return;
    }
    if (this.sending) {
      this.log.warn('sendText called while already sending, ignoring');
      return;
    }

    if (this.abortController) this.abortController.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.sending = true;

    this.onStageChange?.('tts');

    try {
      // Send text as FormData (same endpoint as audio, with 'text' field instead of 'audio')
      const formData = new FormData();
      formData.append('text', trimmed);
      if (systemPrompt) formData.append('system_prompt', systemPrompt);
      if (history && history.length > 0) formData.append('history', JSON.stringify(history));

      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const url = audioPath.startsWith('http') ? audioPath : `${endpoint}${audioPath}`;
      this.log.debug('POST', audioPath, '(text)');
      const res = await fetch(url, {
        method: 'POST',
        body: formData,
        headers,
        signal: abortController.signal,
      });

      if (res.status === 401 || res.status === 403) {
        this.sending = false;
        this.onError?.('Authentication failed', res.status);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      if (res.body && res.headers.get('content-type')?.includes('text/event-stream')) {
        // SSE response (backend pipeline)
        await this.parseSSEStream(res.body);
      } else {
        // JSON response (direct GPU /api/text)
        const data = await res.json();
        this.onResponse?.({
          text: data.response || trimmed,
          audio: data.audio_base64 || '',
          visemes: [],
          duration: 0,
          userText: '',
          timing: data.timing,
        });
        this.onStageChange?.('complete');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.sending = false;
        return;
      }
      this.log.error('sendText error:', err);
      this.onError?.(err instanceof Error ? err.message : 'Unknown error');
      this.onStageChange?.('idle');
    } finally {
      this.sending = false;
    }
  }

  /** Update the auth token (used after token refresh). */
  updateToken(token: string): void {
    this.config = { ...this.config, token };
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async parseSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const audioChunks: Uint8Array[] = [];
    const state = { responseText: '', transcript: '', timing: null as TimingInfo | null };

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const eventBlock of events) {
        if (!eventBlock.trim()) continue;

        const lines = eventBlock.split('\n');
        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          else if (line.startsWith('data: ')) eventData = line.slice(6);
        }

        if (!eventType || !eventData) continue;

        try {
          const data = JSON.parse(eventData);

          switch (eventType) {
            case 'status':
              this.onStageChange?.(data.stage as ProcessingStage);
              break;

            case 'transcript':
              state.transcript = data.transcript;
              this.onStageChange?.('llm');
              break;

            case 'response':
              state.responseText = data.response;
              this.onStageChange?.('tts');
              break;

            case 'audio': {
              const binaryStr = atob(data.chunk);
              const bytes = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
              }
              audioChunks.push(bytes);
              // Emit streaming audio chunk
              this.onAudioChunk?.(bytes);
              break;
            }

            case 'complete':
              state.responseText = data.response || state.responseText;
              state.transcript = data.transcript || state.transcript;
              state.timing = data.timing || null;
              break;

            case 'error':
              throw new Error(data.message || 'Server error');
          }
        } catch (parseErr: unknown) {
          // Re-throw server errors (from 'error' event case above).
          // Only swallow JSON parse failures for malformed SSE data.
          if (parseErr instanceof SyntaxError) continue;
          throw parseErr;
        }
      }
    }

    const audioBase64 = combineWavChunksToBase64(audioChunks);

    this.onResponse?.({
      text: state.responseText,
      audio: audioBase64,
      visemes: [],
      duration: 0,
      userText: state.transcript,
      timing: state.timing || undefined,
    });

    this.onStageChange?.('complete');
  }
}
