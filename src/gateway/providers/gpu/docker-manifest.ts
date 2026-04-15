/**
 * Docker Manifest — Self-describing API contract for Docker images
 *
 * Each Docker image exposes GET /v1/manifest to declare its capabilities,
 * allowing automatic registration as an AI provider in the gateway.
 *
 * A Docker image can contain MULTIPLE services (STT, LLM, TTS, etc.)
 *
 * Example manifest:
 * {
 *   "id": "babelcast-subtitle",
 *   "name": "BabelCast Subtitle",
 *   "version": "1.0.0",
 *   "capabilities": ["stt", "llm"],
 *   "api": {
 *     "stt": { "endpoint": "/v1/audio/transcriptions", "method": "POST", "model": "whisper-large-v3" },
 *     "llm": { "endpoint": "/v1/translate/text", "method": "POST", "type": "translation" }
 *   },
 *   "models": ["whisper-large-v3", "translation-gemma-4b"],
 *   "latencyTargets": { "stt": 500, "llm": 1000 }
 * }
 */

/** Capabilities that a Docker image can provide */
export type DockerCapability = 'stt' | 'llm' | 'tts' | 'image' | 'embedding' | 'rerank';

/** API endpoint configuration for a specific capability */
export interface DockerApiEndpoint {
  /** HTTP method (default: POST) */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** API path (relative to base URL) */
  endpoint: string;
  /** Model identifier used by this endpoint */
  model?: string;
  /** Content type (default: application/json) */
  contentType?: string;
  /** Response format (default: json) */
  responseFormat?: 'json' | 'text' | 'stream' | 'binary';
  /** API type (e.g., 'translation' for translation-specific endpoints) */
  type?: string;
  /** Additional metadata for this capability */
  metadata?: Record<string, unknown>;
}

/** Docker Manifest — Describes a Docker image and its services */
export interface DockerManifest {
  /** Unique Docker image identifier (e.g., "babelcast-subtitle") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Services/capabilities this Docker image provides */
  capabilities: DockerCapability[];
  /** API endpoints for each capability/service */
  api: Partial<Record<DockerCapability, DockerApiEndpoint>>;
  /** List of available models in this image */
  models: string[];
  /** Latency targets per service (milliseconds) */
  latencyTargets?: Partial<Record<DockerCapability, number>>;
  /** Health check endpoint (default: /health) */
  healthEndpoint?: string;
  /** Documentation URL */
  docsUrl?: string;
  /** Docker image metadata */
  metadata?: {
    /** GPU requirements */
    gpu?: { minVramGb?: number; recommendedVramGb?: number };
    /** Docker image reference */
    dockerImage?: string;
    /** Author/organization */
    author?: string;
    /** License */
    license?: string;
  };
}

/** Error response when manifest is unavailable */
export interface DockerManifestError {
  error: string;
  code: 'not_found' | 'timeout' | 'invalid' | 'unavailable';
}

/** Validates a Docker manifest structure */
export function validateManifest(manifest: unknown): manifest is DockerManifest {
  if (!manifest || typeof manifest !== 'object') return false;
  const m = manifest as Record<string, unknown>;

  if (typeof m.id !== 'string' || m.id.length === 0) return false;
  if (typeof m.name !== 'string' || m.name.length === 0) return false;
  if (typeof m.version !== 'string') return false;
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) return false;
  if (typeof m.api !== 'object' || m.api === null) return false;
  if (!Array.isArray(m.models)) return false;

  const validCapabilities = ['stt', 'llm', 'tts', 'image', 'embedding', 'rerank'];
  for (const cap of m.capabilities) {
    if (!validCapabilities.includes(cap as string)) return false;
  }

  return true;
}

/** Default latency targets per capability (milliseconds) */
export const DEFAULT_LATENCY_TARGETS: Record<DockerCapability, number> = {
  stt: 500,
  llm: 1000,
  tts: 800,
  image: 5000,
  embedding: 300,
  rerank: 200,
};

/** Get latency target with fallback to default */
export function getLatencyTarget(
  manifest: DockerManifest,
  capability: DockerCapability
): number {
  return manifest.latencyTargets?.[capability] ?? DEFAULT_LATENCY_TARGETS[capability];
}
