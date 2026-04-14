/**
 * API Contracts — Zod schemas for all external API requests and responses.
 *
 * Centralizes validation logic for all endpoints.
 * Each schema is named after its endpoint: `SpeechRequest`, `ChatResponse`, etc.
 *
 * @example
 * ```ts
 * import { SpeechRequest } from './contracts';
 *
 * // In request handler:
 * const result = SpeechRequest.safeParse(req.body);
 * if (!result.success) return res.writeHead(400).end(result.error.message);
 * ```
 */

import { z } from 'zod';

// ── Speech Pipeline ──────────────────────────────────────────────────────────

export const SpeechQuerySchema = z.object({
  source: z.string().min(2).max(5).describe('Source language code (e.g. fr, en, pt)'),
  target: z.string().min(2).max(5).describe('Target language code'),
  speaker: z.string().min(1).max(50).optional().describe('TTS speaker name'),
  temperature: z.coerce.number().min(0).max(2).optional().default(0.7),
  ensemble: z.coerce.boolean().optional().default(false).describe('Use ensemble STT mode'),
});

export const SpeechResponseSchema = z.object({
  transcription: z.string(),
  response: z.string(),
  audio_base64: z.string(),
  content_type: z.string(),
  timing: z.object({
    total_ms: z.number(),
    used_gpu: z.boolean(),
    stt_ms: z.number().optional(),
    chat_ms: z.number().optional(),
    tts_ms: z.number().optional(),
  }),
});

// ── STT ──────────────────────────────────────────────────────────────────────

export const TranscriptionRequestSchema = z.object({
  model: z.string().optional(),
  language: z.string().optional(),
  prompt: z.string().max(4096).optional(),
  response_format: z.enum(['json', 'text', 'verbose_json']).optional().default('json'),
  temperature: z.number().min(0).max(1).optional(),
});

export const TranscriptionResponseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  duration: z.number().optional(),
  words: z
    .array(
      z.object({
        word: z.string(),
        start: z.number(),
        end: z.number(),
      }),
    )
    .optional(),
});

// ── Chat / LLM ───────────────────────────────────────────────────────────────

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema),
  temperature: z.number().min(0).max(2).optional().default(1),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional().default(false),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: ChatMessageSchema,
      finish_reason: z.enum(['stop', 'length', 'content_filter']),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});

// ── TTS ──────────────────────────────────────────────────────────────────────

export const TTSRequestSchema = z.object({
  model: z.string().optional(),
  input: z.string().min(1).max(4096),
  voice: z.string().optional(),
  speed: z.number().min(0.25).max(4).optional().default(1),
  response_format: z.enum(['mp3', 'wav', 'opus', 'flac']).optional().default('mp3'),
});

export const TTSResponseSchema = z.object({
  audio_base64: z.string(),
  content_type: z.string(),
  duration_ms: z.number().optional(),
});

// ── GPU Management ───────────────────────────────────────────────────────────

export const GpuDeployRequestSchema = z.object({
  dockerImage: z.string().min(1),
  gpuTypes: z.array(z.string()).min(1),
  apiKey: z.string().optional(),
  region: z.string().optional(),
  storageGb: z.number().optional(),
  minVramGb: z.number().optional(),
});

export const GpuStatusResponseSchema = z.object({
  status: z.enum([
    'running',
    'idle',
    'booting',
    'stopped',
    'error',
    'not_deployed',
    'creating',
    'installing',
    'searching',
    'queued',
  ]),
  podId: z.string().optional(),
  endpoint: z.string().optional(),
  gpuType: z.string().optional(),
  gpuHealthy: z.boolean().optional(),
  idleSec: z.number().optional(),
});

// ── Config ───────────────────────────────────────────────────────────────────

export const ProviderConfigSchema = z.object({
  pipelineStt: z
    .array(
      z.object({
        providerId: z.string(),
        model: z.string(),
        weight: z.number().min(0).max(1),
      }),
    )
    .min(1),
  pipelineLlm: z
    .array(
      z.object({
        providerId: z.string(),
        model: z.string(),
        weight: z.number().min(0).max(1),
      }),
    )
    .min(1),
  pipelineTts: z
    .array(
      z.object({
        providerId: z.string(),
        model: z.string(),
        weight: z.number().min(0).max(1),
      }),
    )
    .min(1),
});

export const ApiKeysRequestSchema = z.object({
  keys: z.array(z.string()).min(1),
});

// ── Error Response ───────────────────────────────────────────────────────────

export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  message: z.string(),
  statusCode: z.number(),
  retryable: z.boolean(),
  context: z.record(z.string(), z.unknown()).optional(),
  cause: z.string().optional(),
});

// ── Type exports ─────────────────────────────────────────────────────────────

export type SpeechQuery = z.infer<typeof SpeechQuerySchema>;
export type SpeechResponse = z.infer<typeof SpeechResponseSchema>;
export type TranscriptionRequest = z.infer<typeof TranscriptionRequestSchema>;
export type TranscriptionResponse = z.infer<typeof TranscriptionResponseSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;
export type TTSRequest = z.infer<typeof TTSRequestSchema>;
export type TTSResponse = z.infer<typeof TTSResponseSchema>;
export type GpuDeployRequest = z.infer<typeof GpuDeployRequestSchema>;
export type GpuStatusResponse = z.infer<typeof GpuStatusResponseSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
