/**
 * AI Provider Registry — instance-based (not singleton).
 * Created by the gateway factory and holds all registered providers.
 */

import type {
  ProviderId,
  ProviderDescriptor,
  STTProvider,
  TTSProvider,
  LLMProvider,
  RealtimeProvider,
  ImageProvider,
  OmniProvider,
  ProviderCapability,
  ModelInfo,
} from './types';
import type { EmbeddingProvider } from './openai-compat/openai-compat-embedding';
import type { RerankProvider } from './rerank/types';

export class AIProviderRegistry {
  private providers = new Map<ProviderId, ProviderDescriptor>();
  private embeddingProviders = new Map<string, EmbeddingProvider>();
  private rerankProviders = new Map<string, RerankProvider>();

  register(descriptor: ProviderDescriptor): void {
    this.providers.set(descriptor.id, descriptor);
  }

  /**
   * Remove a provider so it is no longer routable (#399).
   *
   * Previously there was no way to drop a provider after its API key was
   * removed — the descriptor lingered and calls failed at runtime instead of
   * being skipped by availability checks / fallback. Call this on key removal
   * (e.g. reloadProviderAvailability) for every capability class so the same id
   * is purged from the descriptor, embedding, and rerank maps.
   *
   * @returns true if anything was removed.
   */
  unregister(id: ProviderId): boolean {
    let removed = this.providers.delete(id);
    removed = this.embeddingProviders.delete(id) || removed;
    removed = this.rerankProviders.delete(id) || removed;
    return removed;
  }

  getProvider(id: ProviderId): ProviderDescriptor | undefined {
    return this.providers.get(id);
  }

  getSTTProvider(id: ProviderId): STTProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`[AIProviderRegistry] Provider "${id}" not found`);
    if (!provider.stt) throw new Error(`[AIProviderRegistry] Provider "${id}" does not support STT`);
    return provider.stt;
  }

  getTTSProvider(id: ProviderId): TTSProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`[AIProviderRegistry] Provider "${id}" not found`);
    if (!provider.tts) throw new Error(`[AIProviderRegistry] Provider "${id}" does not support TTS`);
    return provider.tts;
  }

  getLLMProvider(id: ProviderId): LLMProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`[AIProviderRegistry] Provider "${id}" not found`);
    if (!provider.llm) throw new Error(`[AIProviderRegistry] Provider "${id}" does not support LLM`);
    return provider.llm;
  }

  getRealtimeProvider(id: ProviderId): RealtimeProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`[AIProviderRegistry] Provider "${id}" not found`);
    if (!provider.realtime) throw new Error(`[AIProviderRegistry] Provider "${id}" does not support Realtime`);
    return provider.realtime;
  }

  getImageProvider(id: ProviderId): ImageProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`[AIProviderRegistry] Provider "${id}" not found`);
    if (!provider.image) throw new Error(`[AIProviderRegistry] Provider "${id}" does not support Image generation`);
    return provider.image;
  }

  getOmniProvider(id: ProviderId): OmniProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`[AIProviderRegistry] Provider "${id}" not found`);
    if (!provider.omni) throw new Error(`[AIProviderRegistry] Provider "${id}" does not support Omni audio`);
    return provider.omni;
  }

  // ── Embedding ──────────────────────────────────────────────────

  registerEmbeddingProvider(id: string, provider: EmbeddingProvider): void {
    this.embeddingProviders.set(id, provider);
  }

  getEmbeddingProvider(id: string): EmbeddingProvider {
    const provider = this.embeddingProviders.get(id);
    if (!provider) throw new Error(`[AIProviderRegistry] Embedding provider "${id}" not found`);
    return provider;
  }

  listEmbeddingProviders(): EmbeddingProvider[] {
    return [...this.embeddingProviders.values()];
  }

  // ── Reranking ──────────────────────────────────────────────────

  registerRerankProvider(id: string, provider: RerankProvider): void {
    this.rerankProviders.set(id, provider);
  }

  getRerankProvider(id: string): RerankProvider {
    const provider = this.rerankProviders.get(id);
    if (!provider) throw new Error(`[AIProviderRegistry] Rerank provider "${id}" not found`);
    return provider;
  }

  listRerankProviders(): RerankProvider[] {
    return [...this.rerankProviders.values()];
  }

  listProviders(): ProviderDescriptor[] {
    return [...this.providers.values()];
  }

  listProvidersByCapability(capability: ProviderCapability): ProviderDescriptor[] {
    return [...this.providers.values()].filter((p) => p.capabilities.includes(capability));
  }

  getAllModels(capability: ProviderCapability): Array<ModelInfo & { providerId: ProviderId }> {
    const models: Array<ModelInfo & { providerId: ProviderId }> = [];
    for (const provider of this.providers.values()) {
      if (capability === 'stt' && provider.stt) {
        for (const model of provider.stt.getModels()) models.push({ ...model, providerId: provider.id });
      }
      if (capability === 'tts' && provider.tts) {
        for (const model of provider.tts.getModels()) models.push({ ...model, providerId: provider.id });
      }
      if (capability === 'llm' && provider.llm) {
        models.push({ id: provider.id, name: provider.name, description: provider.description, capability: 'llm', providerId: provider.id });
      }
      if (capability === 'realtime' && provider.realtime) {
        for (const model of provider.realtime.getModels()) models.push({ ...model, providerId: provider.id });
      }
      if (capability === 'omni' && provider.omni) {
        for (const model of provider.omni.getModels()) models.push({ ...model, providerId: provider.id });
      }
    }
    return models;
  }

  isProviderReady(id: ProviderId, capability: ProviderCapability): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;
    if (capability === 'stt') return !!provider.stt?.isConfigured();
    if (capability === 'tts') return !!provider.tts?.isConfigured();
    if (capability === 'llm') return !!provider.llm?.isConfigured();
    if (capability === 'realtime') return !!provider.realtime?.isConfigured();
    if (capability === 'image') return !!provider.image?.isConfigured();
    if (capability === 'omni') return !!provider.omni?.isConfigured();
    if (capability === 'embedding') return this.embeddingProviders.has(id);
    if (capability === 'rerank') return this.rerankProviders.has(id);
    return false;
  }
}
