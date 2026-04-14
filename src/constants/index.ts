/**
 * Centralized constants for GPU types, provider IDs, model names, and magic strings.
 * Single source of truth — no more scattered magic strings.
 */

// ── GPU Types (RunPod exact names) ─────────────────────────────────────────

export const GPU_TYPES = {
  RTX_5090: 'NVIDIA GeForce RTX 5090',
  RTX_4090: 'NVIDIA GeForce RTX 4090',
  RTX_A6000: 'NVIDIA RTX A6000',
  L40S: 'NVIDIA L40S',
  RTX_A5000: 'NVIDIA RTX A5000',
  A40: 'NVIDIA A40',
  RTX_3090: 'NVIDIA GeForce RTX 3090',
} as const;

export type GpuType = (typeof GPU_TYPES)[keyof typeof GPU_TYPES];

/** GPU types organized by architecture generation */
export const GPU_ARCHITECTURES = {
  BLACKWELL: [GPU_TYPES.RTX_5090],
  ADA: [GPU_TYPES.RTX_4090, GPU_TYPES.L40S],
  AMPERE: [GPU_TYPES.RTX_3090, GPU_TYPES.RTX_A6000, GPU_TYPES.RTX_A5000, GPU_TYPES.A40],
} as const;

// ── AI Provider IDs ─────────────────────────────────────────────────────────

export const PROVIDER_IDS = {
  GROQ: 'groq',
  OPENAI: 'openai',
  FIREWORKS: 'fireworks',
  OPENROUTER: 'openrouter',
  MODAL: 'modal',
  SELF_HOSTED: 'self-hosted',
} as const;

export type ProviderId = (typeof PROVIDER_IDS)[keyof typeof PROVIDER_IDS];

// ── GPU Provider IDs ────────────────────────────────────────────────────────

export const GPU_PROVIDER_IDS = {
  RUNPOD: 'runpod',
  VAST: 'vast',
  TENSORDOCK: 'tensordock',
  MODAL: 'modal',
  SKYPILOT: 'skypilot',
} as const;

// ── Model Names (common defaults) ───────────────────────────────────────────

export const MODELS = {
  // STT
  WHISPER_LARGE_V3: 'whisper-large-v3',
  WHISPER_LARGE_V3_TURBO: 'whisper-large-v3-turbo',

  // LLM (Groq)
  LLAMA_3_3_70B: 'llama-3.3-70b-versatile',
  LLAMA_3_1_8B: 'llama-3.1-8b-instant',
  LLAMA_4_SCOUT: 'meta-llama/llama-4-scout-17b-16e-instruct',

  // TTS (Groq/CanopyLabs)
  ORPHEUS_ENGLISH: 'canopylabs/orpheus-v1-english',
  ORPHEUS_ARABIC: 'canopylabs/orpheus-arabic-saudi',
} as const;

// ── Pipeline Stages ─────────────────────────────────────────────────────────

export const PIPELINE_STAGES = {
  STT: 'stt',
  LLM: 'llm',
  TTS: 'tts',
} as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[keyof typeof PIPELINE_STAGES];

// ── HTTP Status Codes ───────────────────────────────────────────────────────

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  GONE: 410,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

// ── Autoscaler Defaults ─────────────────────────────────────────────────────

export const AUTOSCALER = {
  IDLE_TIMEOUT_MIN: 15,
  IDLE_DESTROY_HOURS: 2,
  HEALTH_CHECK_INTERVAL_MS: 30_000,
  BOOT_COOLDOWN_BASE_MS: 2 * 60_000, // 2 min
  BOOT_COOLDOWN_MAX_MS: 15 * 60_000, // 15 min
  MAX_BOOT_FAILURES: 5,
  WATCHDOG_INTERVAL_MS: 60_000,
  COST_CHECK_INTERVAL_MS: 5 * 60_000,
} as const;

// ── Docker Images ───────────────────────────────────────────────────────────

export const DOCKER_IMAGES = {
  BABELCAST_SUBTITLE: 'marcosremar/babelcast-subtitle',
  BABELCAST_SUBTITLE_LATEST: 'marcosremar/babelcast-subtitle:latest',
  BABELCAST_SUBTITLE_BLACKWELL: 'marcosremar/babelcast-subtitle:blackwell',
  BABELCAST_MISTRAL: 'marcosremar/babelcast-mistral',
  ULTRAVOX_S2S_LATEST: 'marcosremar/ai-gateway-dockers:latest',
  ULTRAVOX_S2S_BLACKWELL: 'marcosremar/ai-gateway-dockers:blackwell',
} as const;

// ── Download Tuning ─────────────────────────────────────────────────────────

export const DOWNLOAD = {
  HF_XET_HIGH_PERFORMANCE: '1',
  HF_XET_FIXED_DOWNLOAD_CONCURRENCY: 50,
  MAX_IMAGE_SIZE_GB: 20,
  MODEL_DOWNLOAD_TIMEOUT_MS: 5 * 60_000, // 5 min
} as const;

// ── Proxy Defaults ──────────────────────────────────────────────────────────

export const PROXY = {
  MAX_BODY_SIZE: 100 * 1024 * 1024, // 100MB
  BODY_READ_TIMEOUT_MS: 30_000, // 30s
  DEFAULT_PORT: 4000,
  DEFAULT_HOSTNAME: '0.0.0.0',
  COALESCE_STALE_MS: 30_000,
} as const;

// ── Security Defaults ───────────────────────────────────────────────────────

export const SECURITY = {
  RATE_LIMIT_RPM_DEFAULT: 0, // disabled
  TOKEN_EXPIRY_MS: 24 * 60 * 60 * 1000, // 24h
  MAX_REQUEST_SIZE_MB: 100,
} as const;

// ── Language Codes (common) ─────────────────────────────────────────────────

export const LANGUAGES = {
  EN: 'en',
  FR: 'fr',
  ES: 'es',
  DE: 'de',
  PT: 'pt',
  AR: 'ar',
  ZH: 'zh',
  JA: 'ja',
  KO: 'ko',
  HI: 'hi',
} as const;
