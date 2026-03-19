/**
 * WebRTC transport — lowest-latency audio via Pipecat.
 *
 * Ported from `use-webrtc-transport.ts`, removing all React dependencies.
 * Dependencies (@pipecat-ai/client-js, @pipecat-ai/small-webrtc-transport)
 * are loaded via dynamic import so this module is safe to import even when
 * the packages aren't installed.
 *
 * Supports: logging, input validation, request guards.
 */

import type { Transport, WebRTCConfig, ProcessingStage, SpeechResponse } from './types';
import { createLogger } from './logger';

export class WebRTCTransport implements Transport {
  readonly protocol = 'webrtc' as const;

  onResponse: ((r: SpeechResponse) => void) | null = null;
  onStageChange: ((stage: ProcessingStage) => void) | null = null;
  onError: ((error: string, httpStatus?: number) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onAudioChunk: ((chunk: Uint8Array) => void) | null = null;

  private client: any = null; // PipecatClient (dynamically imported)
  private remoteStream: MediaStream | null = null;
  private currentTranscript = '';
  private currentResponse = '';
  private connected = false;
  private sending = false;
  private config: WebRTCConfig;
  private log = createLogger('WebRTC');

  constructor(config: WebRTCConfig) {
    this.config = config;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  async connect(): Promise<boolean> {
    const { signalingUrl, clusterName, headIp, accessMode, backendEndpoint } = this.config;

    if (!signalingUrl || !clusterName) {
      this.log.warn('missing signalingUrl or clusterName');
      return false;
    }

    this.onStageChange?.('connecting');
    this.log.debug('connecting to', signalingUrl);

    try {
      // Dynamic import — fails gracefully if not installed
      const [{ PipecatClient, RTVIEvent }, { SmallWebRTCTransport }] = await Promise.all([
        // @ts-ignore optional peer dependency
        import(/* webpackIgnore: true */ '@pipecat-ai/client-js'),
        // @ts-ignore optional peer dependency
        import(/* webpackIgnore: true */ '@pipecat-ai/small-webrtc-transport'),
      ]) as [any, any];

      // Fetch ICE servers if backend available
      let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
      if (backendEndpoint) {
        try {
          const iceRes = await fetch(`${backendEndpoint}/api/ice-servers`, {
            signal: AbortSignal.timeout(3000),
          });
          if (iceRes.ok) {
            const iceData = await iceRes.json();
            if (iceData.iceServers?.length) iceServers = iceData.iceServers;
          }
        } catch {
          this.log.debug('ICE server fetch failed, using default STUN');
        }
      }

      const transport = new SmallWebRTCTransport({ iceServers });

      const client = new PipecatClient({
        transport,
        enableMic: true,
        enableCam: false,
        callbacks: {
          onConnected: () => {
            this.connected = true;
            this.log.info('connected');
            this.onStageChange?.('idle');
          },
          onDisconnected: () => {
            this.connected = false;
            this.remoteStream = null;
            this.log.info('disconnected');
            this.onDisconnect?.();
          },
          onTrackStarted: (track: MediaStreamTrack) => {
            if (track.kind === 'audio') {
              this.remoteStream = new MediaStream([track]);
              this.log.debug('remote audio track started');
            }
          },
          onUserTranscript: (data: { text: string }) => {
            this.currentTranscript = data.text;
            this.onStageChange?.('llm');
          },
          onBotOutput: (data: { text: string }) => {
            this.currentResponse = data.text;
            this.onResponse?.({
              text: data.text,
              audio: '', // Audio plays through WebRTC track
              visemes: [],
              duration: 0,
              userText: this.currentTranscript,
            });
            this.onStageChange?.('complete');
            this.currentTranscript = '';
            this.currentResponse = '';
            this.sending = false;
          },
          onBotStartedSpeaking: () => {
            this.onStageChange?.('tts');
          },
        },
      });

      // Handle server messages (status updates via DataChannel)
      client.on(RTVIEvent.ServerMessage, (message: unknown) => {
        try {
          const msg = typeof message === 'string' ? JSON.parse(message) : message;

          if (msg.status === 'processing') {
            this.onStageChange?.(msg.stage as ProcessingStage);
            if (msg.transcript) this.currentTranscript = msg.transcript;
            if (msg.response) this.currentResponse = msg.response;
          }

          if (msg.status === 'complete') {
            this.onResponse?.({
              text: msg.response || this.currentResponse || '',
              audio: '',
              visemes: [],
              duration: 0,
              userText: msg.transcript || this.currentTranscript || '',
              timing: msg.timing,
            });
            this.onStageChange?.('complete');
            this.currentTranscript = '';
            this.currentResponse = '';
            this.sending = false;
          }

          if (msg.status === 'error') {
            this.log.error('server error:', msg.message);
            this.onError?.(msg.message || 'WebRTC error');
            this.onStageChange?.('idle');
            this.sending = false;
          }
        } catch { /* ignore parse errors */ }
      });

      client.on(RTVIEvent.Error, (error: unknown) => {
        this.log.error('RTVIEvent.Error:', error);
        this.onError?.(error instanceof Error ? error.message : 'WebRTC connection error');
      });

      this.client = client;

      await client.connect({
        webrtcRequestParams: {
          endpoint: signalingUrl,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          requestData: {
            cluster_name: clusterName,
            head_ip: headIp,
            access_mode: accessMode,
          },
        },
      });

      return true;
    } catch (err) {
      this.log.warn('connection failed:', err);
      this.disconnect();
      return false;
    }
  }

  disconnect(): void {
    if (this.client) {
      this.log.debug('disconnecting');
      this.client.disconnect().catch(() => {});
      this.client = null;
    }
    this.remoteStream = null;
    this.connected = false;
    this.sending = false;
  }

  async sendAudio(_data: Float32Array): Promise<void> {
    // Pipecat streams mic audio automatically via WebRTC media track.
    // Server-side Silero VAD detects speech and triggers the pipeline.
    this.sending = true;
  }

  async sendText(text: string): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('WebRTC not connected');
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
    this.onStageChange?.('tts');
    this.log.debug('sending text:', trimmed.slice(0, 50));
    this.client.sendClientMessage('tts', { text: trimmed });
  }
}
