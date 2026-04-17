/**
 * Server-side constants — all magic numbers and strings extracted here.
 *
 * Fixes: #176-220 (magic numbers/strings)
 *
 * Usage:
 * ```ts
 * import { GPU } from './constants';
 * console.log(GPU.IDLE_TIMEOUT_MS);
 * ```
 */

// ── GPU Deploy (#176-190) ───────────────────────────────────────────────────

export const GPU = {
  MAX_DEPLOY_RETRIES: 2,
  HEALTH_POLL_INTERVAL_MS: 10_000,
  DEPLOY_TIMEOUT_MS: 30 * 60_000, // 30 min
  GPU_MONITOR_INTERVAL_MS: 30_000,
  IDLE_TIMEOUT_MS: 5 * 60_000, // 5 min — cold-start plan A3 (was 15 min)
  IDLE_DESTROY_MS: 2 * 60 * 60_000, // 2 hours
  GPU_TYPE_CACHE_TTL_MS: 30 * 60_000, // 30 min
  P95_DEMOTION_CONSECUTIVE_VIOLATIONS: 3,
  TREND_WINDOW: 5,
  TREND_THRESHOLD: 0.2,
  BUDGET_SOFT_LIMIT: 0.8,
} as const;

// ── Proxy Server (#192-196) ─────────────────────────────────────────────────

export const PROXY = {
  MAX_BODY_SIZE: 100 * 1024 * 1024, // 100MB
  BODY_READ_TIMEOUT_MS: 30_000, // 30s
  TOTAL_REQUEST_TIMEOUT_MS: 60_000, // 60s
  HEADERS_TIMEOUT_MS: 10_000, // 10s
  REQUEST_TIMEOUT_MS: 30_000, // 30s
  PORT: 4000,
  HOSTNAME: '0.0.0.0',
} as const;

// ── AI Handlers (#188-190) ──────────────────────────────────────────────────

export const AI = {
  BASELINE_INFERENCE_MS: 200,
  BASELINE_BW_GBS: 1008,
  RTT_BASELINE_MS: 10,
  RTT_DISTANCE_FACTOR: 0.012,
} as const;

// ── GPU Latency (#186) ──────────────────────────────────────────────────────

export const GPU_BANDWIDTH_GBS: Record<string, number> = {
  'RTX 5090': 29.5,
  'RTX 4090': 28.0,
  'RTX 3090': 24.0,
  'A100': 30.0,
  'A6000': 24.0,
  'L40S': 24.0,
  'A5000': 16.0,
  'A40': 16.0,
} as const;

// ── RunPod Datacenters (#187) ───────────────────────────────────────────────

export const RUNPOD_DC: Record<string, { name: string; region: string }> = {
  'EU-RO-1': { name: 'Bucharest', region: 'EU' },
  'EU-NL-1': { name: 'Netherlands', region: 'EU' },
  'US-CA-1': { name: 'California', region: 'US' },
  'US-GA-1': { name: 'Georgia', region: 'US' },
  'US-TX-1': { name: 'Texas', region: 'US' },
  'AS-SG-1': { name: 'Singapore', region: 'AS' },
  'AS-JP-1': { name: 'Tokyo', region: 'AS' },
} as const;

// ── Docker Images (#191) ────────────────────────────────────────────────────

export const DOCKER = {
  IMAGE_VERSION: process.env.IMAGE_VERSION || 'v1.3.0',
  BABELCAST_SUBTITLE: `marcosremar/babelcast-subtitle:${process.env.IMAGE_VERSION || 'v1.3.0'}`,
  BABELCAST_MISTRAL: 'marcosremar/babelcast-mistral:latest',
  MAX_IMAGE_SIZE_GB: 20,
  PULL_TIMEOUT_MS: 10 * 60_000, // 10 min
} as const;

// ── Bot (#186) ──────────────────────────────────────────────────────────────

export const BOT = {
  LOCAL_CONTAINER: 'ai-gateway-bot',
  POLL_INTERVAL_MS: 5_000,
  DEPLOY_TIMEOUT_MS: 10 * 60_000, // 10 min
  MAX_BOTS_PER_USER: 5,
} as const;

// ── WebSocket (#176) ────────────────────────────────────────────────────────

export const WS = {
  HEARTBEAT_INTERVAL_MS: 25_000,
  HEARTBEAT_TIMEOUT_MS: 5_000,
  MAX_MESSAGE_SIZE_BYTES: 1024 * 1024, // 1MB
  PING_INTERVAL_MS: 30_000,
  RECONNECT_DELAY_MS: 1_000,
  MAX_RECONNECT_ATTEMPTS: 5,
} as const;

// ── Streaming Overlap (#200) ────────────────────────────────────────────────

export const STREAMING = {
  OVERLAP_WINDOW_MS: 500,
  SPECULATION_THRESHOLD: 0.8,
  EWMA_ALPHA: 0.3,
  MAX_BUFFER_SIZE: 100,
  CHUNK_TIMEOUT_MS: 30_000,
} as const;

// ── Rate Limiting ────────────────────────────────────────────────────────────

export const RATE_LIMIT = {
  DEFAULT_RPM: 0, // disabled
  PER_KEY_WINDOW_MS: 60_000,
  PER_KEY_DEFAULT_QUOTA: 100,
  GLOBAL_BURST_MULTIPLIER: 1.5,
} as const;

// ── Security ─────────────────────────────────────────────────────────────────

export const SECURITY = {
  MAX_LOGIN_ATTEMPTS: 5,
  LOGIN_COOLDOWN_MS: 15 * 60_000, // 15 min
  TOKEN_EXPIRY_MS: 24 * 60 * 60_000, // 24h
  MAX_REQUEST_SIZE_MB: 100,
  MAX_API_KEYS_PER_USER: 10,
} as const;

// ── Timeouts (#143, #206) ───────────────────────────────────────────────────

export const TIMEOUTS = {
  PROVIDER_DEFAULT_MS: 30_000,
  PROVIDER_STT_MS: 60_000,
  PROVIDER_LLM_MS: 120_000,
  PROVIDER_TTS_MS: 30_000,
  GPU_BOOT_MS: 30 * 60_000,
  GPU_HEALTH_MS: 10_000,
  DB_QUERY_MS: 5_000,
  CACHE_GET_MS: 1_000,
  WEBHOOK_DELIVERY_MS: 10_000,
  EXTERNAL_API_MS: 30_000,
} as const;

// ── GPU Types (#211) ────────────────────────────────────────────────────────

export const GPU_TYPES = {
  RTX_5090: 'NVIDIA GeForce RTX 5090',
  RTX_4090: 'NVIDIA GeForce RTX 4090',
  RTX_3090: 'NVIDIA GeForce RTX 3090',
  RTX_A6000: 'NVIDIA RTX A6000',
  L40S: 'NVIDIA L40S',
  RTX_A5000: 'NVIDIA RTX A5000',
  A40: 'NVIDIA A40',
} as const;

export const GPU_TYPE_ALLOWLIST = Object.values(GPU_TYPES);

// ── Model Names (#212) ──────────────────────────────────────────────────────

export const MODELS = {
  STT_WHISPER_LARGE: 'whisper-large-v3',
  STT_WHISPER_TURBO: 'whisper-large-v3-turbo',
  LLM_LLAMA_70B: 'llama-3.3-70b-versatile',
  LLM_LLAMA_8B: 'llama-3.1-8b-instant',
  LLM_LLAMA_4_SCOUT: 'meta-llama/llama-4-scout-17b-16e-instruct',
  TTS_ORPHEUS_EN: 'canopylabs/orpheus-v1-english',
  TTS_ORPHEUS_AR: 'canopylabs/orpheus-arabic-saudi',
} as const;

// ── Ports (#216) ────────────────────────────────────────────────────────────

export const PORTS = {
  HTTP: 8000,
  SSH: 22,
  HTTPS: 443,
  GRPC: 9000,
  WEBSOCKET: 8080,
} as const;

// ── Pipeline Stages (#218) ──────────────────────────────────────────────────

export const PIPELINE = {
  STAGE_STT: 'stt',
  STAGE_LLM: 'llm',
  STAGE_TTS: 'tts',
  STAGE_COMPLETE: 'complete',
  STAGE_FAILED: 'failed',
} as const;
