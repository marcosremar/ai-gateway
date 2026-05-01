/**
 * Centralized configuration module for AI Gateway.
 *
 * All config is loaded from env vars with validation and defaults.
 * Single source of truth — no scattered process.env reads.
 *
 * @example
 * ```ts
 * import { getConfig } from './config';
 * const config = getConfig();
 * console.log(config.port, config.groqApiKey);
 * ```
 */

import { z } from 'zod';
import { createLogger } from '../logger';

const log = createLogger('config');

// ── Schema ───────────────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  // Server
  port: z.coerce.number().int().positive().default(4000),
  hostname: z.string().default('0.0.0.0'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // Auth
  gatewayApiKeys: z
    .string()
    .optional()
    .transform(
      (v) =>
        v
          ?.split(',')
          .map((k) => k.trim())
          .filter(Boolean) ?? [],
    ),
  rbacRoles: z.string().optional(),

  // Providers
  groqApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  fireworksApiKey: z.string().optional(),
  openrouterApiKey: z.string().optional(),
  modalApiKey: z.string().optional(),

  // GPU Providers
  runpodApiKey: z.string().optional(),
  vastApiKey: z.string().optional(),
  hyperstackApiKey: z.string().optional(),
  tensordockApiKey: z.string().optional(),
  tensordockAuthId: z.string().optional(),

  // Rate Limiting
  rateLimitRpm: z.coerce.number().int().min(0).default(0),

  // Timeouts
  proxyBodyReadTimeoutMs: z.coerce.number().int().positive().default(30_000),
  proxyTotalTimeoutMs: z.coerce.number().int().positive().default(60_000),

  // GPU Autoscaler
  idleTimeoutMin: z.coerce.number().int().positive().default(15),
  idleDestroyHours: z.coerce.number().int().positive().default(2),

  // Docker
  dockerhubUsername: z.string().optional(),
  dockerhubToken: z.string().optional(),

  // Profiling
  profile: z.coerce.boolean().default(false),

  // Next.js Dev
  nextDevUrl: z.string().optional(),

  // Static Dir
  staticDir: z.string().optional(),

  // Logging
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type GatewayConfig = z.infer<typeof ConfigSchema>;

// ── Singleton ────────────────────────────────────────────────────────────────

let cachedConfig: GatewayConfig | null = null;

/**
 * Load and validate configuration from environment variables.
 * Cached after first call.
 */
export function getConfig(): GatewayConfig {
  if (cachedConfig) return cachedConfig;

  const raw = {
    port: process.env.PORT,
    hostname: process.env.HOSTNAME,
    nodeEnv: process.env.NODE_ENV,
    gatewayApiKeys: process.env.GATEWAY_API_KEYS,
    rbacRoles: process.env.RBAC_ROLES,
    groqApiKey: process.env.GROQ_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    fireworksApiKey: process.env.FIREWORKS_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    modalApiKey: process.env.MODAL_API_KEY,
    runpodApiKey: process.env.RUNPOD_API_KEY,
    vastApiKey: process.env.VAST_API_KEY,
    hyperstackApiKey: process.env.HYPERSTACK_API_KEY,
    tensordockApiKey: process.env.TENSORDOCK_API_KEY,
    tensordockAuthId: process.env.TENSORDOCK_AUTH_ID,
    rateLimitRpm: process.env.RATE_LIMIT_RPM,
    proxyBodyReadTimeoutMs: process.env.PROXY_BODY_READ_TIMEOUT_MS,
    proxyTotalTimeoutMs: process.env.PROXY_TOTAL_TIMEOUT_MS,
    idleTimeoutMin: process.env.IDLE_TIMEOUT_MIN,
    idleDestroyHours: process.env.IDLE_DESTROY_HOURS,
    dockerhubUsername: process.env.DOCKERHUB_USERNAME,
    dockerhubToken: process.env.DOCKERHUB_TOKEN,
    profile: process.env.PROFILE,
    nextDevUrl: process.env.NEXT_DEV_URL,
    staticDir: process.env.STATIC_DIR,
    logLevel: process.env.LOG_LEVEL,
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    log.log({ errors }, 'Configuration validation failed');
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  cachedConfig = result.data;

  // Log non-sensitive config at startup
  log.log(
    {
      port: cachedConfig.port,
      nodeEnv: cachedConfig.nodeEnv,
      apiKeys: cachedConfig.gatewayApiKeys.length,
      rateLimitRpm: cachedConfig.rateLimitRpm || 'disabled',
      providers: getEnabledProviders(cachedConfig),
    },
    'Configuration loaded',
  );

  return cachedConfig;
}

/**
 * Reset cached config (useful for testing).
 */
export function resetConfig(): void {
  cachedConfig = null;
}

function getEnabledProviders(config: GatewayConfig): string[] {
  const providers: string[] = [];
  if (config.groqApiKey) providers.push('groq');
  if (config.openaiApiKey) providers.push('openai');
  if (config.fireworksApiKey) providers.push('fireworks');
  if (config.openrouterApiKey) providers.push('openrouter');
  if (config.modalApiKey) providers.push('modal');
  if (config.hyperstackApiKey) providers.push('hyperstack');
  return providers;
}

/**
 * Check if a specific provider is configured.
 */
export function isProviderEnabled(providerId: string): boolean {
  const config = getConfig();
  const keyMap: Record<string, string | undefined> = {
    groq: config.groqApiKey,
    openai: config.openaiApiKey,
    fireworks: config.fireworksApiKey,
    openrouter: config.openrouterApiKey,
    modal: config.modalApiKey,
    hyperstack: config.hyperstackApiKey,
  };
  return !!keyMap[providerId];
}
