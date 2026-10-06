/**
 * Bot / CPU provider chain — ownership filters + credential-based fallback order.
 *
 * Ownership prefixes prevent orphan sweeps from terminating unrelated VMs
 * (e.g. parle-livekit, parle-qwen-tts) that share the same Scaleway/Railway account.
 */

export const BOT_NAME_PREFIXES = ['babelcast-bot', 'aigw-bot'] as const;

export type BotProviderId = 'flyio' | 'railway' | 'scaleway' | 'runpod';

export interface BotProviderChainEntry {
  id: BotProviderId;
  reason: string;
}

/** True when the instance name matches a gateway-owned bot prefix. */
export function isBotOwnedInstance(inst: { instanceName?: string; instanceId: string }): boolean {
  const name = (inst.instanceName || '').trim();
  if (!name) return false;
  return BOT_NAME_PREFIXES.some(
    (prefix) => name === prefix || name.startsWith(`${prefix}-`),
  );
}

const ACTIVE_STATUSES = new Set([
  'running',
  'booting',
  'starting',
  'creating',
  'pending',
  'success', // Railway deploy success
]);

/** True when status is an active/bootable bot lifecycle state. */
export function isBotActiveStatus(status?: string): boolean {
  if (!status) return false;
  return ACTIVE_STATUSES.has(status.toLowerCase());
}

/** Owned bot that is running or still booting — safe orphan-sweep candidate. */
export function isBotCleanupCandidate(inst: {
  instanceName?: string;
  instanceId: string;
  status?: string;
}): boolean {
  return isBotOwnedInstance(inst) && isBotActiveStatus(inst.status);
}

/**
 * Build the CPU/bot provider fallback chain from env credentials.
 * Order: flyio → railway → scaleway → runpod (first available wins at deploy time).
 */
export function selectBotProviderChain(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): BotProviderChainEntry[] {
  const chain: BotProviderChainEntry[] = [];

  if (env.FLY_API_TOKEN || env.BOT_FLY_APP_NAME) {
    chain.push({
      id: 'flyio',
      reason: env.FLY_API_TOKEN ? 'FLY_API_TOKEN set' : 'BOT_FLY_APP_NAME set',
    });
  }

  if (env.RAILWAY_PROJECT_ID) {
    const hasToken = !!(env.RAILWAY_TOKEN || env.RAILWAY_API_TOKEN);
    chain.push({
      id: 'railway',
      reason: hasToken
        ? 'RAILWAY_PROJECT_ID + token set'
        : 'RAILWAY_PROJECT_ID set (CLI auth ok)',
    });
  }

  if (env.SCALEWAY_SECRET_KEY) {
    chain.push({ id: 'scaleway', reason: 'SCALEWAY_SECRET_KEY set' });
  }

  if (env.RUNPOD_API_KEY) {
    chain.push({ id: 'runpod', reason: 'RUNPOD_API_KEY set' });
  }

  return chain;
}

/** Best-effort provider detection from a bot endpoint URL. */
export function detectBotProviderFromEndpoint(endpoint?: string): BotProviderId | null {
  if (!endpoint) return null;
  const e = endpoint.toLowerCase();
  if (e.includes('.fly.dev') || e.includes('fly.local')) return 'flyio';
  if (e.includes('railway.app') || e.includes('railway.internal') || e.includes('up.railway')) return 'railway';
  if (e.includes('runpod.net') || e.includes('runpod.io')) return 'runpod';
  if (e.includes('scw.cloud') || e.includes('scaleway')) return 'scaleway';
  return null;
}
