/**
 * LlmPort — Large Language Model capability port.
 *
 * Domain-level contract for text generation (chat + translation). Implementations
 * (Groq, OpenAI, Fireworks, GPU self-hosted, etc.) are adapters.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface TranslateRequest {
  /** Text to translate. */
  text: string;
  /** ISO 639-1 source language, or `'auto'`. */
  from: string;
  /** ISO 639-1 target language. */
  to: string;
  /** Optional style hint: neutral / casual / formal. */
  style?: 'neutral' | 'casual' | 'formal';
  timeoutMs?: number;
}

export interface ChatCompletion {
  content: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: 'stop' | 'length' | 'error';
}

export interface Translation {
  text: string;
  from: string;
  to: string;
  latencyMs: number;
  model?: string;
}

export interface LlmPort {
  chat(request: ChatRequest): Promise<ChatCompletion>;
  translate(request: TranslateRequest): Promise<Translation>;
}
