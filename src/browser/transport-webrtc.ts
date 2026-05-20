/**
 * WebRTC transport — lowest-latency audio via Pipecat or aiortc.
 *
 * Two modes:
 *   1. **Pipecat** (existing): uses @pipecat-ai/client-js + SmallWebRTCTransport.
 *      Auto-selected when `config.clusterName` is set.
 *   2. **aiortc simple** (new): plain browser RTCPeerConnection with SDP exchange
 *      via POST to signalingUrl (/api/offer). No Pipecat dependency.
 *      Auto-selected when `config.clusterName` is NOT set.
 *
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

  private client: { disconnect(): Promise<void>; sendClientMessage(topic: string, payload: Record<string, unknown>): void } | null = null;
  private pc: RTCPeerConnection | null = null; // aiortc simple mode
  private dataChannel: RTCDataChannel | null = null; // aiortc simple mode
  private remoteStream: MediaStream | null = null;
  private localStream: MediaStream | null = null;
  private currentTranscript = '';
  private currentResponse = '';
  private connected = false;
  private sending = false;
  private config: WebRTCConfig;
  private log = createLogger('WebRTC');
  private mode: 'pipecat' | 'aiortc' = 'pipecat';

  constructor(config: WebRTCConfig) {
    this.config = config;
    // Auto-detect mode: clusterName present → Pipecat, otherwise → aiortc simple
    this.mode = config.clusterName ? 'pipecat' : 'aiortc';
  }

  isConnected(): boolean {
    return this.connected;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  async connect(): Promise<boolean> {
    if (this.mode === 'aiortc') {
      return this.connectAiortc();
    }
    return this.connectPipecat();
  }

  // ── aiortc simple mode ────────────────────────────────────────────────────

  private async connectAiortc(): Promise<boolean> {
    const { signalingUrl } = this.config;

    if (!signalingUrl) {
      this.log.warn('missing signalingUrl for aiortc mode');
      return false;
    }

    this.onStageChange?.('connecting');
    this.log.debug('connecting (aiortc) to', signalingUrl);

    try {
      const stunServer = process.env.STUN_SERVER || 'stun:stun.l.google.com:19302';
      const iceServers: RTCIceServer[] = [{ urls: stunServer }];
      const pc = new RTCPeerConnection({ iceServers });
      this.pc = pc;

      // Create DataChannel for receiving JSON events from the server
      const dc = pc.createDataChannel('events');
      this.dataChannel = dc;

      dc.onopen = () => {
        this.log.debug('DataChannel "events" opened');
      };

      dc.onmessage = (event: MessageEvent) => {
        this.handleServerMessage(event.data);
      };

      dc.onclose = () => {
        this.log.debug('DataChannel "events" closed');
      };

      // Handle remote audio track from server (TTS output)
      pc.ontrack = (event: RTCTrackEvent) => {
        if (event.track.kind === 'audio') {
          this.remoteStream = new MediaStream([event.track]);
          this.log.debug('remote audio track received');
        }
      };

      // Handle ICE connection state changes
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        this.log.debug('connection state:', state);
        if (state === 'connected') {
          this.connected = true;
          this.onStageChange?.('idle');
          this.log.info('connected (aiortc)');
        } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
          this.connected = false;
          this.remoteStream = null;
          this.log.info('disconnected (aiortc):', state);
          this.onDisconnect?.();
        }
      };

      // Get user media (microphone) and add audio track to the connection.
      // Optional client-side noise suppression: wraps the stream before track
      // addition so the peer never sees the noisy original.
      let stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const nsMode = this.config.noiseSuppressionMode;
      if (nsMode && nsMode !== 'none') {
        try {
          const { createNoiseSuppressor } = await import('./noise-suppression');
          const suppressor = await createNoiseSuppressor({ mode: nsMode });
          stream = await suppressor.process(stream);
          this.log.info(`noise suppression: ${nsMode}`);
        } catch (err) {
          this.log.warn('noise suppression failed, using raw stream:', (err as Error).message);
        }
      }
      this.localStream = stream;
      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }

      // Create SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete (or timeout after 3s)
      await this.waitForIceGathering(pc, 3000);

      // POST the offer to the signaling endpoint
      const res = await fetch(signalingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: pc.localDescription!.sdp,
          type: pc.localDescription!.type,
          source: this.config.sourceLanguage || 'fr',
          target: this.config.targetLanguage || 'en',
          speaker: this.config.speaker || 'Ryan',
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Signaling failed (${res.status}): ${errBody}`);
      }

      const answer = await res.json();
      await pc.setRemoteDescription(new RTCSessionDescription(answer));

      this.log.info('SDP exchange complete');
      return true;
    } catch (err) {
      this.log.warn('aiortc connection failed:', err);
      this.disconnect();
      return false;
    }
  }

  /** Wait for ICE gathering to finish, with a timeout. */
  private waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  /** Handle JSON messages from the server DataChannel (shared by both modes). */
  private handleServerMessage(raw: string): void {
    try {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;

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
  }

  // ── Pipecat mode (existing) ───────────────────────────────────────────────

  private async connectPipecat(): Promise<boolean> {
    const { signalingUrl, clusterName, headIp, accessMode, backendEndpoint } = this.config;

    if (!signalingUrl || !clusterName) {
      this.log.warn('missing signalingUrl or clusterName');
      return false;
    }

    this.onStageChange?.('connecting');
    this.log.debug('connecting (pipecat) to', signalingUrl);

    try {
      // Dynamic import — fails gracefully if not installed
      const [{ PipecatClient, RTVIEvent }, { SmallWebRTCTransport }] = await Promise.all([
        // @ts-ignore optional peer dependency
        import(/* webpackIgnore: true */ '@pipecat-ai/client-js'),
        // @ts-ignore optional peer dependency
        import(/* webpackIgnore: true */ '@pipecat-ai/small-webrtc-transport'),
      ]) as [any, any];

      // Fetch ICE servers if backend available
      const stunUrl = process.env.STUN_SERVER || 'stun:stun.l.google.com:19302';
      let iceServers: RTCIceServer[] = [{ urls: stunUrl }];
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
        const raw = typeof message === 'string' ? message : JSON.stringify(message);
        this.handleServerMessage(raw);
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
    // Pipecat mode cleanup
    if (this.client) {
      this.log.debug('disconnecting (pipecat)');
      this.client.disconnect().catch((e: unknown) => console.warn('[webrtc] disconnect failed:', e instanceof Error ? e.message : e));
      this.client = null;
    }

    // aiortc mode cleanup
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }
    if (this.pc) {
      this.log.debug('disconnecting (aiortc)');
      this.pc.close();
      this.pc = null;
    }

    this.remoteStream = null;
    this.connected = false;
    this.sending = false;
  }

  async sendAudio(_data: Float32Array): Promise<void> {
    // Both modes stream mic audio automatically via the WebRTC media track.
    // Server-side VAD detects speech and triggers the pipeline.
    this.sending = true;
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      this.log.warn('sendText called with empty text, ignoring');
      return;
    }
    if (this.sending) {
      this.log.warn('sendText called while already sending, ignoring');
      return;
    }

    if (this.mode === 'aiortc') {
      // aiortc mode: send text via DataChannel
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        throw new Error('WebRTC DataChannel not open');
      }
      this.sending = true;
      this.onStageChange?.('tts');
      this.log.debug('sending text (aiortc):', trimmed.slice(0, 50));
      this.dataChannel.send(JSON.stringify({ type: 'tts', text: trimmed }));
    } else {
      // Pipecat mode
      if (!this.client || !this.connected) {
        throw new Error('WebRTC not connected');
      }
      this.sending = true;
      this.onStageChange?.('tts');
      this.log.debug('sending text (pipecat):', trimmed.slice(0, 50));
      this.client.sendClientMessage('tts', { text: trimmed });
    }
  }
}
