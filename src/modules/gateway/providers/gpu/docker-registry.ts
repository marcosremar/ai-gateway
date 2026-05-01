/**
 * GPU Service Registry — Adapter to register GPU endpoints as AI providers
 *
 * Fetches Docker manifests from GPU endpoints and registers them
 * in the AIProviderRegistry for use in the inference pipeline.
 */

import type { AIProviderRegistry } from '../cloud/registry';
import type {
  DockerManifest,
  DockerCapability,
  DockerApiEndpoint
} from './docker-manifest';
import { validateManifest, getLatencyTarget } from './docker-manifest';
import { createLogger } from '../../../logger';

const log = createLogger('docker-registry');

/** Maps service capabilities to provider interface methods */
const CAPABILITY_TO_METHOD: Record<DockerCapability, string> = {
  stt: 'transcribe',
  llm: 'translate',
  tts: 'speak',
  image: 'generateImage',
  embedding: 'embed',
  rerank: 'rerank',
  speech_pipeline: 'pipeline',
  openai_compat: 'openaiCompatible',
  glb_generation: 'generateGlb',
  motion_generation: 'generateMotion',
};

/**
 * Fetches Docker manifest from a GPU endpoint
 * Tries /v1/manifest first, falls back to /health for basic info
 */
export async function fetchDockerManifest(
  endpoint: string,
  timeoutMs: number = 5000
): Promise<DockerManifest | null> {
  try {
    // Try /v1/manifest first
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${endpoint}/v1/manifest`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.log(`Manifest endpoint not available at ${endpoint}: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (validateManifest(data)) {
      log.log(`✓ Docker manifest fetched from ${endpoint}: ${data.name} v${data.version} (${data.capabilities.join(', ')})`);
      return data;
    } else {
      log.warn(`Invalid manifest structure from ${endpoint}`);
      return null;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.log(`Manifest fetch failed from ${endpoint}: ${errorMsg}`);
    return null;
  }
}

/**
 * Creates STT provider from Docker manifest
 */
function createManifestSTTProvider(
  manifest: DockerManifest,
  endpoint: string,
  api: DockerApiEndpoint
) {
  return {
    id: `${manifest.id}-stt`,
    name: `${manifest.name} STT`,

    async transcribe(audio: Buffer, options?: {
      language?: string;
      prompt?: string;
      hotwords?: string[];
      wordTimestamps?: boolean;
    }): Promise<{ text: string; language?: string; confidence?: number }> {
      const formData = new FormData();
      // Convert Buffer to regular ArrayBuffer for Blob compatibility
      const audioBytes = new Uint8Array(audio);
      formData.append('file', new Blob([audioBytes.buffer], { type: 'audio/wav' }), 'audio.wav');
      if (api.model) formData.append('model', api.model);
      if (options?.language) formData.append('language', options.language);
      if (options?.prompt) formData.append('prompt', options.prompt);

      const response = await fetch(`${endpoint}${api.endpoint}`, {
        method: api.method ?? 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`STT request failed: HTTP ${response.status}`);
      }

      const result = await response.json();
      return {
        text: result.text ?? result.transcription ?? '',
        language: result.language,
        confidence: result.confidence ?? result.language_probability,
      };
    },
  };
}

/**
 * Creates LLM provider from Docker manifest
 */
function createManifestLLMProvider(
  manifest: DockerManifest,
  endpoint: string,
  api: DockerApiEndpoint
) {
  return {
    id: `${manifest.id}-llm`,
    name: `${manifest.name} LLM`,

    async translate(
      text: string,
      sourceLang: string,
      targetLang: string,
      options?: { glossary?: string[]; context?: string }
    ): Promise<{ text: string; model?: string; tokens?: number }> {
      const body: Record<string, unknown> = {
        text,
        source_lang: sourceLang,
        target_lang: targetLang,
      };

      if (api.model) body.model = api.model;
      if (options?.glossary) body.glossary = options.glossary;
      if (options?.context) body.context = options.context;

      // Support both translation-specific and chat completion formats
      if (api.type === 'translation' || api.endpoint.includes('translate')) {
        const response = await fetch(`${endpoint}${api.endpoint}`, {
          method: api.method ?? 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(`LLM request failed: HTTP ${response.status}`);
        }

        const result = await response.json();
        return {
          text: result.text ?? result.translation ?? result.output ?? '',
          model: result.model ?? api.model,
          tokens: result.tokens ?? result.token_count,
        };
      } else {
        // Chat completion format
        const response = await fetch(`${endpoint}${api.endpoint}`, {
          method: api.method ?? 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: `Translate from ${sourceLang} to ${targetLang}` },
              { role: 'user', content: text },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error(`LLM request failed: HTTP ${response.status}`);
        }

        const result = await response.json();
        return {
          text: result.choices?.[0]?.message?.content ?? result.response ?? '',
          model: result.model ?? api.model,
          tokens: result.usage?.total_tokens,
        };
      }
    },
  };
}

/**
 * Creates TTS provider from Docker manifest
 */
function createManifestTTSProvider(
  manifest: DockerManifest,
  endpoint: string,
  api: DockerApiEndpoint
) {
  return {
    id: `${manifest.id}-tts`,
    name: `${manifest.name} TTS`,

    async speak(
      text: string,
      language: string,
      options?: { voice?: string; speed?: number }
    ): Promise<{ audio: Buffer; format: string }> {
      const body: Record<string, unknown> = {
        input: text,
        language,
      };

      if (api.model) body.model = api.model;
      if (options?.voice) body.voice = options.voice;
      if (options?.speed) body.speed = options.speed;

      const response = await fetch(`${endpoint}${api.endpoint}`, {
        method: api.method ?? 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`TTS request failed: HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') ?? 'audio/wav';

      return {
        audio: Buffer.from(arrayBuffer),
        format: contentType.includes('mp3') ? 'mp3' : 'wav',
      };
    },
  };
}

/**
 * Registers Docker image as an AI provider
 *
 * @param registry - The AIProviderRegistry instance
 * @param manifest - The Docker manifest
 * @param endpoint - The GPU endpoint URL
 * @returns true if registration succeeded
 */
export function registerDockerImageProvider(
  registry: AIProviderRegistry,
  manifest: DockerManifest,
  endpoint: string
): boolean {
  try {
    const capabilities = manifest.capabilities;
    const descriptor: {
      id: string;
      name: string;
      description: string;
      capabilities: DockerCapability[];
      requiresApiKey: boolean;
      stt?: ReturnType<typeof createManifestSTTProvider>;
      llm?: ReturnType<typeof createManifestLLMProvider>;
      tts?: ReturnType<typeof createManifestTTSProvider>;
      metadata?: {
        endpoint: string;
        models: string[];
        latencyTargets: Partial<Record<DockerCapability, number>>;
      };
    } = {
      id: manifest.id,
      name: manifest.name,
      description: `${manifest.name} v${manifest.version} at ${endpoint}`,
      capabilities,
      requiresApiKey: false,
      metadata: {
        endpoint,
        models: manifest.models,
        latencyTargets: Object.fromEntries(
          capabilities.map(cap => [cap, getLatencyTarget(manifest, cap)])
        ) as Partial<Record<DockerCapability, number>>,
      },
    };

    // Create providers for each capability
    if (capabilities.includes('stt') && manifest.api.stt) {
      descriptor.stt = createManifestSTTProvider(manifest, endpoint, manifest.api.stt);
    }

    if (capabilities.includes('llm') && manifest.api.llm) {
      descriptor.llm = createManifestLLMProvider(manifest, endpoint, manifest.api.llm);
    }

    if (capabilities.includes('tts') && manifest.api.tts) {
      descriptor.tts = createManifestTTSProvider(manifest, endpoint, manifest.api.tts);
    }

    // Cast to ProviderDescriptor - GPU providers have dynamic IDs not in the ProviderId union
    registry.register(descriptor as import('../cloud/types').ProviderDescriptor);

    log.log(`✓ GPU service registered as AI provider: ${manifest.id} (${capabilities.join(', ')})`);
    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to register GPU service ${manifest.id}: ${errorMsg}`);
    return false;
  }
}

/**
 * Auto-discovers and registers Docker image as an AI provider
 * Called when a GPU deployment becomes ready
 *
 * @param registry - The AIProviderRegistry instance
 * @param endpoint - The GPU endpoint URL
 * @returns The Docker manifest if discovered, null otherwise
 */
export async function autoRegisterDockerProvider(
  registry: AIProviderRegistry,
  endpoint: string
): Promise<DockerManifest | null> {
  log.log(`Auto-discovering GPU provider at ${endpoint}...`);

  const manifest = await fetchDockerManifest(endpoint);

  if (!manifest) {
    log.log(`No Docker manifest found at ${endpoint}, skipping auto-registration`);
    return null;
  }

  const success = registerDockerImageProvider(registry, manifest, endpoint);

  if (success) {
    return manifest;
  }

  return null;
}
