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
}
