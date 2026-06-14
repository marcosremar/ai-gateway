/**
 * Lazy provider loader — defers provider initialization until first use.
 *
 * Reduces startup time and memory by only loading providers that are
 * actually needed. Each provider is loaded once and cached.
 *
 * @example
 * ```ts
 * const loader = createLazyProviderLoader();
 *
 * // Provider not loaded yet
 * loader.isLoaded('groq-stt'); // false
 *
 * // First use triggers load
 * const stt = await loader.getProvider('groq-stt');
 *
 * // Subsequent uses return cached instance
 * loader.isLoaded('groq-stt'); // true
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('lazy-provider');

/** Factory function that creates a provider instance */
export type ProviderFactory<T> = () => Promise<T>;

/** Provider loader instance */
export interface LazyProvider<T = unknown> {
  /** Get the provider instance (loads on first call) */
  get(): Promise<T>;
  /** Check if the provider is already loaded */
  isLoaded(): boolean;
  /** Unload the provider (clears cache) */
  unload(): void;
  /** Time when provider was first loaded */
  loadedAt?: number;
}

/**
 * Create a lazy provider instance.
 *
 * @param factory async factory that constructs the provider
 * @param name    explicit display name for logs (#395). Arrow-function and
 *   minified factories have an empty `.name`, which made load logs read
 *   "Lazy-loading provider undefined"; pass a name to get readable logs.
 *   Falls back to `factory.name` then `'anonymous'`.
 */
export function createLazyProvider<T>(factory: ProviderFactory<T>, name?: string): LazyProvider<T> {
  let instance: T | null = null;
  let loadPromise: Promise<T> | null = null;
  let loadedAt: number | undefined;
  const label = name || factory.name || 'anonymous';

  return {
    async get(): Promise<T> {
      if (instance) return instance;

      if (loadPromise) return loadPromise;

      log.log({ provider: label }, 'Lazy-loading provider');
      const start = Date.now();

      loadPromise = factory()
        .then((result) => {
          instance = result;
          loadPromise = null;
          loadedAt = Date.now();
          log.log({ provider: label, loadMs: Date.now() - start }, 'Provider loaded');
          return result;
        })
        .catch((err) => {
          loadPromise = null;
          throw err;
        });

      return loadPromise;
    },

    isLoaded(): boolean {
      return instance !== null;
    },

    unload(): void {
      instance = null;
      loadPromise = null;
      loadedAt = undefined;
      log.log({ provider: label }, 'Provider unloaded');
    },

    get loadedAt() {
      return loadedAt;
    },
  };
}

/**
 * Registry of lazy providers.
 */
export class LazyProviderRegistry {
  private providers = new Map<string, LazyProvider>();

  /** Register a provider factory. The registry `name` is also used as the
   *  lazy-loader log label so logs stay readable for arrow-function factories (#395). */
  register<T>(name: string, factory: ProviderFactory<T>): void {
    this.providers.set(name, createLazyProvider(factory, name));
  }

  /** Register an already-created provider */
  registerInstance<T>(name: string, instance: T): void {
    this.providers.set(name, {
      get: () => Promise.resolve(instance),
      isLoaded: () => true,
      unload: () => {},
      loadedAt: Date.now(),
    });
  }

  /** Get a provider by name */
  async get<T>(name: string): Promise<T> {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider not registered: ${name}`);
    }
    return provider.get() as Promise<T>;
  }

  /** Check if a provider is loaded */
  isLoaded(name: string): boolean {
    const provider = this.providers.get(name);
    return provider?.isLoaded() ?? false;
  }

  /** Unload a provider */
  unload(name: string): void {
    const provider = this.providers.get(name);
    provider?.unload();
  }

  /** Get all registered provider names */
  names(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Get status of all providers */
  status(): Array<{ name: string; loaded: boolean; loadedAt?: number }> {
    return this.names().map((name) => {
      const provider = this.providers.get(name)!;
      return {
        name,
        loaded: provider.isLoaded(),
        loadedAt: provider.loadedAt,
      };
    });
  }

  /** Unload all providers */
  unloadAll(): void {
    for (const provider of this.providers.values()) {
      provider.unload();
    }
  }
}

/**
 * Create a new lazy provider registry.
 */
export function createLazyProviderLoader(): LazyProviderRegistry {
  return new LazyProviderRegistry();
}
