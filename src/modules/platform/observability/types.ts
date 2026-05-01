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

export interface PipelineMetrics {
  requestId: string;
  pipeline: 'speech' | 'tts' | 'stt';
  totalLatencyMs: number;
  ttfcMs?: number;        // Time To First Content (transcript)
  ttfaMs?: number;        // Time To First Audio (first audio chunk)
  stages: {
    stt?: { latencyMs: number; provider: string; success: boolean; ttfcMs?: number };
    llm?: { latencyMs: number; provider: string; success: boolean };
    tts?: { latencyMs: number; provider: string; success: boolean; ttfacMs?: number; ttfaMs?: number };
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
