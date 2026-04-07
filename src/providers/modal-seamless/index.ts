/**
 * Modal SeamlessM4T v2 Provider (2.3B, Meta)
 *
 * Multimodal speech+text translation model.
 * Capabilities: ASR (speech→text), S2TT (speech→translated text), T2TT (text→translated text).
 * 101 input languages, 96 text output languages. Better than Whisper on ASR (en/fr).
 * Supports proxy auth via MODAL_PROXY_SECRET env (format: key:secret).
 *
 * License: CC-BY-NC-4.0 (non-commercial)
 */

import type { ProviderId, ModelInfo, STTProvider, STTRequest, STTResponse, LLMProvider, ChatRequest, ChatResponse } from '../types';

function buildProxyAuthHeaders(): Record<string, string> {
  const token = process.env.MODAL_PROXY_SECRET;
  if (!token) return {};
  const [key, secret] = token.split(':');
  if (!key || !secret) return {};
  return { 'Modal-Key': key, 'Modal-Secret': secret };
}

const DEFAULT_ENDPOINT =
  'https://marcosremar--babelcast-seamless-seamlessm4t-serve.modal.run';

export const SEAMLESS_MODELS: ModelInfo[] = [
  {
    id: 'seamless-m4t-v2-large',
    name: 'SeamlessM4T v2 Large',
    description: 'Meta SeamlessM4T v2 — ASR + speech/text translation, 100+ languages, 2.3B params',
    capability: 'stt',
    isDefault: true,
  },
  {
    id: 'seamless-m4t-v2-large-translate',
    name: 'SeamlessM4T v2 Large (Translation)',
    description: 'Meta SeamlessM4T v2 — text-to-text translation, 96 languages',
    capability: 'llm',
    isDefault: true,
  },
];

// ── STT Provider (ASR + Speech Translation) ─────────────────────────────────

export class ModalSeamlessSTTProvider implements STTProvider {
  readonly providerId: ProviderId = 'modal-seamless' as ProviderId;
  private endpoint: string;
  /** Target language for speech translation (e.g. 'fr'). If same as source, does ASR. */
  private targetLang?: string;

  constructor(endpoint?: string, targetLang?: string) {
    this.endpoint = endpoint || process.env.MODAL_SEAMLESS_URL || DEFAULT_ENDPOINT;
    this.targetLang = targetLang;
  }

  getModels(): ModelInfo[] { return SEAMLESS_MODELS.filter(m => m.capability === 'stt'); }
  isConfigured(): boolean { return true; }

  /** Set target language for speech translation mode. */
  withTargetLang(lang: string): ModalSeamlessSTTProvider {
    return new ModalSeamlessSTTProvider(this.endpoint, lang);
  }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const sourceLang = request.language || 'en';
    const targetLang = this.targetLang || sourceLang;
    const isTranslation = sourceLang !== targetLang;

    const formData = new FormData();

    // Convert Buffer to Blob for FormData
    const audioBlob = request.audio instanceof Blob
      ? request.audio
      : new Blob([new Uint8Array(request.audio)], { type: 'audio/wav' });
    formData.append('file', audioBlob, 'audio.wav');

    if (isTranslation) {
      // S2TT endpoint
      formData.append('source_lang', sourceLang);
      formData.append('target_lang', targetLang);

      const res = await fetch(`${this.endpoint}/v1/translate/speech`, {
        method: 'POST',
        headers: buildProxyAuthHeaders(),
        body: formData,
      });

      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(
          new Error(`SeamlessM4T S2TT error (${res.status}): ${body}`),
          { status: res.status },
        );
      }

      const data = await res.json() as { text: string; source_lang: string; target_lang: string; duration_ms: number };
      return {
        text: data.text,
        language: data.target_lang,
        duration: data.duration_ms / 1000,
      };
    } else {
      // ASR endpoint (OpenAI-compatible)
      formData.append('language', sourceLang);
      formData.append('model', 'seamless-m4t-v2-large');

      const res = await fetch(`${this.endpoint}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: buildProxyAuthHeaders(),
        body: formData,
      });

      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(
          new Error(`SeamlessM4T ASR error (${res.status}): ${body}`),
          { status: res.status },
        );
      }

      const data = await res.json() as { text: string; language: string; duration_ms: number };
      return {
        text: data.text,
        language: data.language,
        duration: data.duration_ms / 1000,
      };
    }
  }
}

// ── LLM Provider (Text-to-Text Translation) ────────────────────────────────

export class ModalSeamlessLLMProvider implements LLMProvider {
  readonly providerId: string = 'modal-seamless';
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.MODAL_SEAMLESS_URL || DEFAULT_ENDPOINT;
  }

  isConfigured(): boolean { return true; }

  /**
   * Text-to-text translation via chat interface.
   *
   * Expects system message with format:
   *   "Translate from {source_lang} to {target_lang}"
   * User message contains the text to translate.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Parse source/target from system prompt
    let sourceLang = 'en';
    let targetLang = 'fr';

    const systemMsg = request.messages.find(m => m.role === 'system');
    if (systemMsg && typeof systemMsg.content === 'string') {
      const match = systemMsg.content.match(/from\s+(\w+)\s+to\s+(\w+)/i);
      if (match) {
        sourceLang = match[1].toLowerCase();
        targetLang = match[2].toLowerCase();
      }
    }

    // Get text from last user message
    const userMsg = [...request.messages].reverse().find(m => m.role === 'user');
    const text = userMsg
      ? (typeof userMsg.content === 'string' ? userMsg.content : '')
      : '';

    if (!text) {
      return { content: '', model: 'seamless-m4t-v2-large', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }

    const res = await fetch(`${this.endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { ...buildProxyAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        source_lang: sourceLang,
        target_lang: targetLang,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(
        new Error(`SeamlessM4T T2TT error (${res.status}): ${body}`),
        { status: res.status },
      );
    }

    const data = await res.json() as { text: string; duration_ms: number };
    return {
      content: data.text,
      model: 'seamless-m4t-v2-large',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
}

// ── Singleton instances ─────────────────────────────────────────────────────

export const modalSeamlessSTT = new ModalSeamlessSTTProvider();
export const modalSeamlessLLM = new ModalSeamlessLLMProvider();
