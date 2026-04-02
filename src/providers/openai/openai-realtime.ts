/**
 * OpenAI Realtime (Speech-to-Speech) Provider
 *
 * Implements the RealtimeProvider interface for OpenAI's Realtime API.
 * Supports gpt-4o-realtime-preview and gpt-4o-mini-realtime-preview.
 *
 * Flow:
 * 1. Server creates an ephemeral token via POST /v1/realtime/client_secrets
 * 2. Browser uses token to connect via WebRTC or WebSocket
 * 3. Audio is streamed in both directions natively - no separate STT/TTS needed
 */

import type {
  AIProviderId,
  ModelInfo,
  VoiceInfo,
  RealtimeProvider,
  RealtimeSession,
  RealtimeSessionConfig,
  RealtimeSdpConfig,
} from '../types';
import { OPENAI_REALTIME_MODELS, OPENAI_VOICES } from './models';

export class OpenAIRealtimeProvider implements RealtimeProvider {
  readonly providerId: AIProviderId = 'openai';
  private apiKey: string | null = null;

  private getApiKey(): string {
    const key = this.apiKey || process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('[OpenAI Realtime] OPENAI_API_KEY is not set');
    }
    return key;
  }

  /**
   * Create a provider instance with a specific API key (for per-user keys).
   */
  withApiKey(apiKey: string): OpenAIRealtimeProvider {
    const provider = new OpenAIRealtimeProvider();
    provider.apiKey = apiKey;
    return provider;
  }

  getModels(): ModelInfo[] {
    return OPENAI_REALTIME_MODELS;
  }

  getVoices(): VoiceInfo[] {
    // Realtime supports the same voices as gpt-4o-mini-tts
    return OPENAI_VOICES;
  }

  isConfigured(): boolean {
    return !!(this.apiKey || process.env.OPENAI_API_KEY);
  }

  /**
   * Create an ephemeral session for the Realtime API.
   * Returns a client_secret that the browser uses to authenticate
   * a WebRTC or WebSocket connection directly to OpenAI.
   */
  /**
   * SDP proxy flow — exchange a browser SDP offer for an SDP answer via
   * OpenAI's /v1/realtime/calls endpoint.
   *
   * Note: multipart/form-data is built manually because Bun's native FormData
   * hangs indefinitely when posting to OpenAI's endpoint.
   */
  async exchangeSdp(config: RealtimeSdpConfig): Promise<string> {
    const apiKey = this.getApiKey();
    const model = config.model || 'gpt-4o-mini-realtime-preview';
    const voice = this.resolveRealtimeVoice(config.voice);

    const sessionConfig = JSON.stringify({ type: 'realtime', model, audio: { output: { voice } } });

    // Build multipart body manually (Bun's FormData + fetch to OpenAI hangs)
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="sdp"\r\n\r\n${config.sdpOffer}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="session"\r\n\r\n${sessionConfig}`,
      `--${boundary}--\r\n`,
    ];
    const bodyStr = parts.join('\r\n');

    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: bodyStr,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[OpenAI Realtime] SDP exchange failed (${response.status}): ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    // OpenAI may return plain SDP or wrap it in JSON
    if (contentType.includes('application/json')) {
      try {
        const json = JSON.parse(body);
        return (json.sdp || json.answer || body) as string;
      } catch {
        return body;
      }
    }
    return body;
  }

  /**
   * Map TTS voices to Realtime-compatible equivalents.
   * Realtime API supports: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar.
   * TTS-only voices (nova, fable, onyx) need mapping.
   */
  private resolveRealtimeVoice(requested?: string): string {
    const REALTIME_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
    if (requested && REALTIME_VOICES.has(requested)) return requested;
    // Map TTS-only voices to closest Realtime equivalent
    const VOICE_MAP: Record<string, string> = { nova: 'coral', fable: 'sage', onyx: 'ash' };
    return VOICE_MAP[requested ?? ''] ?? 'coral';
  }

  async createSession(config: RealtimeSessionConfig): Promise<RealtimeSession> {
    const apiKey = this.getApiKey();
    const model = config.model || 'gpt-4o-mini-realtime-preview';
    const voice = this.resolveRealtimeVoice(config.voice);

    // Note: client_secrets endpoint only supports model, audio, and voice config.
    // turn_detection, instructions, etc. must be set via session.update on the
    // data channel after the WebRTC/WebSocket connection is established.
    const sessionPayload: Record<string, unknown> = {
      session: {
        type: 'realtime',
        model,
        audio: {
          output: {
            voice,
            ...(config.outputAudioFormat && {
              format: { type: config.outputAudioFormat, rate: 24000 },
            }),
          },
          input: {
            ...(config.inputAudioFormat && {
              format: { type: config.inputAudioFormat, rate: 24000 },
            }),
            ...(config.noiseReduction && {
              noise_reduction: { type: config.noiseReduction.type },
            }),
          },
        },
      },
    };

    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sessionPayload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `[OpenAI Realtime] Failed to create session (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();

    return {
      clientSecret: data.client_secret?.value || data.value,
      expiresAt: data.client_secret?.expires_at || data.expires_at,
      config,
    };
  }
}

/** Singleton instance — use `.withApiKey(key)` for per-user keys. */
export const openaiRealtime = new OpenAIRealtimeProvider();
