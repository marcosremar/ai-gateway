/**
 * OpenAIRealtimeClient — Browser-side WebRTC client for OpenAI Realtime API.
 *
 * Framework-agnostic class that manages the full WebRTC lifecycle:
 * - SDP negotiation via /api/ai-providers/realtime/calls
 * - DataChannel event processing (session, transcripts, responses)
 * - Network quality monitoring via RTCStats
 * - Auto-reconnect on ICE failure
 *
 * Usage:
 *   const client = new OpenAIRealtimeClient({ model: 'gpt-4o-mini-realtime-preview' });
 *   client.on('response', (r) => console.log(r.text));
 *   client.on('audio-stream', (stream) => audioEl.srcObject = stream);
 *   await client.connect();
 */

import { TypedEmitter } from './emitter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Network quality metrics from RTCStats. */
export interface NetworkQuality {
  /** Round-trip time in milliseconds */
  rttMs: number;
  /** Packet loss percentage (0-100) */
  packetLossPercent: number;
  /** Jitter in milliseconds */
  jitterMs: number;
  /** Quality assessment */
  quality: 'excellent' | 'good' | 'fair' | 'poor';
  /** Timestamp of last measurement */
  timestamp: number;
}

/** Current phase of the WebRTC connection process. */
export type ConnectionPhase =
  | 'idle'
  | 'requesting-mic'
  | 'creating-offer'
  | 'sending-sdp'
  | 'waiting-dc'
  | 'connected'
  | 'reconnecting'
  | 'failed';

/** Options for constructing an OpenAIRealtimeClient. */
export interface OpenAIRealtimeOptions {
  /** OpenAI Realtime model ID. Default: 'gpt-4o-mini-realtime-preview'. */
  model?: string;
  /** TTS voice. Default: 'ash'. */
  voice?: string;
  /** System instructions for the session. */
  instructions?: string;
  /** Student name for personalized default instructions. */
  studentName?: string;
  /** Target language ISO code (e.g. 'en', 'pt'). Default: 'en'. */
  language?: string;
  /** User's native language ISO code. */
  nativeLanguage?: string;
  /** User's birth date (ISO string). */
  birthDate?: string | null;
  /**
   * Backend endpoint for SDP exchange.
   * Default: '/api/ai-providers/realtime/calls'.
   */
  sdpEndpoint?: string;
  /** Connection timeout in ms. Default: 15000. */
  connectionTimeoutMs?: number;
  /** Maximum ICE failure reconnect attempts. Default: 3. */
  maxReconnectAttempts?: number;
  /** Called when network quality changes. */
  onNetworkQualityChange?: (quality: NetworkQuality) => void;
}

/** A complete response turn from the model. */
export interface OpenAIRealtimeResponse {
  /** Bot's text (audio transcript or text output). */
  text: string;
  /** User's speech transcript (from input_audio_transcription). */
  userText: string;
  /** Visemes — empty for WebRTC (audio plays via track). */
  visemes: Array<{ start: number; end: number; value: string }>;
  /** Audio duration — 0 for WebRTC. */
  duration: number;
}

/** Event map for OpenAIRealtimeClient. */
export interface OpenAIRealtimeEventMap {
  /** WebRTC + DataChannel fully connected. */
  connected: void;
  /** Connection closed (user-initiated or unexpected). */
  disconnected: void;
  /** A non-fatal or fatal error occurred. */
  error: { message: string };
  /** A complete response from the model. */
  response: OpenAIRealtimeResponse;
  /** Model started speaking (audio track active). */
  'speaking-start': void;
  /** Model stopped speaking. */
  'speaking-end': void;
  /** Live audio transcript delta (for subtitles). */
  transcript: { delta: string; full: string };
  /** Network quality update. */
  'network-quality': NetworkQuality;
  /** Remote audio stream (for lip-sync). */
  'audio-stream': MediaStream | null;
  /** Connection phase changed (for debugging). */
  'status-change': { phase: ConnectionPhase };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'gpt-4o-mini-realtime-preview';
const DEFAULT_VOICE = 'ash';
const DEFAULT_SDP_ENDPOINT = '/api/ai-providers/realtime/calls';
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 2_000;
const STATS_POLL_INTERVAL_MS = 5_000;
const MAX_TRANSCRIPT_LENGTH = 10_000;
const MAX_RESPONSE_LENGTH = 50_000;

// ---------------------------------------------------------------------------
// Instruction builder (standalone — no framework/app dependencies)
// ---------------------------------------------------------------------------

function buildDefaultInstructions(opts: {
  studentName?: string;
  language?: string;
  nativeLanguage?: string;
  birthDate?: string | null;
}): string {
  const { studentName = 'Student', language = 'en', nativeLanguage, birthDate } = opts;

  const langNames: Record<string, string> = {
    pt: 'Portuguese (Brazilian)',
    en: 'English',
    fr: 'French',
    es: 'Spanish',
    de: 'German',
    it: 'Italian',
  };
  const langNamesMap: Record<string, string> = {
    pt: 'Portuguese', en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian',
  };
  const langName = langNames[language] || language;

  let prompt = `You are a friendly ${langName} conversation partner named Lauren. You are having a natural voice conversation with ${studentName}.

Rules:
- ALWAYS respond in ${langName}, no matter what language ${studentName} speaks
- Speak in ${langName} at a natural, comfortable pace
- Keep responses short and conversational (2-3 sentences max)
- Gently correct pronunciation or grammar mistakes when they happen
- Ask follow-up questions to keep the conversation going
- Be encouraging, warm and patient
- If ${studentName} speaks in another language, gently guide them back to ${langName} (but still respond in ${langName})
- Never call ${studentName} "student", "aluno", or "professor" — just use their name or speak naturally`;

  const profileParts: string[] = [];
  if (nativeLanguage) {
    const nativeName = langNamesMap[nativeLanguage] || nativeLanguage;
    profileParts.push(`${studentName}'s native language is ${nativeName}. Use this to anticipate typical errors. NEVER switch to ${nativeName} or provide translations — respond EXCLUSIVELY in the target language.`);
  }
  if (birthDate) {
    const age = Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    if (age > 0 && age < 150) {
      profileParts.push(`${studentName} is ${age} years old. Adapt vocabulary and topics to be age-appropriate.`);
    }
  }
  if (profileParts.length > 0) {
    prompt += `\n\n${profileParts.join('\n')}`;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class OpenAIRealtimeClient extends TypedEmitter<OpenAIRealtimeEventMap> {
  // Configuration
  private readonly _model: string;
  private readonly _voice: string;
  private readonly _sdpEndpoint: string;
  private readonly _connectionTimeoutMs: number;
  private readonly _maxReconnectAttempts: number;
  private readonly _options: OpenAIRealtimeOptions;

  // Connection state
  private _phase: ConnectionPhase = 'idle';
  private _isConnected = false;
  private _isConnecting = false;
  private _reconnectAttempt = 0;
  private _error: string | null = null;

  // WebRTC resources
  private _pc: RTCPeerConnection | null = null;
  private _dc: RTCDataChannel | null = null;
  private _audioEl: HTMLAudioElement | null = null;
  private _micStream: MediaStream | null = null;

  // Timers
  private _connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private _reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private _statsIntervalId: ReturnType<typeof setInterval> | null = null;

  // Accumulation state
  private _pendingUserTranscript = '';
  private _pendingResponseText = '';
  private _pendingAudioTranscript = '';
  private _didConnect = false;

  constructor(options: OpenAIRealtimeOptions = {}) {
    super();
    this._options = options;
    this._model = options.model ?? DEFAULT_MODEL;
    this._voice = options.voice ?? DEFAULT_VOICE;
    this._sdpEndpoint = options.sdpEndpoint ?? DEFAULT_SDP_ENDPOINT;
    this._connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this._maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Whether the connection is fully established. */
  get isConnected(): boolean { return this._isConnected; }

  /** Whether a connection attempt is in progress. */
  get isConnecting(): boolean { return this._isConnecting; }

  /** Current connection phase. */
  get phase(): ConnectionPhase { return this._phase; }

  /** Last error message, if any. */
  get error(): string | null { return this._error; }

  /**
   * Connect to OpenAI Realtime via WebRTC.
   * Resolves when the DataChannel opens (or rejects on timeout/error).
   */
  async connect(): Promise<void> {
    if (this._isConnecting || this._isConnected) {
      return;
    }
    this._isConnecting = true;
    this._reconnectAttempt = 0;
    this._setPhase('requesting-mic');
    await this._connectInternal();
  }

  /** Disconnect and release all resources. */
  disconnect(): void {
    this._cleanup();
    this._isConnected = false;
    this._isConnecting = false;
    this._setPhase('idle');
    this.emit('disconnected', undefined);
  }

  /**
   * Send a text message. Creates a conversation item and triggers a response.
   * Only valid when the DataChannel is open.
   */
  sendText(text: string): void {
    if (!this._dc || this._dc.readyState !== 'open') {
      console.warn('[OpenAIRealtimeClient] Data channel not open, cannot send text');
      return;
    }

    const createEvent = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    };
    this._dc.send(JSON.stringify(createEvent));
    this._dc.send(JSON.stringify({ type: 'response.create' }));
  }

  /** Reset accumulation state (clears pending transcript/response buffers). */
  reset(): void {
    this._pendingUserTranscript = '';
    this._pendingResponseText = '';
    this._pendingAudioTranscript = '';
    this._error = null;
  }

  // ---------------------------------------------------------------------------
  // Internal — WebRTC setup
  // ---------------------------------------------------------------------------

  private async _connectInternal(): Promise<void> {
    if (this._pc) {
      return; // Already have a peer connection
    }

    this._didConnect = false;

    try {
      // 1. Create RTCPeerConnection
      const pc = new RTCPeerConnection();
      this._pc = pc;

      // 2. Set up remote audio playback
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      this._audioEl = audioEl;

      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
        this.emit('audio-stream', e.streams[0]);
      };

      // 3. Acquire microphone
      this._setPhase('requesting-mic');

      let micStream: MediaStream;
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Microphone not available (requires HTTPS or localhost)');
        }
        // Wrap in a 4s timeout — headless/sandboxed browsers may hang indefinitely
        // instead of immediately rejecting with NotAllowedError.
        micStream = await Promise.race([
          navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              autoGainControl: true,
              noiseSuppression: true,
            },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Microphone request timed out')), 3_000)
          ),
        ]);
      } catch (micErr) {
        const msg = micErr instanceof Error ? micErr.message : 'Microphone access denied';
        if (msg.includes('NotAllowedError') || msg.includes('Permission denied') || msg.includes('not allowed')) {
          throw new Error('Microphone permission denied. Please allow microphone access in your browser settings.');
        }
        if (msg.includes('NotFoundError') || msg.includes('Requested device not found')) {
          throw new Error('No microphone found. Please connect a microphone and try again.');
        }
        throw new Error(`Microphone error: ${msg}`);
      }

      this._micStream = micStream;

      try {
        pc.addTrack(micStream.getTracks()[0]);
      } catch (trackErr) {
        micStream.getTracks().forEach(t => t.stop());
        this._micStream = null;
        throw trackErr;
      }

      // 4. Create DataChannel
      this._setPhase('creating-offer');
      const dc = pc.createDataChannel('oai-events');
      this._dc = dc;

      dc.addEventListener('open', () => {
        this._didConnect = true;
        if (this._connectionTimeoutId) {
          clearTimeout(this._connectionTimeoutId);
          this._connectionTimeoutId = null;
        }

        this._isConnected = true;
        this._isConnecting = false;
        this._reconnectAttempt = 0;
        this._setPhase('connected');
        this._startStatsMonitoring();

        // Update session with instructions, VAD config, and transcription
        const instructions = this._options.instructions ?? buildDefaultInstructions({
          studentName: this._options.studentName,
          language: this._options.language,
          nativeLanguage: this._options.nativeLanguage,
          birthDate: this._options.birthDate,
        });

        const sessionUpdate = {
          type: 'session.update',
          session: {
            instructions,
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            input_audio_transcription: {
              model: 'gpt-4o-mini-transcribe',
            },
          },
        };
        dc.send(JSON.stringify(sessionUpdate));
        this.emit('connected', undefined);
      });

      dc.addEventListener('message', (event) => {
        this._handleDataChannelMessage(event);
      });

      // 5. Handle ICE state changes with auto-reconnect
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          if (pc.iceConnectionState === 'failed' && this._reconnectAttempt < this._maxReconnectAttempts) {
            this._reconnectAttempt += 1;
            this._setPhase('reconnecting');
            this._cleanup();

            const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this._reconnectAttempt - 1);
            this._reconnectTimeoutId = setTimeout(() => {
              this._isConnecting = true;
              this._connectInternal();
            }, delay);
          } else {
            this._isConnected = false;
            this._isConnecting = false;
            this._setPhase('idle');
            this.emit('disconnected', undefined);
            if (pc.iceConnectionState === 'failed') {
              this._error = 'Connection lost. Please try reconnecting.';
              this.emit('error', { message: this._error });
            }
          }
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'closed') {
          this._isConnected = false;
          this._isConnecting = false;
          this._setPhase('idle');
          this.emit('disconnected', undefined);
        }
      };

      // 6. Create SDP offer
      this._setPhase('sending-sdp');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 7. Exchange SDP with backend
      const sdpResponse = await fetch(
        `${this._sdpEndpoint}?model=${encodeURIComponent(this._model)}&voice=${encodeURIComponent(this._voice)}`,
        {
          method: 'POST',
          body: offer.sdp,
          headers: { 'Content-Type': 'application/sdp' },
        },
      );

      if (!sdpResponse.ok) {
        const errBody = await sdpResponse.text();
        let errMsg: string;
        try {
          errMsg = JSON.parse(errBody).error || errBody;
        } catch {
          errMsg = errBody;
        }
        throw new Error('[HTTP] ' + errMsg);
      }

      const sdpAnswer = await sdpResponse.text();
      if (!sdpAnswer.includes('v=0')) {
        throw new Error('Invalid SDP answer from server. Response: ' + sdpAnswer.substring(0, 100));
      }

      // 8. Set remote description
      this._setPhase('waiting-dc');
      await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });

      // 9. Connection timeout
      this._connectionTimeoutId = setTimeout(() => {
        if (!this._didConnect && !this._isConnected) {
          this._error = 'Connection timeout. WebRTC handshake succeeded but data channel did not open.';
          this.emit('error', { message: this._error });
          this._setPhase('failed');
          this._cleanup();
          this._isConnecting = false;
        }
      }, this._connectionTimeoutMs);

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to connect to OpenAI Realtime';
      this._error = msg;
      this._isConnected = false;
      this._isConnecting = false;
      this._setPhase('failed');
      this.emit('error', { message: msg });
      this._cleanup();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — DataChannel event processing
  // ---------------------------------------------------------------------------

  private _handleDataChannelMessage(event: MessageEvent): void {
    let serverEvent: Record<string, unknown>;
    try {
      serverEvent = JSON.parse(event.data as string) as Record<string, unknown>;
    } catch (err) {
      console.error('[OpenAIRealtimeClient] Error parsing data channel message:', err);
      return;
    }

    const type = serverEvent.type as string;

    switch (type) {
      case 'session.created':
      case 'session.updated':
        this._error = null;
        break;

      // User speech transcription
      case 'conversation.item.input_audio_transcription.completed':
        this._pendingUserTranscript = (serverEvent.transcript as string) || '';
        break;

      // Model started generating
      case 'response.created':
        this._pendingResponseText = '';
        this._pendingAudioTranscript = '';
        break;

      // Text delta (text modality)
      case 'response.output_text.delta':
      case 'response.text.delta': {
        const delta = (serverEvent.delta as string) || '';
        if (this._pendingResponseText.length < MAX_RESPONSE_LENGTH) {
          this._pendingResponseText += delta;
        }
        break;
      }

      // Audio transcript delta (what model is saying)
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        const delta = (serverEvent.delta as string) || '';
        this._pendingAudioTranscript += delta;
        if (this._pendingAudioTranscript.length > MAX_TRANSCRIPT_LENGTH) {
          this._pendingAudioTranscript = this._pendingAudioTranscript.slice(-MAX_TRANSCRIPT_LENGTH);
        }
        this.emit('transcript', { delta, full: this._pendingAudioTranscript });
        break;
      }

      // Audio transcript complete
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this._pendingAudioTranscript = (serverEvent.transcript as string) || '';
        this.emit('transcript', { delta: '', full: this._pendingAudioTranscript });
        break;

      // Model audio playback started
      case 'output_audio_buffer.started':
        this.emit('speaking-start', undefined);
        break;

      // Model audio playback stopped/cleared
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.emit('speaking-end', undefined);
        break;

      // Response fully complete
      case 'response.done': {
        const responseData = serverEvent.response as Record<string, unknown> | undefined;

        // Extract text from response output
        let responseText = this._pendingAudioTranscript || this._pendingResponseText;
        if (!responseText && responseData?.output) {
          const output = responseData.output as Array<Record<string, unknown>>;
          for (const item of output) {
            const content = item.content as Array<Record<string, unknown>> | undefined;
            if (content) {
              for (const c of content) {
                if (c.transcript) { responseText = c.transcript as string; break; }
                else if (c.text) { responseText = c.text as string; break; }
              }
            }
            if (responseText) break;
          }
        }

        this.emit('response', {
          text: responseText,
          userText: this._pendingUserTranscript,
          visemes: [],
          duration: 0,
        });
        this.emit('speaking-end', undefined);

        // Reset accumulators
        this._pendingUserTranscript = '';
        this._pendingResponseText = '';
        this._pendingAudioTranscript = '';
        this.emit('transcript', { delta: '', full: '' });
        break;
      }

      // Response cancelled (barge-in)
      case 'response.cancelled':
        break;

      // Errors from server
      case 'error': {
        const errData = serverEvent.error as Record<string, string> | undefined;
        const errMsg = errData?.message || 'Unknown server error';
        this._error = '[DC] ' + errMsg;
        this.emit('error', { message: this._error });
        break;
      }

      default:
        // Unknown events — silently ignore
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — RTCStats monitoring
  // ---------------------------------------------------------------------------

  private _startStatsMonitoring(): void {
    this._stopStatsMonitoring();

    this._statsIntervalId = setInterval(async () => {
      const pc = this._pc;
      if (!pc || pc.connectionState !== 'connected') return;

      try {
        const stats = await pc.getStats();
        let rtt = 0;
        let packetLoss = 0;
        let jitter = 0;
        let hasData = false;

        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = report.currentRoundTripTime ? (report.currentRoundTripTime as number) * 1000 : 0;
            hasData = true;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            if (report.packetsLost !== undefined && report.packetsReceived !== undefined) {
              const total = (report.packetsReceived as number) + (report.packetsLost as number);
              packetLoss = total > 0 ? ((report.packetsLost as number) / total) * 100 : 0;
            }
            if (report.jitter !== undefined) {
              jitter = (report.jitter as number) * 1000;
            }
            hasData = true;
          }
        });

        if (hasData) {
          let quality: NetworkQuality['quality'] = 'excellent';
          if (rtt > 300 || packetLoss > 5 || jitter > 50) {
            quality = 'poor';
          } else if (rtt > 200 || packetLoss > 2 || jitter > 30) {
            quality = 'fair';
          } else if (rtt > 100 || packetLoss > 0.5 || jitter > 15) {
            quality = 'good';
          }

          const qualityReport: NetworkQuality = {
            rttMs: Math.round(rtt),
            packetLossPercent: Math.round(packetLoss * 100) / 100,
            jitterMs: Math.round(jitter * 10) / 10,
            quality,
            timestamp: Date.now(),
          };

          this.emit('network-quality', qualityReport);
          this._options.onNetworkQualityChange?.(qualityReport);
        }
      } catch {
        // Stats collection is best-effort
      }
    }, STATS_POLL_INTERVAL_MS);
  }

  private _stopStatsMonitoring(): void {
    if (this._statsIntervalId) {
      clearInterval(this._statsIntervalId);
      this._statsIntervalId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — cleanup
  // ---------------------------------------------------------------------------

  private _cleanup(): void {
    // Clear timers
    if (this._connectionTimeoutId) {
      clearTimeout(this._connectionTimeoutId);
      this._connectionTimeoutId = null;
    }
    if (this._reconnectTimeoutId) {
      clearTimeout(this._reconnectTimeoutId);
      this._reconnectTimeoutId = null;
    }
    this._stopStatsMonitoring();

    // Clear event handlers first to prevent stale callbacks after cleanup
    if (this._pc) {
      this._pc.oniceconnectionstatechange = null;
      this._pc.onconnectionstatechange = null;
    }

    // Close data channel
    if (this._dc) {
      try { this._dc.close(); } catch { /* ignore */ }
      this._dc = null;
    }
    // Close peer connection
    if (this._pc) {
      try { this._pc.close(); } catch { /* ignore */ }
      this._pc = null;
    }
    // Stop microphone
    if (this._micStream) {
      this._micStream.getTracks().forEach(t => t.stop());
      this._micStream = null;
    }
    // Clean audio element
    if (this._audioEl) {
      this._audioEl.srcObject = null;
      this._audioEl = null;
    }

    this._didConnect = false;
    this.emit('audio-stream', null);
  }

  private _setPhase(phase: ConnectionPhase): void {
    this._phase = phase;
    this.emit('status-change', { phase });
  }
}
