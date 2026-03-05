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
  async createSession(config: RealtimeSessionConfig): Promise<RealtimeSession> {
    const apiKey = this.getApiKey();
    const model = config.model || 'gpt-4o-mini-realtime-preview';

    // Note: client_secrets endpoint only supports model, audio, and voice config.
    // turn_detection, instructions, etc. must be set via session.update on the
    // data channel after the WebRTC/WebSocket connection is established.
    const sessionPayload: Record<string, unknown> = {
      session: {
        type: 'realtime',
        model,
        audio: {
          output: {
            voice: config.voice || 'coral',
            ...(config.outputAudioFormat && { format: config.outputAudioFormat }),
          },
          input: {
            ...(config.inputAudioFormat && { format: config.inputAudioFormat }),
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
