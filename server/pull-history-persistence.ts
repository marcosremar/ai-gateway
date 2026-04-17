// ── BabelCast Gateway — Pull Time Estimator History Persistence ─────────────
// Persists the in-memory pull history (from src/gateway/providers/gpu/pull-time-estimator)
// to ~/.babelcast/pull-history.json so primary deploys after a gateway restart
// reuse the adaptive-timeout knowledge from previous runs. Without this, every
// first pull post-restart falls back to the conservative 30-min default timeout.
//
// Pattern: mirrors `cooldown-persistence.ts` (ADR-009). Debounced 10s write,
// atomic (tmp + rename), crash-safe. Host owns all fs access — `src/` stays
// framework-free (the estimator just exposes toJSON/fromJSON + a persist hook).

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'fs';
import {
  toJSON as pullHistoryToJSON,
  fromJSON as pullHistoryFromJSON,
  setPullHistoryPersistHook,
  getHistorySize,
} from '../src/gpu-providers/pull-time-estimator';
import { createLogger } from '../src/logger';

const log = createLogger('pull-history-persistence');

const BABELCAST_DIR = join(homedir(), '.babelcast');
const PULL_HISTORY_FILE = join(BABELCAST_DIR, 'pull-history.json');

// Debounce interval — matches daily_spend.json / stampAppRequest (10s).
const WRITE_DEBOUNCE_MS = 10_000;

interface PersistedPullHistory {
  records: ReturnType<typeof pullHistoryToJSON>;
  savedAt: number;
}

let _writeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Load persisted pull history from disk on startup.
 * Should be called before any deploy attempts. Safe to call multiple times.
 *
 * Unlike cooldowns, pull-history entries are long-lived (timeouts benefit from
 * weeks of data), so we do NOT expire based on savedAt.
 */
export function loadPullHistory(): void {
  try {
    if (!existsSync(PULL_HISTORY_FILE)) return;
    const raw = readFileSync(PULL_HISTORY_FILE, 'utf-8');
    const data = JSON.parse(raw) as PersistedPullHistory;
    const loaded = pullHistoryFromJSON(data.records);
    if (loaded > 0) {
      log.log(`Loaded ${loaded} pull history records from ${PULL_HISTORY_FILE}`);
    }
  } catch (err) {
    // Corrupt/missing file is non-fatal — a fresh history will accumulate.
    log.warn('Failed to load pull history:', err instanceof Error ? err.message : err);
  }
}

/**
 * Flush the current pull history to disk. Atomic (tmp + rename).
 * Called by `schedulePullHistoryWrite` (debounced) and on shutdown.
 */
export function savePullHistoryNow(): void {
  try {
    const records = pullHistoryToJSON();
    if (records.length === 0) return; // nothing to persist
    mkdirSync(BABELCAST_DIR, { recursive: true });
    const data: PersistedPullHistory = { records, savedAt: Date.now() };
    const tmp = PULL_HISTORY_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, PULL_HISTORY_FILE);
    log.log(`Saved ${records.length} pull history records to ${PULL_HISTORY_FILE}`);
  } catch (err) {
    log.warn('Failed to save pull history:', err instanceof Error ? err.message : err);
  }
}

/**
 * Schedule a debounced write. Multiple calls inside the 10s window coalesce
 * into a single disk write. Mirrors the `stampAppRequest` pattern.
 */
export function schedulePullHistoryWrite(): void {
  if (_writeTimer) return; // already scheduled
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    savePullHistoryNow();
  }, WRITE_DEBOUNCE_MS);
  // Allow process to exit even if timer is pending.
  if (typeof (_writeTimer as unknown as { unref?: () => void }).unref === 'function') {
    (_writeTimer as unknown as { unref: () => void }).unref();
  }
}

/**
 * Wire the estimator → persistence bridge. Call once on gateway startup,
 * AFTER loadPullHistory() to avoid an immediate no-op write.
 */
export function initPullHistoryPersistence(): void {
  loadPullHistory();
  setPullHistoryPersistHook(schedulePullHistoryWrite);
  const size = getHistorySize();
  if (size > 0) {
    log.log(`Pull history persistence wired — ${size} record(s) in memory`);
  }
}

// Expose internals for tests (not part of the public server API surface).
export const __testing = {
  PULL_HISTORY_FILE,
  WRITE_DEBOUNCE_MS,
};
