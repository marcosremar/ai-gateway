// ── BabelCast Gateway — Cooldown & Credit-Block Persistence ─────────────────
// Persists provider cooldown and credit-block state to ~/.babelcast/cooldowns.json
// so they survive gateway restarts. Without this, a restarted gateway immediately
// hammers providers that were previously failing or out of credits.

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { defaultCooldownTracker } from '../src/providers/fallback';
import { defaultCreditBlockTracker } from '../src/providers/credit-block';

const BABELCAST_DIR = join(homedir(), '.babelcast');
const COOLDOWNS_FILE = join(BABELCAST_DIR, 'cooldowns.json');

interface PersistedState {
  cooldowns: Record<string, { failures: number; windowStart: number; coolUntil: number }>;
  creditBlocks: Record<string, number>;
  savedAt: number;
}

/**
 * Load persisted cooldown/credit-block state from disk.
 * Call this at gateway startup, before handling any requests.
 */
export function loadCooldownState(): void {
  try {
    if (!existsSync(COOLDOWNS_FILE)) return;
    const raw = readFileSync(COOLDOWNS_FILE, 'utf-8');
    const data = JSON.parse(raw) as PersistedState;

    // Reject if too old (>10 minutes — all cooldowns would have expired)
    if (Date.now() - data.savedAt > 10 * 60 * 1000) {
      console.log('[cooldowns] Persisted state too old (>10min), ignoring');
      return;
    }

    let loaded = 0;
    if (data.cooldowns && typeof data.cooldowns === 'object') {
      defaultCooldownTracker.fromJSON(data.cooldowns);
      loaded += Object.keys(data.cooldowns).length;
    }
    if (data.creditBlocks && typeof data.creditBlocks === 'object') {
      defaultCreditBlockTracker.fromJSON(data.creditBlocks);
      loaded += Object.keys(data.creditBlocks).length;
    }

    if (loaded > 0) {
      console.log(`[cooldowns] Loaded ${loaded} persisted entries from ${COOLDOWNS_FILE}`);
    }
  } catch (err) {
    console.warn('[cooldowns] Failed to load persisted state:', err instanceof Error ? err.message : err);
  }
}

/**
 * Save current cooldown/credit-block state to disk.
 * Call this on gateway shutdown (SIGTERM/SIGINT).
 */
export function saveCooldownState(): void {
  try {
    const data: PersistedState = {
      cooldowns: defaultCooldownTracker.toJSON(),
      creditBlocks: defaultCreditBlockTracker.toJSON(),
      savedAt: Date.now(),
    };

    const totalEntries = Object.keys(data.cooldowns).length + Object.keys(data.creditBlocks).length;
    if (totalEntries === 0) return; // nothing to persist

    mkdirSync(BABELCAST_DIR, { recursive: true });
    writeFileSync(COOLDOWNS_FILE, JSON.stringify(data, null, 2));
    console.log(`[cooldowns] Saved ${totalEntries} entries to ${COOLDOWNS_FILE}`);
  } catch (err) {
    console.warn('[cooldowns] Failed to save state:', err instanceof Error ? err.message : err);
  }
}
