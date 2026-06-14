// ── BabelCast Gateway — Cooldown & Credit-Block Persistence ─────────────────
// Persists provider cooldown and credit-block state to ~/.babelcast/cooldowns.json
// so they survive gateway restarts. Without this, a restarted gateway immediately
// hammers providers that were previously failing or out of credits.

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, fsyncSync, closeSync, renameSync } from 'fs';
import { defaultCooldownTracker } from '../src/providers/fallback';
import { defaultCreditBlockTracker } from '../src/providers/credit-block';
import { createLogger } from '../src/logger';

const log = createLogger('cooldown-persistence');

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
      log.log('Persisted state too old (>10min), ignoring');
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
      log.log(`Loaded ${loaded} persisted entries from ${COOLDOWNS_FILE}`);
    }
  } catch (err) {
    log.warn('Failed to load persisted state:', err instanceof Error ? err.message : err);
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
    // #702: a bare writeFileSync left a half-written (invalid-JSON) cooldowns
    // file on a crash mid-write; loadCooldownState then silently falls back and
    // re-hammers rate-limited/credit-exhausted providers (defeating ADR-009).
    // Write tmp → fsync → rename so the file is always valid on disk.
    atomicWriteSyncWithFsync(COOLDOWNS_FILE, JSON.stringify(data, null, 2));
    log.log(`Saved ${totalEntries} entries to ${COOLDOWNS_FILE}`);
  } catch (err) {
    log.warn('Failed to save state:', err instanceof Error ? err.message : err);
  }
}

/**
 * Crash-safe synchronous write: tmp file → fsync(data) → rename → fsync(dir).
 * Directory fsync is best-effort (unsupported on some platforms) and never
 * blocks the rename's atomicity.
 */
function atomicWriteSyncWithFsync(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  try {
    const dirFd = openSync(BABELCAST_DIR, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* best-effort dir fsync */ }
}
