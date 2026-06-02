import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ActiveProviderCooldown {
  provider: string;
  untilMs: number;
  remainSec: number;
  failCount: number;
}

export type ActiveProviderCooldowns = Record<string, ActiveProviderCooldown>;

interface RawCooldownEntry {
  cooldownUntilMs?: unknown;
  cooldownUntil?: unknown;
  coolUntil?: unknown;
  until?: unknown;
  failCount?: unknown;
  failures?: unknown;
  failureCount?: unknown;
}

export function normalizeProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

export function parseProviderList(provider?: string, providers?: string[]): string[] {
  const raw = providers && providers.length > 0 ? providers : provider ? [provider] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    for (const part of String(item).split(',')) {
      const name = normalizeProviderName(part);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
}

export function parseActiveProviderCooldowns(raw: unknown, now = Date.now()): ActiveProviderCooldowns {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const active: ActiveProviderCooldowns = {};
  for (const [rawProvider, rawEntry] of Object.entries(raw as Record<string, RawCooldownEntry>)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const provider = normalizeProviderName(rawProvider);
    const untilMs = numeric(
      rawEntry.cooldownUntilMs
        ?? rawEntry.cooldownUntil
        ?? rawEntry.coolUntil
        ?? rawEntry.until,
    );
    if (!Number.isFinite(untilMs) || untilMs <= now) continue;
    const failCount = numeric(rawEntry.failCount ?? rawEntry.failureCount ?? rawEntry.failures);
    active[provider] = {
      provider,
      untilMs,
      remainSec: Math.max(0, Math.ceil((untilMs - now) / 1000)),
      failCount: Number.isFinite(failCount) ? Math.max(0, Math.floor(failCount)) : 0,
    };
  }
  return active;
}

export function defaultProviderCooldownsPath(home = homedir()): string {
  return join(home || '/tmp', '.ai-gateway', 'cooldowns.json');
}

export function legacyProviderCooldownsPath(home = homedir()): string {
  return join(home || '/tmp', '.babelcast', 'cooldowns.json');
}

export function readActiveProviderCooldowns(filePath = defaultProviderCooldownsPath(), now = Date.now()): ActiveProviderCooldowns {
  const actualPath = filePath === defaultProviderCooldownsPath() && !existsSync(filePath)
    ? legacyProviderCooldownsPath()
    : filePath;
  try {
    return parseActiveProviderCooldowns(JSON.parse(readFileSync(actualPath, 'utf-8')), now);
  } catch {
    return {};
  }
}

export function formatCooldownSeconds(sec: number): string {
  if (sec >= 3600) return `${Math.ceil(sec / 3600)}h`;
  if (sec >= 60) return `${Math.ceil(sec / 60)}m`;
  return `${Math.max(1, Math.ceil(sec))}s`;
}

export function formatProviderCooldown(cooldown: ActiveProviderCooldown): string {
  const failSuffix = cooldown.failCount > 0 ? `, failCount=${cooldown.failCount}` : '';
  return `${cooldown.provider} ${formatCooldownSeconds(cooldown.remainSec)} left${failSuffix}`;
}
