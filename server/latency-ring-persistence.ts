// ── BabelCast Gateway — Latency Ring Buffer Persistence ─────────────────────
// Persists the in-memory latency ring buffer to ~/.babelcast/latency-ring.json
// so percentile metrics survive gateway restarts.

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { latencyRing, latencyRingIdx, setLatencyRingIdx, LATENCY_RING_SIZE } from './state';

const BABELCAST_DIR = join(homedir(), '.babelcast');
const RING_FILE = join(BABELCAST_DIR, 'latency-ring.json');

interface PersistedRing {
  ring: number[];
  idx: number;
  savedAt: number;
}

/**
 * Load persisted latency ring buffer from disk.
 * Call at gateway startup (non-blocking, after server starts).
 */
export function loadLatencyRing(): void {
  try {
    if (!existsSync(RING_FILE)) return;
    const raw = readFileSync(RING_FILE, 'utf-8');
    const data = JSON.parse(raw) as PersistedRing;

    // Reject if too old (>24 hours — stale latency data is misleading)
    if (Date.now() - data.savedAt > 24 * 60 * 60 * 1000) {
      console.log('[latency-ring] Persisted data too old (>24h), ignoring');
      return;
    }

    if (!Array.isArray(data.ring) || data.ring.length === 0) return;

    // Restore ring buffer contents (cap to LATENCY_RING_SIZE)
    const entries = data.ring.slice(0, LATENCY_RING_SIZE);
    latencyRing.length = 0;
    for (const v of entries) {
      if (typeof v === 'number' && isFinite(v)) {
        latencyRing.push(v);
      }
    }

    const idx = typeof data.idx === 'number' ? data.idx % Math.max(1, latencyRing.length) : 0;
    setLatencyRingIdx(idx);

    console.log(`[latency-ring] Loaded ${latencyRing.length} samples from ${RING_FILE}`);
  } catch (err) {
    console.warn('[latency-ring] Failed to load persisted ring:', err instanceof Error ? err.message : err);
  }
}

/**
 * Save current latency ring buffer to disk.
 * Call on gateway shutdown (SIGTERM/SIGINT).
 */
export function saveLatencyRing(): void {
  try {
    if (latencyRing.length === 0) return; // nothing to persist

    const data: PersistedRing = {
      ring: [...latencyRing],
      idx: latencyRingIdx,
      savedAt: Date.now(),
    };

    mkdirSync(BABELCAST_DIR, { recursive: true });
    writeFileSync(RING_FILE, JSON.stringify(data));
    console.log(`[latency-ring] Saved ${latencyRing.length} samples to ${RING_FILE}`);
  } catch (err) {
    console.warn('[latency-ring] Failed to save ring:', err instanceof Error ? err.message : err);
  }
}
