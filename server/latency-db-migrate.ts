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

/**
 * Build the Prisma upsert args for one legacy SQLite host row (#726).
 *
 * Pure — extracted so the migration's per-row upsert payload is unit-testable
 * without a DB and so a single `$transaction([upsert,...])` batch can be built
 * from `hostRows.map(buildHostUpsertArgs)` instead of N sequential awaits.
 */
export function buildHostUpsertArgs(row: SqliteHostRow): {
  where: { hostId: string };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
} {
  const fields = {
    hostIp:              row.host_ip,
    provider:            row.provider,
    gpuName:             row.gpu_name,
    geolocation:         row.geolocation,
    priceUsd:            row.price_usd,
    directPort:          row.direct_port,
    medianMs:            row.median_ms,
    p90Ms:               row.p90_ms,
    stddevMs:            row.stddev_ms,
    successRate:         row.success_rate,
    lastProbedAt:        BigInt(row.last_probed_at),
    probeCount:          row.probe_count,
    consecutiveFailures: row.consecutive_failures,
    monitored:           row.monitored === 1,
  };
  return {
    where:  { hostId: row.host_id },
    update: { ...fields },
    create: { hostId: row.host_id, ...fields },
  };
}

/**
 * Deterministic id for a history row so a retried/partial migration does not
 * duplicate rows (#798). Combines hostId + probedAt — the natural key of a
 * probe sample. Used as the `id` (or dedupe key) so `createMany skipDuplicates`
 * is idempotent across re-runs.
 */
export function historyRowDeterministicId(row: { host_id: string; probed_at: number }): string {
  return `${row.host_id}:${row.probed_at}`;
}

/**
 * Build the `createMany.data` payload for a batch of legacy history rows (#725).
 *
 * Only includes rows whose host migrated successfully (`migratedHostIds`) and
 * attaches a deterministic `dedupeId` so the caller can use `skipDuplicates`
 * for idempotent re-runs (#798). Pure → unit-testable.
 */
export function buildHistoryCreateManyData(
  historyRows: SqliteHistoryRow[],
  migratedHostIds: Set<string>,
): Array<{ hostId: string; probedAt: bigint; medianMs: number | null; p90Ms: number | null; samples: number; dedupeId: string }> {
  const out: Array<{ hostId: string; probedAt: bigint; medianMs: number | null; p90Ms: number | null; samples: number; dedupeId: string }> = [];
  for (const row of historyRows) {
    if (!migratedHostIds.has(row.host_id)) continue;
    out.push({
      hostId:   row.host_id,
      probedAt: BigInt(row.probed_at),
      medianMs: row.median_ms,
      p90Ms:    row.p90_ms,
      samples:  row.samples,
      dedupeId: historyRowDeterministicId(row),
    });
  }
  return out;
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
  const migratedHostIds = new Set<string>();

  // #726: upsert hosts in transaction-batched chunks instead of one round-trip
  // per host. We still fall back to per-row on a chunk failure so a single bad
  // row doesn't abort the whole migration (preserving the old skip behaviour).
  const HOST_CHUNK = 50;
  for (let i = 0; i < hostRows.length; i += HOST_CHUNK) {
    const chunk = hostRows.slice(i, i + HOST_CHUNK);
    try {
      if (typeof prisma.$transaction === 'function') {
        await prisma.$transaction(chunk.map(r => prisma.hostLatency.upsert(buildHostUpsertArgs(r))));
      } else {
        for (const r of chunk) await prisma.hostLatency.upsert(buildHostUpsertArgs(r));
      }
      for (const r of chunk) migratedHostIds.add(r.host_id);
      hostsDone += chunk.length;
    } catch {
      // Chunk failed atomically — retry row-by-row so good rows still land.
      for (const r of chunk) {
        try {
          await prisma.hostLatency.upsert(buildHostUpsertArgs(r));
          migratedHostIds.add(r.host_id);
          hostsDone++;
        } catch (err) {
          hostsSkipped++;
          log.warn(`Skipped host ${r.host_id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  // #725/#798: batch history inserts. Prefer createMany(skipDuplicates) for
  // idempotency on re-run; fall back to per-row create if createMany is absent.
  const historyData = buildHistoryCreateManyData(historyRows, migratedHostIds);
  if (historyData.length > 0) {
    const rows = historyData.map(({ dedupeId: _dedupeId, ...rest }) => rest);
    const createMany = (prisma.hostLatencyHistory as { createMany?: (args: unknown) => Promise<{ count: number }> }).createMany;
    if (typeof createMany === 'function') {
      try {
        const res = await createMany.call(prisma.hostLatencyHistory, { data: rows, skipDuplicates: true });
        historyDone += res?.count ?? rows.length;
      } catch {
        // createMany failed wholesale — degrade to per-row.
        for (const data of rows) {
          try { await prisma.hostLatencyHistory.create({ data }); historyDone++; } catch { /* dup/constraint */ }
        }
      }
    } else {
      for (const data of rows) {
        try { await prisma.hostLatencyHistory.create({ data }); historyDone++; } catch { /* dup/constraint */ }
      }
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
