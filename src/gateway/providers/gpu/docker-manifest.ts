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
 *   "contractVersion": "1.0",
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
export type DockerCapability =
  | 'speech_pipeline'
  | 'openai_compat'
  | 'stt'
  | 'llm'
  | 'tts'
  | 'image'
  | 'embedding'
  | 'rerank'
  | 'glb_generation'
  | 'motion_generation';

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
  /** ai-gateway manifest contract version. Current: "1.0". */
  contractVersion?: string;
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
    /** Immutable image digest, if known */
    imageDigest?: string;
    /** Author/organization */
    author?: string;
    /** License */
    license?: string;
  };
}

export interface DockerContractValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  paths: string[];
}

const VALID_CAPABILITIES: DockerCapability[] = [
  'speech_pipeline',
  'openai_compat',
  'stt',
  'llm',
  'tts',
  'image',
  'embedding',
  'rerank',
  'glb_generation',
  'motion_generation',
];

const DEFAULT_ENDPOINT_BY_CAPABILITY: Partial<Record<DockerCapability, string[]>> = {
  speech_pipeline: ['/v1/audio/transcriptions', '/v1/chat/completions', '/v1/audio/speech'],
  openai_compat: ['/v1/models'],
  stt: ['/v1/audio/transcriptions'],
  llm: ['/v1/chat/completions'],
  tts: ['/v1/audio/speech'],
  image: ['/v1/images/generations'],
  embedding: ['/v1/embeddings'],
  rerank: ['/v1/rerank'],
  glb_generation: ['/generate'],
  motion_generation: ['/generate'],
};

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

  for (const cap of m.capabilities) {
    if (!VALID_CAPABILITIES.includes(cap as DockerCapability)) return false;
  }

  return true;
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export function getManifestApiPaths(manifest: DockerManifest): string[] {
  const paths = new Set<string>();
  for (const endpoint of Object.values(manifest.api)) {
    if (endpoint?.endpoint) paths.add(normalizePath(endpoint.endpoint));
  }
  return [...paths].sort();
}

export function defaultApiPathsForCapabilities(capabilities: readonly DockerCapability[]): string[] {
  const paths = new Set<string>();
  for (const capability of capabilities) {
    for (const path of DEFAULT_ENDPOINT_BY_CAPABILITY[capability] ?? []) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

export function validateDockerContractManifest(
  manifest: unknown,
  expectedCapabilities: readonly DockerCapability[] = [],
  expectedApiPaths: readonly string[] = [],
): DockerContractValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!validateManifest(manifest)) {
    return {
      ok: false,
      errors: ['Invalid /v1/manifest: expected id, name, version, capabilities[], api{}, and models[].'],
      warnings,
      paths: [],
    };
  }

  if (manifest.contractVersion && manifest.contractVersion !== '1.0') {
    warnings.push(`Unknown manifest contractVersion "${manifest.contractVersion}" — expected "1.0".`);
  }

  const caps = new Set(manifest.capabilities);
  for (const cap of expectedCapabilities) {
    if (!caps.has(cap)) errors.push(`Missing capability "${cap}" in /v1/manifest.`);
  }

  const paths = getManifestApiPaths(manifest);
  const pathSet = new Set(paths);
  for (const path of expectedApiPaths.map(normalizePath)) {
    if (!pathSet.has(path)) errors.push(`Missing endpoint "${path}" in /v1/manifest api.`);
  }

  for (const cap of manifest.capabilities) {
    const endpoint = manifest.api[cap];
    if (!endpoint?.endpoint) {
      errors.push(`Capability "${cap}" is declared but api.${cap}.endpoint is missing.`);
      continue;
    }
    if (!endpoint.endpoint.startsWith('/')) {
      errors.push(`api.${cap}.endpoint must start with "/".`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, paths };
}

/** Default latency targets per capability (milliseconds) */
export const DEFAULT_LATENCY_TARGETS: Record<DockerCapability, number> = {
  speech_pipeline: 1500,
  openai_compat: 1000,
  stt: 500,
  llm: 1000,
  tts: 800,
  image: 5000,
  embedding: 300,
  rerank: 200,
  glb_generation: 60_000,
  motion_generation: 60_000,
};

/** Get latency target with fallback to default */
export function getLatencyTarget(
  manifest: DockerManifest,
  capability: DockerCapability
): number {
  return manifest.latencyTargets?.[capability] ?? DEFAULT_LATENCY_TARGETS[capability];
}
