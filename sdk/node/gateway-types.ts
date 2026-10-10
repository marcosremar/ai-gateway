/**
 * Public types of GatewayClient (gateway-client.ts) — the client of the CURRENT gateway API (`serve.ts`).
 *
 * Wire shapes mirror the server (src/gateway/proxy/routes/*, src/s2s/*, src/deployments/*); gateway-contract.ts checks
 * the mirrors against the server types at compile time. Deployment types are imported as types only (types.ts is a
 * pure type module), so nothing of the server ships with the client.
 */

import type { DeploymentSpec, DeploymentView, ProfileSpec } from '../../src/deployments/types';

export type { DeploymentSpec, DeploymentView, ReplicaView } from '../../src/deployments/types';

/** Timeout groups; each call may override with its own `timeoutMs`. */
export type TimeoutGroup = 'stt' | 'chat' | 'tts' | 's2s' | 'admin' | 'health';

export interface DirectFallbackOptions {
  /** App whose fallback plan is used (`GET /v1/apps/:app/fallback`). */
  app: string;
  enabled?: boolean;
  /** Consecutive gateway-unreachable failures before the gateway is skipped. Default 3. */
  failureThreshold?: number;
  /** How long the gateway is skipped once the breaker opened. Default 30 000 ms. */
  cooldownMs?: number;
  /**
   * A gateway call that takes longer than this counts as gateway instability: it is logged (`slow`) and counts
   * toward `failureThreshold`, so persistent slowness opens the breaker and routes calls direct. 0 = only hard
   * failures count. Default 0. (To abandon a slow call mid-flight, use `timeoutMs` — a timeout already goes direct.)
   */
  slowMs?: number;
}

// ── Instability reporting ───────────────────────────────────────────────────

/** One observation of the gateway's health, recorded by GatewayClient and posted back once it recovers. */
export interface InstabilityEvent {
  /** epoch ms of the observation. */
  at: number;
  kind: 'unreachable' | 'slow' | 'direct' | 'direct_failed' | 'recovered' | 'breaker_open';
  /** Gateway path that suffered (`/v1/chat/completions`, …). */
  path?: string;
  /** Error code (`network`, `timeout`, `http_502`, `breaker_open`, …). */
  code?: string;
  route?: GatewayRoute;
  latencyMs?: number;
  detail?: string;
}

export interface InstabilityOptions {
  /** Reported as `client` — the service this SDK instance serves (default 'gateway-client'). */
  client?: string;
  /** Buffered events kept in memory (oldest dropped). Default 500. */
  bufferSize?: number;
  /**
   * POST the buffered events to `POST /v1/apps/:app/stability-report` automatically once the gateway answers
   * again (the app comes from `directFallback.app`, else `app`). Default true. Off = the app reads
   * `instabilityEvents()` / calls `reportInstabilities()` itself.
   */
  report?: boolean;
}

/** The part of `fetch` the client uses (the global fetch, undici's, a test fake…). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GatewayClientOptions {
  /** e.g. `https://gateway.example.com` (no trailing `/v1`). */
  baseUrl: string;
  /** Gateway API key (Bearer). Optional only for a keyless localhost gateway. */
  apiKey?: string;
  /** Sends `X-App` (an admin key acting for an app). */
  app?: string;
  /** Injected fetch (tests, custom agents). Default: the global fetch. */
  fetch?: FetchLike;
  /** Per-group defaults, in ms (0 = none). */
  timeoutMs?: Partial<Record<TimeoutGroup, number>>;
  /** Server-side clients only: call the same models on the providers directly while the gateway is unreachable. */
  directFallback?: DirectFallbackOptions;
  /** Buffer gateway-instability events and report them back once the gateway recovers. */
  instability?: InstabilityOptions;
  /** The route of a direct-capable call changed (gateway ↔ direct). */
  onRouteChange?: (change: RouteChange) => void;
  /** Clock (tests). */
  now?: () => number;
}

export const GATEWAY_CLIENT_TIMEOUTS: Record<TimeoutGroup, number> = {
  // The gateway answers (or 503s) within its 8 s stage budget; margin on top (docs/api/http.md § Time budget).
  stt: 15_000, chat: 15_000, tts: 15_000,
  // Above the gateway's own S2S_BUDGET_MS (45 s).
  s2s: 50_000,
  admin: 30_000, health: 10_000,
};

export interface CallOptions {
  /** The caller's own signal: when it aborts, the call rejects with `signal.reason` (an AbortError by default). */
  signal?: AbortSignal;
  /** Overrides the group default. For streamed results it bounds the wait for the response headers only. */
  timeoutMs?: number;
  device?: string;
}

/** Where an answer came from (`X-Gateway-Provider` / `-Fallback` / `-Fallback-From`), null when absent. */
export interface Served {
  provider: string | null;
  fallback: string | null;
  fallbackFrom: string | null;
}

// ── OpenAI-compatible ───────────────────────────────────────────────────────

export interface TranscribeRequest extends CallOptions {
  file: Blob | Uint8Array;
  filename?: string;
  model: string;
  language?: string;
  prompt?: string;
  responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  /** `false` = QA: skip the hallucination filter (gateway: multipart `filter_hallucinations`; direct fallback: local filter). */
  filterHallucinations?: boolean;
}

export interface Transcription {
  text: string;
  served: Served;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | (string & {});
  content: string | Array<{ type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ChatRequest extends CallOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  seed?: number;
  response_format?: { type: 'json_object' | 'text' | (string & {}); [key: string]: unknown };
  stream_options?: { include_usage?: boolean };
  /** Extra body fields, merged into the JSON body as-is. */
  extraBody?: Record<string, unknown>;
}

export interface ChatUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }

export interface ChatCompletion {
  id: string;
  object: 'chat.completion' | (string & {});
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string | null; [key: string]: unknown }; finish_reason: string | null }>;
  usage?: ChatUsage;
  served: Served;
}

/** A streamed chat answer: iterate it for content deltas. Headers (and so `served`) are known before the first delta. */
export interface ChatStream extends AsyncIterable<string> {
  readonly served: Served;
  /** Set once the stream ended, when the provider reported them. */
  readonly finishReason: string | null;
  readonly usage: ChatUsage | null;
  /** Stops reading and closes the connection (the gateway stops the upstream generation). */
  cancel(): Promise<void>;
}

export interface SpeechRequest extends CallOptions {
  model: string;
  input: string;
  voice: string;
  /** Voice for a fallback provider that does not know `voice` (e.g. Kokoro `pf_dora`). */
  fallback_voice?: string;
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
  language?: string;
  stream?: boolean;
  /** Self-hosted targets also get task_type, ref_audio (inline data: URI only), ref_text, language, stream_format and instructions; other fields are dropped. */
  [key: string]: unknown;
}

export interface SpeechResult {
  /** The audio as it arrives (wav/pcm are streamed end to end); never buffered by the client. */
  body: ReadableStream<Uint8Array>;
  contentType: string;
  served: Served;
}

// ── Speech-to-speech ────────────────────────────────────────────────────────

/** Mirror of src/s2s/composite.ts `S2SConfig`. */
export interface S2SConfig {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
  /** `{{transcript}}` is replaced by what was heard. */
  user_template?: string;
  language?: string;
  voice?: string;
  fallback_voice?: string;
  speak_field?: string;
  response_format?: { type: string };
  max_tokens?: number;
  temperature?: number;
  stt_prompt?: string;
  deployment?: string;
  models?: { stt?: string; chat?: string; tts?: string };
}

export interface S2SRequest extends CallOptions {
  file: Blob | Uint8Array;
  filename?: string;
  config: S2SConfig;
}

type Origin = { provider?: string | null; fallback?: string | null };
export type S2SEvent =
  | { type: 'route'; provider: string; fallback?: string | null; from?: string }
  | ({ type: 'transcript'; text: string; stt_ms?: number; at_ms?: number } & Origin)
  | ({ type: 'llm_first_token'; at_ms: number } & Origin)
  | { type: 'sentence'; text: string; cut_at_ms?: number }
  | { type: 'audio_format'; encoding: string; sample_rate?: number; provider?: string | null }
  | ({ type: 'first_audio'; at_ms: number } & Origin)
  | { type: 'sentence_failed'; text: string; message: string }
  | { type: 'error'; message: string; stage?: string; partial?: boolean; at_ms?: number }
  | {
    type: 'done'; reply?: string; transcript: string | null; first_audio_ms?: number | null; total_ms: number; stt_ms?: number;
    reply_raw?: string; missing_audio?: number; partial?: boolean; empty?: boolean;
  };

export type S2SFrame = { kind: 'event'; event: S2SEvent } | { kind: 'audio'; pcm: Uint8Array };

export interface S2SStream extends AsyncIterable<S2SFrame> {
  /** Stops reading and closes the connection (the gateway aborts the turn). */
  cancel(): Promise<void>;
}

// ── Deployments and apps ────────────────────────────────────────────────────

/** `PUT /v1/deployments/:name` body: spec fields and/or a profile or a saved app image. */
export type DeploymentPutBody = Partial<Omit<DeploymentSpec, 'name'>> & {
  profile?: string;
  appImage?: string;
  appImageVersion?: number;
};

export interface DeploymentList {
  namespace: string;
  health: { deployments: number; replicas: number; listError: string | null };
  deployments: DeploymentView[];
}

export interface Profile { name: string; spec: ProfileSpec; builtin: boolean }

/** Mirror of src/config/serve-providers.ts `RouteEntrySpec` / `ModelRoutesSpec`. */
export interface RouteEntrySpec {
  provider: string;
  model?: string;
  voice?: string;
  fixedVoice?: boolean;
  deployment?: string;
  extraBody?: Record<string, unknown>;
}
export type ModelRoutesSpec = Partial<Record<'chat' | 'stt' | 'tts', Record<string, Array<RouteEntrySpec | string>>>>;

/** Mirror of src/deployments/apps.ts `AppImage`. */
export interface AppImage {
  name: string;
  image: string;
  digest: string | null;
  port: number | null;
  healthPath: string | null;
  description: string | null;
  defaults: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  history: Array<{ image: string; digest: string | null; at: number }>;
}

export interface AppView {
  id: string;
  createdAt: number | null;
  images: AppImage[];
  deployments: Array<{ name: string; status: DeploymentView['status']; appImage: string | null }>;
}

export interface HealthReport { status: string; [key: string]: unknown }

// ── Direct fallback ─────────────────────────────────────────────────────────

/** Mirror of src/deployments/app-fallback.ts `FallbackPlan`. */
export interface FallbackCredential {
  baseUrl: string;
  apiKey: string;
  keyKind: 'provisioned' | 'shared';
  expiresAt: string | null;
  limitUsd: number | null;
}
export interface FallbackEntry {
  provider: string;
  model: string;
  voice?: string;
  fixedVoice?: boolean;
  extraBody?: Record<string, unknown>;
}
export interface FallbackPlan {
  app: string;
  issuedAt: string;
  ttlSeconds: number;
  providers: Partial<Record<string, FallbackCredential>>;
  openrouter: FallbackCredential | null;
  routes: Record<'stt' | 'chat' | 'tts', Record<string, FallbackEntry[]>>;
}

export type GatewayRoute = 'gateway' | 'direct';

export interface RouteChange {
  route: GatewayRoute;
  /** e.g. `network`, `timeout`, `http_502`, `breaker_open`, `recovered`. */
  reason: string;
}

export interface GatewayState {
  /** closed = gateway used; open = skipped until `openUntil`; probing = a /health probe is in flight. */
  breaker: 'closed' | 'open' | 'probing';
  /** Route of the last direct-capable call. */
  route: GatewayRoute;
  consecutiveFailures: number;
  openUntil: number | null;
  lastError: string | null;
  /** A plan is in memory (its age does not matter while the gateway is down). */
  planLoaded: boolean;
}
