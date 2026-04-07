/**
 * Modal Qwen3-ASR + TranslateGemma Pipeline Provider
 *
 * Combined ASR (best noise-robust, 7.4% WER) + translation (55 langs).
 * Single endpoint handles both STT and LLM stages.
 * Supports proxy auth via MODAL_PROXY_SECRET env (format: key:secret).
 * Apache 2.0 license (both models).
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
  'https://marcosremar--babelcast-qwen3asr-pipe-qwen3asrpipeline-serve.modal.run';

export const QWEN3ASR_PIPELINE_MODELS: ModelInfo[] = [
  {
    id: 'qwen3-asr-1.7b',
    name: 'Qwen3-ASR 1.7B',
    description: 'Qwen3-ASR — best noise-robust ASR, 30 languages, 7.4% WER',
    capability: 'stt',
    isDefault: true,
  },
  {
    id: 'translategemma-12b',
    name: 'TranslateGemma 12B',
    description: 'Google TranslateGemma 12B — best open translation, 55 languages',
    capability: 'llm',
    isDefault: true,
  },
];

// ── STT Provider ────────────────────────────────────────────────────────────

export class Qwen3ASRPipelineSTTProvider implements STTProvider {
  readonly providerId: ProviderId = 'modal-qwen3asr-pipeline' as ProviderId;
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.MODAL_QWEN3ASR_PIPELINE_URL || DEFAULT_ENDPOINT;
  }

  getModels(): ModelInfo[] { return QWEN3ASR_PIPELINE_MODELS.filter(m => m.capability === 'stt'); }
  isConfigured(): boolean { return true; }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const formData = new FormData();
    const audioBlob = request.audio instanceof Blob
      ? request.audio
      : new Blob([new Uint8Array(request.audio)], { type: 'audio/wav' });
    formData.append('file', audioBlob, 'audio.wav');
    formData.append('language', request.language || 'fr');

    const res = await fetch(`${this.endpoint}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: buildProxyAuthHeaders(),
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(
        new Error(`Qwen3-ASR Pipeline STT error (${res.status}): ${body}`),
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

// ── LLM Provider (Translation) ─────────────────────────────────────────────

export class Qwen3ASRPipelineLLMProvider implements LLMProvider {
  readonly providerId: string = 'modal-qwen3asr-pipeline';
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.MODAL_QWEN3ASR_PIPELINE_URL || DEFAULT_ENDPOINT;
  }

  isConfigured(): boolean { return true; }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Parse source/target from system prompt
    let sourceLang = 'fr';
    let targetLang = 'en';

    const systemMsg = request.messages.find(m => m.role === 'system');
    if (systemMsg && typeof systemMsg.content === 'string') {
      const match = systemMsg.content.match(/from\s+(\w+)\s+to\s+(\w+)/i);
      if (match) {
        sourceLang = match[1].toLowerCase();
        targetLang = match[2].toLowerCase();
      }
    }

    const userMsg = [...request.messages].reverse().find(m => m.role === 'user');
    const text = userMsg
      ? (typeof userMsg.content === 'string' ? userMsg.content : '')
      : '';

    if (!text) {
      return { content: '', model: 'translategemma-12b', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }

    const res = await fetch(`${this.endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { ...buildProxyAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source_lang: sourceLang, target_lang: targetLang }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(
        new Error(`TranslateGemma Pipeline error (${res.status}): ${body}`),
        { status: res.status },
      );
    }

    const data = await res.json() as { text: string; duration_ms: number };
    return {
      content: data.text,
      model: 'translategemma-12b',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
}

// ── Singleton instances ─────────────────────────────────────────────────────

export const qwen3asrPipelineSTT = new Qwen3ASRPipelineSTTProvider();
export const qwen3asrPipelineLLM = new Qwen3ASRPipelineLLMProvider();
