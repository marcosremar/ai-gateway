/**
 * OpenAI Omni Audio Provider
 *
 * Implements the OmniProvider interface for OpenAI's audio-capable chat models
 * (gpt-audio-mini, gpt-audio). Accepts audio/text input and returns both
 * text and audio in a single Chat Completions call.
 *
 * Uses fetch directly (no SDK dependency), matching the pattern of OpenAIRealtimeProvider.
 */

import type {
  ProviderId,
  ModelInfo,
  OmniProvider,
  OmniRequest,
  OmniResponse,
} from '../types';
import { OPENAI_OMNI_MODELS } from './models';

export class OpenAIOmniProvider implements OmniProvider {
  readonly providerId: ProviderId = 'openai';
  private apiKey: string | null = null;

  private getApiKey(): string {
    const key = this.apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('[OpenAI Omni] OPENAI_API_KEY is not set');
    return key;
  }

  withApiKey(apiKey: string): OpenAIOmniProvider {
    const provider = new OpenAIOmniProvider();
    provider.apiKey = apiKey;
    return provider;
  }

  getModels(): ModelInfo[] {
    return OPENAI_OMNI_MODELS;
  }

  isConfigured(): boolean {
    return !!(this.apiKey || process.env.OPENAI_API_KEY);
  }

  async omniChat(request: OmniRequest): Promise<OmniResponse> {
    const apiKey = this.getApiKey();
    const model = request.model || 'gpt-audio-mini';
    const voice = request.voice || 'nova';
    const format = request.audioFormat || 'wav';

    // Build messages array
    const messages: Array<Record<string, unknown>> = [];

    if (request.instructions) {
      messages.push({ role: 'system', content: request.instructions });
    }

    // Append history
    if (request.history) {
      for (const msg of request.history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Build user content parts
    const userContent: Array<Record<string, unknown>> = [];

    if (request.audio) {
      const audioBuffer = request.audio instanceof Buffer
        ? request.audio
        : Buffer.from(await (request.audio as Blob).arrayBuffer());
      const audioBase64 = audioBuffer.toString('base64');

      // Detect format from the audio buffer or default to wav
      let inputFormat = 'wav';
      if (request.audio instanceof Blob) {
        const ct = (request.audio as Blob).type || '';
        if (ct.includes('mp3') || ct.includes('mpeg')) inputFormat = 'mp3';
        else if (ct.includes('webm')) inputFormat = 'webm';
        else if (ct.includes('ogg')) inputFormat = 'ogg';
        else if (ct.includes('mp4') || ct.includes('m4a')) inputFormat = 'mp4';
      }

      userContent.push({
        type: 'input_audio',
        input_audio: { data: audioBase64, format: inputFormat },
      });
    }

    if (request.text) {
      userContent.push({ type: 'text', text: request.text });
    }

    messages.push({
      role: 'user',
      content: userContent.length === 1 && userContent[0].type === 'text'
        ? request.text
        : userContent,
    });

    const body = {
      model,
      modalities: ['text', 'audio'],
      audio: { voice, format },
      messages,
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`[OpenAI Omni] Chat completions failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as {
      model: string;
      choices: Array<{
        message: {
          content?: string;
          audio?: { transcript?: string; data?: string };
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices[0];
    const audioResponse = choice?.message?.audio;
    const text = audioResponse?.transcript || choice?.message?.content || '';
    const audioData = audioResponse?.data || '';

    return {
      text,
      audio: Buffer.from(audioData, 'base64'),
      audioBase64: audioData,
      contentType: `audio/${format}`,
      model: data.model || model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }
}
