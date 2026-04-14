/**
 * One-time startup migration: SQLite latency.db → Neon (Prisma).
 *
 * Reads existing data from ~/.babelcast/latency.db (if present) and inserts
 * it into the new HostLatency / HostLatencyHistory tables in Neon.
 * Renames the file to latency.db.migrated after a successful import so it
 * won't be processed again.
 *
 * Safe to call on every startup — exits immediately if the file is missing or
 * already migrated.
 */

import { existsSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { prisma } from './state';
import { createLogger } from '../src/logger';

const log = createLogger('latency-db-migrate');

const DB_PATH      = join(homedir(), '.babelcast', 'latency.db');
const DONE_MARKER  = DB_PATH + '.migrated';

interface SqliteHostRow {
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
  monitored:            number; // 1 / 0
}

interface SqliteHistoryRow {
  id:        number;
  host_id:   string;
  probed_at: number;
  median_ms: number | null;
  p90_ms:    number | null;
  samples:   number;
}

export async function migrateLatencyDbIfNeeded(): Promise<void> {
  if (!existsSync(DB_PATH) || existsSync(DONE_MARKER)) return;

  log.log('Found legacy SQLite latency.db — migrating to Neon...');

  let hostRows: SqliteHostRow[]        = [];
  let historyRows: SqliteHistoryRow[]  = [];

  try {
    // Dynamic import so this doesn't fail on environments without bun:sqlite
    const { Database } = await import('bun:sqlite' as string);
    const db = new Database(DB_PATH, { readonly: true });
    hostRows    = db.query('SELECT * FROM host_latency').all()     as SqliteHostRow[];
    historyRows = db.query('SELECT * FROM host_latency_history').all() as SqliteHistoryRow[];
    db.close();
  } catch (err) {
    log.warn('Could not read SQLite DB (bun:sqlite unavailable or corrupt):', err instanceof Error ? err.message : err);
    return;
  }

  log.log(`Importing ${hostRows.length} hosts, ${historyRows.length} history rows...`);

  let hostsDone    = 0;
  let historyDone  = 0;
  let hostsSkipped = 0;

  for (const row of hostRows) {
    try {
      await prisma.hostLatency.upsert({
        where: { hostId: row.host_id },
        update: {
          hostIp:             row.host_ip,
          provider:           row.provider,
          gpuName:            row.gpu_name,
          geolocation:        row.geolocation,
          priceUsd:           row.price_usd,
          directPort:         row.direct_port,
          medianMs:           row.median_ms,
          p90Ms:              row.p90_ms,
          stddevMs:           row.stddev_ms,
          successRate:        row.success_rate,
          lastProbedAt:       BigInt(row.last_probed_at),
          probeCount:         row.probe_count,
          consecutiveFailures: row.consecutive_failures,
          monitored:          row.monitored === 1,
        },
        create: {
          hostId:             row.host_id,
          hostIp:             row.host_ip,
          provider:           row.provider,
          gpuName:            row.gpu_name,
          geolocation:        row.geolocation,
          priceUsd:           row.price_usd,
          directPort:         row.direct_port,
          medianMs:           row.median_ms,
          p90Ms:              row.p90_ms,
          stddevMs:           row.stddev_ms,
          successRate:        row.success_rate,
          lastProbedAt:       BigInt(row.last_probed_at),
          probeCount:         row.probe_count,
          consecutiveFailures: row.consecutive_failures,
          monitored:          row.monitored === 1,
        },
      });
      hostsDone++;
    } catch (err) {
      hostsSkipped++;
      log.warn(`Skipped host ${row.host_id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Insert history rows for hosts that were successfully migrated
  const migratedHostIds = new Set(hostRows.slice(0, hostsDone).map(r => r.host_id));
  for (const row of historyRows) {
    if (!migratedHostIds.has(row.host_id)) continue;
    try {
      await prisma.hostLatencyHistory.create({
        data: {
          hostId:   row.host_id,
          probedAt: BigInt(row.probed_at),
          medianMs: row.median_ms,
          p90Ms:    row.p90_ms,
          samples:  row.samples,
        },
      });
      historyDone++;
    } catch {
      // ignore duplicate or constraint errors on history
    }
  }

  log.log(`Done: ${hostsDone} hosts (${hostsSkipped} skipped), ${historyDone} history rows imported.`);

  // Mark as migrated
  try {
    renameSync(DB_PATH, DONE_MARKER);
    log.log('SQLite file renamed to latency.db.migrated');
  } catch (err) {
    log.warn('Could not rename SQLite file:', err instanceof Error ? err.message : err);
  }
}
