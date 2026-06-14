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

// ── SSRF-safe URL helper (#652) ──────────────────────────────────────────────
//
// `z.string().url()` accepts `http://169.254.169.254/` and `file:///etc/passwd`.
// Several request fields (meetingUrl, page/stream URLs) are forwarded to a
// server-side fetch downstream, so a private/metadata/non-http host is an SSRF
// vector. This is a *pure, synchronous, dependency-free* host check kept inline
// so the contracts entry point stays free of the `node:dns` SSRF module — it
// rejects only genuinely-unsafe targets, so legitimate public URLs (the only
// valid meeting URLs) still pass.

/** Only http/https are accepted; ftp:/gopher:/data:/file: are SSRF/local-read vectors. */
const SSRF_SAFE_SCHEMES = new Set(['http:', 'https:']);

/** Literal private / loopback / link-local / metadata host forms, matched on the
 *  raw hostname. DNS-name resolution is intentionally NOT done here (that needs
 *  the async resolver in src/gateway/pipeline/ssrf-protection.ts); this is the
 *  cheap synchronous first line that rejects the obvious literals. */
const SSRF_PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local + cloud metadata 169.254.169.254
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
  /^0\./,
  /^(0x[0-9a-f]+|\d{8,10})$/i, // decimal / hex IPv4 (e.g. 2130706433 = 127.0.0.1)
  /^::1$/i,
  /^0:0:0:0:0:0:0:1$/i,
  /^::$/i,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^metadata\.google/i,
];

/** True when `urlStr` parses, uses http(s), and does not target an obvious
 *  private/metadata/loopback literal. Exported for reuse by request handlers. */
export function isSsrfSafeUrl(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  if (!SSRF_SAFE_SCHEMES.has(url.protocol.toLowerCase())) return false;
  let host = url.hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return false;
  return !SSRF_PRIVATE_HOST_PATTERNS.some((re) => re.test(host));
}

/** A `z.string()` schema that is a syntactically valid http(s) URL AND not an
 *  obvious SSRF target. Drop-in replacement for `z.string().url()` on any field
 *  whose value is fetched server-side. */
export const SsrfSafeUrlSchema = z
  .string()
  .url()
  .refine((u) => isSsrfSafeUrl(u), {
    message: 'URL must be a public http(s) address (private/metadata/loopback hosts are blocked)',
  });

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

/** Upper bound on a single chat message's content. ~256 KB of text — well above
 *  any legitimate prompt/turn, but low enough to reject runaway/abusive payloads
 *  before they reach an upstream provider (and bill us). */
export const MAX_CHAT_CONTENT_CHARS = 256_000;
/** Upper bound on the number of messages in one chat completion request. */
export const MAX_CHAT_MESSAGES = 256;
/** Upper bound on requested completion tokens. Caps spend on a fat-fingered
 *  `max_tokens`; far above any real model context window. */
export const MAX_COMPLETION_TOKENS = 131_072;

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(MAX_CHAT_CONTENT_CHARS),
  name: z.string().optional(),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema).min(1).max(MAX_CHAT_MESSAGES),
  temperature: z.number().min(0).max(2).optional().default(1),
  max_tokens: z.number().int().positive().max(MAX_COMPLETION_TOKENS).optional(),
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
  /** Readiness probe mode. 'health' (default) polls /health; 'ssh' only waits for SSH :22 — useful for SSH-only experiments (e.g. CRIU). */
  readinessProbe: z.enum(['health', 'ssh']).optional(),
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

// ── Bot Management ───────────────────────────────────────────────────────────

export const BotDeployRequestSchema = z.object({
  local: z.boolean().optional(),
  dockerImage: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  cpuOnly: z.boolean().optional(),
  cpu: z.boolean().optional(),
  enableAvatar: z.boolean().optional(),
  avatar: z.boolean().optional(),
  runpod: z.boolean().optional(),
});

export const BotJoinRequestSchema = z.object({
  meetingUrl: SsrfSafeUrlSchema,
  botName: z.string().min(1).max(100).optional(),
  source: z.string().min(2).max(5).optional(),
  target: z.string().min(2).max(5).optional(),
  streamKey: z.string().optional(),
});

export const BotStreamPageRequestSchema = z.object({
  url: z.string().url().optional(),
  pageUrl: z.string().url().optional(),
}).passthrough();

// ── Benchmark ────────────────────────────────────────────────────────────────

export const BenchmarkRealtimeRequestSchema = z.object({
  requestCount: z.number().int().min(1).max(50).optional(),
  intervalMs: z.number().int().min(100).max(60000).optional(),
});

export const BenchmarkPathsRequestSchema = z.object({
  iterations: z.number().int().min(1).max(20).optional(),
  pipelineIterations: z.number().int().min(0).max(30).optional(),
  warmupIterations: z.number().int().min(0).max(5).optional(),
  source: z.string().min(2).max(5).optional(),
  target: z.string().min(2).max(5).optional(),
  speaker: z.string().max(50).optional(),
  testText: z.string().max(500).optional(),
  includeGpu: z.boolean().optional(),
  includeCloud: z.boolean().optional(),
});

// ── Config ───────────────────────────────────────────────────────────────────

/** Schema for individual pipeline chain entries — flexible to accommodate all provider shapes */
const PipelineChainEntrySchema = z.object({
  providerId: z.string(),
  model: z.string(),
  weight: z.number().min(0).max(1),
}).passthrough();

export const ProviderConfigSchema = z.object({
  pipelineStt: z.array(PipelineChainEntrySchema).min(1).optional(),
  pipelineLlm: z.array(PipelineChainEntrySchema).min(1).optional(),
  pipelineTts: z.array(PipelineChainEntrySchema).min(1).optional(),
  apps: z.array(z.unknown()).optional(),
  activeAppId: z.string().nullable().optional(),
});

export const ApiKeysUpdateRequestSchema = z.object({
  keys: z.record(z.string(), z.string()),
});

export const ProfileRequestSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(100),
  stt: z.array(z.unknown()).optional(),
  llm: z.array(z.unknown()).optional(),
  tts: z.array(z.unknown()).optional(),
  gpuDeploy: z.unknown().optional(),
  voice: z.string().optional(),
  audioFormat: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  language: z.string().optional(),
  services: z.array(z.unknown()).optional(),
  latencyTargetsMs: z.record(z.string(), z.number()).optional(),
  loadBalanceStrategy: z.string().optional(),
  latency: z.number().optional(),
  enabled: z.boolean().optional(),
});

export const ProfileActivateRequestSchema = z.object({
  id: z.string().nullable().optional(),
});

export const ProfileDeleteRequestSchema = z.object({
  id: z.string().min(1).max(64),
});

export const LabsFlagsRequestSchema = z.object({}).passthrough();

// ── Recall ───────────────────────────────────────────────────────────────────

export const RecallJoinRequestSchema = z.object({
  meetingUrl: SsrfSafeUrlSchema,
  botName: z.string().min(1).max(100).optional(),
});

export const RecallWebhookRequestSchema = z.object({
  event: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// ── Avatar ───────────────────────────────────────────────────────────────────

/** Upper bound on a base64-encoded audio field (#674). ~12 MB of base64 text ≈
 *  ~9 MB decoded — comfortably above any real reference clip, but bounded so a
 *  huge per-field blob can't bypass the whole-body size limit. */
export const MAX_AVATAR_AUDIO_CHARS = 12_000_000;

export const AvatarSpeakRequestSchema = z.object({
  text: z.string().min(1).max(4096).optional(),
  voice: z.string().max(50).optional(),
  lang: z.string().max(10).optional(),
  audio: z.string().max(MAX_AVATAR_AUDIO_CHARS).optional(), // base64-encoded audio
  visemes: z.array(z.number()).optional(),
  vtimes: z.array(z.number()).optional(),
  vdurations: z.array(z.number()).optional(),
});

export const AvatarAnimateWordRequestSchema = z.object({}).passthrough();

export const AvatarMoodRequestSchema = z.object({}).passthrough();

// ── Diagnostics ──────────────────────────────────────────────────────────────

export const DiagnosticsCleanupRequestSchema = z.object({
  requestLogDays: z.number().int().min(1).max(365).optional(),
  gpuEventDays: z.number().int().min(1).max(365).optional(),
  staleHostDays: z.number().int().min(1).max(365).optional(),
  dryRun: z.boolean().optional(),
});

export const DiagnosticsBenchmarkRequestSchema = z.object({
  rounds: z.number().int().min(1).max(10).optional(),
  text: z.string().max(1000).optional(),
});

// ── Workload ─────────────────────────────────────────────────────────────────

export const WorkloadDeployRequestSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['gpu', 'bot', 'db']),
  config: z.record(z.string(), z.unknown()).optional(),
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
export type BotDeployRequest = z.infer<typeof BotDeployRequestSchema>;
export type BotJoinRequest = z.infer<typeof BotJoinRequestSchema>;
export type BenchmarkRealtimeRequest = z.infer<typeof BenchmarkRealtimeRequestSchema>;
export type BenchmarkPathsRequest = z.infer<typeof BenchmarkPathsRequestSchema>;
export type ApiKeysUpdateRequest = z.infer<typeof ApiKeysUpdateRequestSchema>;
export type ProfileRequest = z.infer<typeof ProfileRequestSchema>;
export type RecallJoinRequest = z.infer<typeof RecallJoinRequestSchema>;
export type AvatarSpeakRequest = z.infer<typeof AvatarSpeakRequestSchema>;
export type DiagnosticsCleanupRequest = z.infer<typeof DiagnosticsCleanupRequestSchema>;
export type DiagnosticsBenchmarkRequest = z.infer<typeof DiagnosticsBenchmarkRequestSchema>;
export type WorkloadDeployRequest = z.infer<typeof WorkloadDeployRequestSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
