/**
 * Secrets rotation — hot-reload API keys and credentials without restart.
 *
 * Watches a secrets file (or env vars) and updates the in-memory config
 * on change. Providers can subscribe to reload events.
 *
 * @example
 * ```ts
 * const rotator = createSecretsRotator('.env');
 * await rotator.start();
 * rotator.onChange((newSecrets) => {
 *   console.log('GROQ_API_KEY changed, reloading provider...');
 *   groqProvider.updateKey(newSecrets.GROQ_API_KEY);
 * });
 * ```
 */

import { watch, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createLogger } from '../logger';

const log = createLogger('secrets-rotation');

export interface SecretsStore {
  get(key: string): string | undefined;
  getAll(): Record<string, string>;
  set(key: string, value: string): void;
  load?(): Promise<void>;
}

/**
 * File-based secrets store that watches a .env-style file.
 */
export class FileSecretsStore implements SecretsStore {
  private secrets = new Map<string, string>();

  constructor(private readonly filePath: string) {}

  get(key: string): string | undefined {
    return this.secrets.get(key);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.secrets.entries());
  }

  set(key: string, value: string): void {
    this.secrets.set(key, value);
  }

  /** Load secrets from file */
  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      log.warn(`Secrets file not found: ${this.filePath}`);
      return;
    }

    const content = await readFile(this.filePath, 'utf-8');
    const newSecrets = new Map<string, string>();

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      newSecrets.set(key, value);
    }

    // Detect changes
    const changedKeys: string[] = [];
    for (const [key, value] of newSecrets) {
      if (this.secrets.get(key) !== value) {
        changedKeys.push(key);
      }
    }

    this.secrets = newSecrets;

    if (changedKeys.length > 0) {
      log.log(
        { keys: changedKeys.map((k) => `${k.slice(0, 4)}***`), count: changedKeys.length },
        'Secrets reloaded',
      );
    }
  }
}

/**
 * Env-based secrets store (reads from process.env).
 */
export class EnvSecretsStore implements SecretsStore {
  get(key: string): string | undefined {
    return process.env[key];
  }

  getAll(): Record<string, string> {
    return { ...process.env } as Record<string, string>;
  }

  set(_key: string, _value: string): void {
    throw new Error('EnvSecretsStore is read-only — use FileSecretsStore for file-based rotation');
  }
}

export interface RotationOptions {
  /** Poll interval in ms (default: 30s) */
  pollIntervalMs?: number;
  /** Called when secrets change */
  onChange?: (newSecrets: Record<string, string>, changedKeys: string[]) => void;
}

const DEFAULT_ROTATION_OPTIONS: Required<RotationOptions> = {
  pollIntervalMs: 30_000,
  onChange: () => {},
};

/**
 * Watch a secrets store and trigger callbacks on change.
 */
export class SecretsRotator {
  private readonly store: SecretsStore;
  private readonly options: Required<RotationOptions>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastKnownHash = '';

  constructor(store: SecretsStore, options: RotationOptions = {}) {
    this.store = store;
    this.options = { ...DEFAULT_ROTATION_OPTIONS, ...options };
  }

  /** Start watching for changes */
  async start(): Promise<void> {
    if (this.store.load) {
      await this.store.load();
    }

    this.interval = setInterval(async () => {
      await this.poll();
    }, this.options.pollIntervalMs);

    this.interval.unref();
    log.log({}, 'Secrets rotation started');
  }

  /** Stop watching */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      log.log({}, 'Secrets rotation stopped');
    }
  }

  /** Register a change callback */
  onChange(fn: (newSecrets: Record<string, string>, changedKeys: string[]) => void): void {
    this.options.onChange = fn;
  }

  /** Poll for changes */
  private async poll(): Promise<void> {
    if (this.store.load) {
      await this.store.load();
    }

    const currentHash = JSON.stringify(this.store.getAll());
    if (currentHash !== this.lastKnownHash) {
      const changedKeys = this.detectChanges(this.lastKnownHash, currentHash);
      this.lastKnownHash = currentHash;
      this.options.onChange(this.store.getAll(), changedKeys);
    }
  }

  private detectChanges(oldHash: string, newHash: string): string[] {
    // Simple detection — compare full state
    // In production, you'd track per-key hashes
    return oldHash === '' ? Object.keys(this.store.getAll()) : ['*'];
  }
}

/**
 * Create a secrets rotator from a file path.
 */
export function createFileSecretsRotator(
  filePath: string,
  options?: RotationOptions,
): SecretsRotator {
  const store = new FileSecretsStore(filePath);
  return new SecretsRotator(store, options);
}

/**
 * Create a secrets rotator from process.env (for hot-reload scenarios).
 */
export function createEnvSecretsRotator(options?: RotationOptions): SecretsRotator {
  const store = new EnvSecretsStore();
  return new SecretsRotator(store, options);
}
