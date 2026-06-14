/**
 * Feature Flags — runtime feature toggles.
 *
 * Fixes: #15, #948 (feature flags system)
 *
 * Usage:
 * ```ts
 * import { featureFlags } from './feature-flags';
 *
 * // Check if feature is enabled
 * if (featureFlags.isEnabled('new-speech-pipeline')) {
 *   await runNewPipeline();
 * }
 *
 * // Get flag value
 * const threshold = featureFlags.get('gpu-threshold', 0.5);
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('feature-flags');

export interface FlagDefinition {
  /** Description of the flag */
  description: string;
  /** Default value */
  defaultValue: boolean | number | string;
  /** Allowed values (for enum-style flags) */
  allowedValues?: string[];
  /** Environment override */
  envVar?: string;
}

export interface FlagValue {
  value: boolean | number | string;
  source: 'default' | 'env' | 'runtime' | 'user';
  updatedAt: string;
}

/** Tokens that mean "true" for a boolean flag env override (case-insensitive). */
const TRUTHY_ENV_TOKENS: ReadonlySet<string> = new Set(['true', '1', 'yes', 'on', 'y']);
/** Tokens that mean "false" for a boolean flag env override (case-insensitive). */
const FALSY_ENV_TOKENS: ReadonlySet<string> = new Set(['false', '0', 'no', 'off', 'n', '']);

/**
 * Parse a raw env-var string into the flag's typed value, falling back to the
 * default when the override is unusable. Pure; exported for tests.
 *
 * - boolean: case-insensitive, trimmed; accepts true/1/yes/on and false/0/no/off.
 *   An unrecognized token (e.g. "maybe") falls back to the default rather than
 *   silently coercing to `false` (the old `=== 'true' || === '1'` behavior made
 *   `"TRUE"`/`" true "` read as false).
 * - number: parsed via parseFloat; non-finite values fall back to the default
 *   instead of setting the flag to NaN.
 * - string: used verbatim.
 */
export function parseEnvFlagValue(
  raw: string | undefined,
  defaultValue: boolean | number | string,
): boolean | number | string {
  if (raw === undefined) return defaultValue;

  if (typeof defaultValue === 'boolean') {
    const token = raw.trim().toLowerCase();
    if (TRUTHY_ENV_TOKENS.has(token)) return true;
    if (FALSY_ENV_TOKENS.has(token)) return false;
    return defaultValue;
  }

  if (typeof defaultValue === 'number') {
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }

  return raw;
}

class FeatureFlags {
  private flags = new Map<string, FlagValue>();
  private definitions = new Map<string, FlagDefinition>();
  private listeners = new Map<string, Array<(value: FlagValue) => void>>();

  /**
   * Define a feature flag.
   */
  define(name: string, definition: FlagDefinition): void {
    this.definitions.set(name, definition);

    // Check environment variable
    let value = definition.defaultValue;
    let source: FlagValue['source'] = 'default';

    if (definition.envVar && process.env[definition.envVar] !== undefined) {
      // Robust, type-aware parse: tolerant boolean tokens (TRUE/yes/on/off …),
      // NaN-guarded numbers, verbatim strings — all falling back to the default
      // on an unusable override.
      value = parseEnvFlagValue(process.env[definition.envVar], definition.defaultValue);
      source = 'env';
    }

    this.flags.set(name, {
      value,
      source,
      updatedAt: new Date().toISOString(),
    });

    log.log({ name, value, source }, 'Feature flag defined');
  }

  /**
   * Check if a feature is enabled.
   */
  isEnabled(name: string): boolean {
    const flag = this.flags.get(name);
    if (!flag) {
      const definition = this.definitions.get(name);
      return definition ? Boolean(definition.defaultValue) : false;
    }
    return Boolean(flag.value);
  }

  /**
   * Get flag value with type safety.
   */
  get<T extends boolean | number | string>(name: string, defaultValue: T): T {
    const flag = this.flags.get(name);
    if (!flag) return defaultValue;
    return flag.value as T;
  }

  /**
   * Set flag value at runtime.
   */
  set(name: string, value: boolean | number | string): void {
    const definition = this.definitions.get(name);

    // Validate against allowed values
    if (definition?.allowedValues && typeof value === 'string') {
      if (!definition.allowedValues.includes(value)) {
        throw new Error(
          `Invalid value '${value}' for flag '${name}'. Allowed: ${definition.allowedValues.join(', ')}`,
        );
      }
    }

    const previous = this.flags.get(name);
    this.flags.set(name, {
      value,
      source: 'runtime',
      updatedAt: new Date().toISOString(),
    });

    log.log({ name, previous: previous?.value, value }, 'Feature flag updated');

    // Notify listeners
    const listeners = this.listeners.get(name) ?? [];
    const flagValue = this.flags.get(name)!;
    for (const listener of listeners) {
      try {
        listener(flagValue);
      } catch (error) {
        log.error({ error: error instanceof Error ? error.message : String(error) }, 'Flag listener failed');
      }
    }
  }

  /**
   * Subscribe to flag changes.
   */
  onChange(name: string, listener: (value: FlagValue) => void): void {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, []);
    }
    this.listeners.get(name)!.push(listener);
  }

  /**
   * Get all flags.
   */
  getAll(): Record<string, FlagValue> {
    return Object.fromEntries(this.flags.entries());
  }

  /**
   * Get flag metadata.
   */
  getMetadata(name: string): FlagDefinition | undefined {
    return this.definitions.get(name);
  }

  /**
   * Get all flag names.
   */
  getNames(): string[] {
    return Array.from(this.flags.keys());
  }
}

/**
 * Global feature flags instance.
 */
export const featureFlags = new FeatureFlags();

/**
 * Define standard feature flags for AI Gateway.
 */
export function defineStandardFlags(): void {
  featureFlags.define('use-new-speech-pipeline', {
    description: 'Use the new speech pipeline implementation',
    defaultValue: false,
    envVar: 'USE_NEW_SPEECH_PIPELINE',
  });

  featureFlags.define('enable-gpu-predictive-warmup', {
    description: 'Enable predictive GPU warmup',
    defaultValue: true,
    envVar: 'ENABLE_GPU_PREDICTIVE_WARMUP',
  });

  featureFlags.define('enable-request-coalescing', {
    description: 'Enable request deduplication',
    defaultValue: true,
    envVar: 'ENABLE_REQUEST_COALESCING',
  });

  featureFlags.define('enable-cost-tracking', {
    description: 'Enable per-request cost tracking',
    defaultValue: true,
    envVar: 'ENABLE_COST_TRACKING',
  });

  featureFlags.define('enable-audit-logging', {
    description: 'Enable audit logging',
    defaultValue: true,
    envVar: 'ENABLE_AUDIT_LOGGING',
  });

  featureFlags.define('gpu-threshold', {
    description: 'GPU usage threshold for scaling (0-1)',
    defaultValue: 0.8,
    envVar: 'GPU_THRESHOLD',
  });

  featureFlags.define('max-concurrent-requests', {
    description: 'Maximum concurrent requests per user',
    defaultValue: 10,
    envVar: 'MAX_CONCURRENT_REQUESTS',
  });
}
