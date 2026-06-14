/**
 * Observability types.
 */

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string; // default https://cloud.langfuse.com
}

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  events?: string[];       // filter to specific hook names
  batchSize?: number;      // default 10
  flushIntervalMs?: number; // default 5000
}

export interface ObservabilityConfig {
  langfuse?: LangfuseConfig;
  webhooks?: WebhookConfig[];
  console?: boolean;
  distributedTracing?: boolean;
}

// Distributed Tracing types
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  startTime: number;
  ttfcMs?: number;        // Time To First Content (transcript)
  ttfaMs?: number;        // Time To First Audio (first audio chunk)
  tags: Record<string, any>;
  events: TraceEvent[];
}

export interface TraceEvent {
  timestamp: number;
  name: string;
  attributes: Record<string, any>;
}

/**
 * Per-stage metrics carried on a PipelineMetrics. Token counts and cost are
 * optional so existing callers stay valid (#565) — when present, the tracer
 * stamps them onto the stage span for per-trace cost attribution in
 * Tempo/Jaeger.
 */
export interface StageMetrics {
  latencyMs: number;
  provider: string;
  success: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface PipelineMetrics {
  requestId: string;
  pipeline: 'speech' | 'tts' | 'stt';
  totalLatencyMs: number;
  ttfcMs?: number;        // Time To First Content (transcript)
  ttfaMs?: number;        // Time To First Audio (first audio chunk)
  stages: {
    stt?: StageMetrics & { ttfcMs?: number };
    llm?: StageMetrics;
    tts?: StageMetrics & { ttfacMs?: number; ttfaMs?: number };
  };
  routing: {
    decision: string;
    confidence: number;
    reason: string;
    costEstimate: number;
  };
  input: {
    audioBytes: number;
    estimatedDurationSec: number;
  };
  output: {
    transcriptionLength: number;
    responseLength: number;
    audioBytes?: number;
  };
}
