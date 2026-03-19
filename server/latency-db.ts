/**
 * Persistent SQLite store for per-host TCP latency measurements.
 * DB: ~/.babelcast/latency.db
 *
 * Schema:
 *   host_latency         — one row per host, rolling stats from last 24 probes
 *   host_latency_history — raw probe results, pruned to HISTORY_SIZE per host
 */

import { Database } from 'bun:sqlite';
import os from 'os';
import path from 'path';
import fs from 'fs';

const DB_PATH    = path.join(os.homedir(), '.babelcast', 'latency.db');
const HISTORY_SIZE = 24;

// Adaptive probe intervals
export const INTERVAL_STABLE_MS    = 2  * 3600_000; // 2h  — stable host
export const INTERVAL_UNSTABLE_MS  = 30 * 60_000;   // 30m — high variance
export const INTERVAL_FAILING_MS   = 6  * 3600_000; // 6h  — 3+ failures
const STDDEV_UNSTABLE_MS = 20;                       // ms threshold for "unstable"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HostLatencyRow {
  host_id:              string;
  host_ip:              string;
  provider:             string;
  gpu_name:             string;
  geolocation:          string;
  price_usd:            number;
  direct_port:          number | null;
  median_ms:            number | null;
  p90_ms:               number | null;
  stddev_ms:            number | null;
  success_rate:         number;
  last_probed_at:       number;
  probe_count:          number;
  consecutive_failures: number;
  monitored:            number; // 1 = monitored (default), 0 = excluded from scheduler
}

export interface HostMeta {
  hostIp:       string;
  provider:     string;
  gpuName:      string;
  geolocation:  string;
  priceUsd:     number;
  directPort?:  number;
}

export interface ProbeResult {
  medianMs: number | null;
  p90Ms:    number | null;
  samples:  number;
}

// ── DB init ───────────────────────────────────────────────────────────────────

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS host_latency (
      host_id              TEXT PRIMARY KEY,
      host_ip              TEXT NOT NULL,
      provider             TEXT NOT NULL DEFAULT '',
      gpu_name             TEXT NOT NULL DEFAULT '',
      geolocation          TEXT NOT NULL DEFAULT '',
      price_usd            REAL NOT NULL DEFAULT 0,
      direct_port          INTEGER,
      median_ms            REAL,
      p90_ms               REAL,
      stddev_ms            REAL,
      success_rate         REAL NOT NULL DEFAULT 1.0,
      last_probed_at       INTEGER NOT NULL DEFAULT 0,
      probe_count          INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      monitored            INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS host_latency_history (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id   TEXT NOT NULL,
      probed_at INTEGER NOT NULL,
      median_ms REAL,
      p90_ms    REAL,
      samples   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_history_host
      ON host_latency_history (host_id, probed_at DESC);
  `);

  // Migrate: add monitored column to existing DBs that predate it
  try {
    _db.exec('ALTER TABLE host_latency ADD COLUMN monitored INTEGER NOT NULL DEFAULT 1');
  } catch { /* column already exists — ignore */ }

  return _db;
}

// ── Rolling stats ─────────────────────────────────────────────────────────────

function computeStats(values: number[]): { median: number; p90: number; stddev: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n      = sorted.length;
  const median = sorted[Math.floor(n / 2)];
  const p90    = sorted[Math.min(Math.ceil(n * 0.9) - 1, n - 1)];
  const mean   = values.reduce((a, b) => a + b, 0) / n;
  const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  return { median, p90, stddev: Math.round(stddev * 10) / 10 };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upsert host metadata from a fresh offer listing.
 * Called whenever we see a host in an offer response — keeps metadata current.
 */
export function upsertHostMeta(hostId: string, meta: HostMeta): void {
  getDb().prepare(`
    INSERT INTO host_latency (host_id, host_ip, provider, gpu_name, geolocation, price_usd, direct_port)
    VALUES ($hostId, $hostIp, $provider, $gpuName, $geolocation, $priceUsd, $directPort)
    ON CONFLICT(host_id) DO UPDATE SET
      host_ip     = excluded.host_ip,
      provider    = excluded.provider,
      gpu_name    = excluded.gpu_name,
      geolocation = excluded.geolocation,
      price_usd   = excluded.price_usd,
      direct_port = excluded.direct_port
  `).run({
    $hostId:      hostId,
    $hostIp:      meta.hostIp,
    $provider:    meta.provider,
    $gpuName:     meta.gpuName,
    $geolocation: meta.geolocation,
    $priceUsd:    meta.priceUsd,
    $directPort:  meta.directPort ?? null,
  });
}

/**
 * Save a probe result, update rolling median/p90/stddev in host_latency.
 * Also prunes history to the last HISTORY_SIZE entries per host.
 */
export function saveProbeResult(hostId: string, result: ProbeResult, now = Date.now()): void {
  const db = getDb();

  // 1. Append history
  db.prepare(`
    INSERT INTO host_latency_history (host_id, probed_at, median_ms, p90_ms, samples)
    VALUES ($hostId, $probedAt, $medianMs, $p90Ms, $samples)
  `).run({
    $hostId:   hostId,
    $probedAt: now,
    $medianMs: result.medianMs,
    $p90Ms:    result.p90Ms,
    $samples:  result.samples,
  });

  // 2. Prune to last HISTORY_SIZE entries
  db.prepare(`
    DELETE FROM host_latency_history
    WHERE host_id = $hostId AND id NOT IN (
      SELECT id FROM host_latency_history
      WHERE host_id = $hostId
      ORDER BY probed_at DESC
      LIMIT $limit
    )
  `).run({ $hostId: hostId, $limit: HISTORY_SIZE });

  // 3. Compute rolling stats from successful probes in history window
  const history = db.prepare(`
    SELECT median_ms FROM host_latency_history
    WHERE host_id = $hostId AND median_ms IS NOT NULL
    ORDER BY probed_at DESC LIMIT $limit
  `).all({ $hostId: hostId, $limit: HISTORY_SIZE }) as Array<{ median_ms: number }>;

  const totalInWindow = (db.prepare(`
    SELECT COUNT(*) as n FROM host_latency_history
    WHERE host_id = $hostId ORDER BY probed_at DESC LIMIT $limit
  `).get({ $hostId: hostId, $limit: HISTORY_SIZE }) as { n: number }).n;

  const medians     = history.map(r => r.median_ms);
  const successRate = totalInWindow > 0 ? medians.length / totalInWindow : 1;
  const stats       = medians.length > 0 ? computeStats(medians) : null;

  // 4. Update host_latency
  db.prepare(`
    UPDATE host_latency SET
      median_ms            = $medianMs,
      p90_ms               = $p90Ms,
      stddev_ms            = $stddevMs,
      success_rate         = $successRate,
      last_probed_at       = $lastProbedAt,
      probe_count          = probe_count + 1,
      consecutive_failures = CASE WHEN $samples > 0 THEN 0 ELSE consecutive_failures + 1 END
    WHERE host_id = $hostId
  `).run({
    $hostId:       hostId,
    $medianMs:     stats?.median  ?? null,
    $p90Ms:        stats?.p90     ?? null,
    $stddevMs:     stats?.stddev  ?? null,
    $successRate:  successRate,
    $lastProbedAt: now,
    $samples:      result.samples,
  });
}

/**
 * Returns hosts that need probing based on adaptive intervals:
 *   - 3+ consecutive failures → retry every 6h
 *   - stddev > 20ms (unstable) → every 30min
 *   - default                  → stableIntervalMs (user-configured, default 2h)
 */
export function getHostsToProbe(now = Date.now(), stableIntervalMs = INTERVAL_STABLE_MS): HostLatencyRow[] {
  return getDb().prepare(`
    SELECT * FROM host_latency WHERE monitored = 1 AND (
      (consecutive_failures >= 3
        AND last_probed_at < $failCutoff)
      OR
      (consecutive_failures < 3 AND stddev_ms IS NOT NULL AND stddev_ms > $stddevThreshold
        AND last_probed_at < $unstableCutoff)
      OR
      (consecutive_failures < 3 AND (stddev_ms IS NULL OR stddev_ms <= $stddevThreshold)
        AND last_probed_at < $stableCutoff)
    )
  `).all({
    $failCutoff:      now - INTERVAL_FAILING_MS,
    $stddevThreshold: STDDEV_UNSTABLE_MS,
    $unstableCutoff:  now - INTERVAL_UNSTABLE_MS,
    $stableCutoff:    now - stableIntervalMs,
  }) as HostLatencyRow[];
}

/**
 * Set monitored flag for a list of hosts (or all hosts if hostIds is empty).
 * monitored=true  → include in scheduler probe cycles
 * monitored=false → skip in scheduler (data kept, just not re-probed)
 */
export function setHostsMonitored(hostIds: string[], monitored: boolean): void {
  const db  = getDb();
  const val = monitored ? 1 : 0;
  if (hostIds.length === 0) {
    db.prepare('UPDATE host_latency SET monitored = $val').run({ $val: val });
  } else {
    const stmt = db.prepare('UPDATE host_latency SET monitored = $val WHERE host_id = $id');
    const tx   = db.transaction(() => {
      for (const id of hostIds) stmt.run({ $val: val, $id: id });
    });
    tx();
  }
}

/**
 * Build { hostId → median_ms } for the given host IDs.
 * Only returns entries with a fresh probe (< maxAgeMs) and < 3 consecutive failures.
 */
export function getHostRttMap(hostIds: string[], maxAgeMs = INTERVAL_STABLE_MS): Record<string, number> {
  if (hostIds.length === 0) return {};
  const cutoff = Date.now() - maxAgeMs;
  const all = getDb().prepare(`
    SELECT host_id, median_ms FROM host_latency
    WHERE median_ms IS NOT NULL
      AND last_probed_at > $cutoff
      AND consecutive_failures < 3
  `).all({ $cutoff: cutoff }) as Array<{ host_id: string; median_ms: number }>;

  const idSet = new Set(hostIds);
  const map: Record<string, number> = {};
  for (const r of all) {
    if (idSet.has(r.host_id)) map[r.host_id] = r.median_ms;
  }
  return map;
}

/** All rows sorted by median_ms ASC (nulls last). Used for display / ranking. */
export function getAllHostLatencies(): HostLatencyRow[] {
  return getDb().prepare(
    'SELECT * FROM host_latency ORDER BY CASE WHEN median_ms IS NULL THEN 1 ELSE 0 END, median_ms ASC'
  ).all() as HostLatencyRow[];
}

/**
 * Sort gpuTypes by best known TCP latency from the DB.
 * Order: good (any host ≤ thresholdMs) → unknown (no data) → allBad (all > threshold).
 * If thresholdMs is 0 the list is returned unchanged (filter disabled).
 */
export function sortGpuTypesByLatency(gpuTypes: string[], thresholdMs: number): string[] {
  if (thresholdMs <= 0 || gpuTypes.length === 0) return gpuTypes;

  const db = getDb();
  const good: string[]    = [];
  const unknown: string[] = [];
  const allBad: string[]  = [];

  for (const gpuType of gpuTypes) {
    // Extract model name without vendor prefix for LIKE match
    const model = gpuType.replace(/nvidia\s*/gi, '').replace(/geforce\s*/gi, '').trim();

    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN median_ms IS NOT NULL AND consecutive_failures < 3 THEN 1 ELSE 0 END) as with_data,
        MIN(CASE WHEN consecutive_failures < 3 THEN median_ms ELSE NULL END) as best_ms
      FROM host_latency
      WHERE gpu_name LIKE $pattern
    `).get({ $pattern: `%${model}%` }) as { with_data: number; best_ms: number | null };

    if (!row || row.with_data === 0) {
      unknown.push(gpuType); // no data → allow, don't block deploy
    } else if (row.best_ms !== null && row.best_ms <= thresholdMs) {
      good.push(gpuType);
    } else {
      allBad.push(gpuType);
    }
  }

  if (allBad.length > 0) {
    const names = allBad.map(g => g.replace(/nvidia\s*/gi, '').replace(/geforce\s*/gi, '').trim());
    console.log(`[latency] GPU types deprioritised (all hosts > ${thresholdMs}ms): ${names.join(', ')}`);
  }

  return [...good, ...unknown, ...allBad];
}

/**
 * Returns the best measured latency + region per GPU model name (normalized).
 * Useful for enriching GPU type listings with real latency data.
 * Keys are lowercased model names without vendor prefix (e.g. "rtx 4090").
 */
export function getBestLatencyByGpuModel(): Record<string, { bestMs: number; region: string }> {
  const rows = getDb().prepare(`
    SELECT h.gpu_name, h.median_ms AS best_ms, h.geolocation AS best_region
    FROM host_latency h
    INNER JOIN (
      SELECT gpu_name, MIN(median_ms) AS min_ms
      FROM host_latency
      WHERE median_ms IS NOT NULL AND consecutive_failures < 3
      GROUP BY gpu_name
    ) m ON h.gpu_name = m.gpu_name AND h.median_ms = m.min_ms
    WHERE h.consecutive_failures < 3
    GROUP BY h.gpu_name
  `).all() as Array<{ gpu_name: string; best_ms: number; best_region: string }>;

  const result: Record<string, { bestMs: number; region: string }> = {};
  for (const row of rows) {
    // Normalize: strip NVIDIA/GeForce/RTX prefix variants, lowercase for matching
    const key = row.gpu_name.replace(/nvidia\s*/gi, '').replace(/geforce\s*/gi, '').trim().toLowerCase();
    if (!result[key] || row.best_ms < result[key].bestMs) {
      result[key] = { bestMs: Math.round(row.best_ms), region: row.best_region };
    }
  }
  return result;
}

/** Diagnostic counters. */
export function getLatencyDbStats(): {
  totalHosts:     number;
  monitoredHosts: number;
  probedInLast2h: number;
  unstable:       number;
  failing:        number;
  historyRows:    number;
} {
  const db     = getDb();
  const now    = Date.now();
  const cut2h  = now - INTERVAL_STABLE_MS;

  const total     = (db.prepare('SELECT COUNT(*) as n FROM host_latency').get() as { n: number }).n;
  const monitored = (db.prepare('SELECT COUNT(*) as n FROM host_latency WHERE monitored = 1').get() as { n: number }).n;
  const recent    = (db.prepare('SELECT COUNT(*) as n FROM host_latency WHERE last_probed_at > $c').get({ $c: cut2h }) as { n: number }).n;
  const unstable  = (db.prepare('SELECT COUNT(*) as n FROM host_latency WHERE stddev_ms > 20 AND consecutive_failures < 3').get() as { n: number }).n;
  const failing   = (db.prepare('SELECT COUNT(*) as n FROM host_latency WHERE consecutive_failures >= 3').get() as { n: number }).n;
  const hist      = (db.prepare('SELECT COUNT(*) as n FROM host_latency_history').get() as { n: number }).n;

  return { totalHosts: total, monitoredHosts: monitored, probedInLast2h: recent, unstable, failing, historyRows: hist };
}
