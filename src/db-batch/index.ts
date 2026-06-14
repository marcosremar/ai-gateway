/**
 * Batch DB operations for efficient database access.
 *
 * Fixes: #476-510 (N+1 queries), #486-510 (DB optimization)
 *
 * Usage:
 * ```ts
 * import { batchInsert, batchUpsert, groupedQuery } from './db-batch';
 *
 * // Instead of N individual inserts:
 * await batchInsert(prisma, 'requestLog', records, 100);
 *
 * // Instead of N queries for GPU types:
 * const stats = await groupedQuery(prisma.hostLatency.findMany, {
 *   where: { gpuName: { in: gpuTypes } }
 * });
 * ```
 */

import { createLogger } from '../../src/logger';

const log = createLogger('db-batch');

export interface BatchOptions {
  /** Number of records per batch (default: 100) */
  batchSize?: number;
  /** Maximum retries on failure (default: 3) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 1000) */
  retryDelayMs?: number;
}

const DEFAULT_BATCH_OPTIONS: Required<BatchOptions> = {
  batchSize: 100,
  maxRetries: 3,
  retryDelayMs: 1000,
};

/**
 * Exponential backoff with full jitter (#729).
 *
 * The previous `retryDelayMs * retries` schedule was linear AND deterministic,
 * so under a Neon brownout every caller retried in lock-step (thundering herd).
 * Here the base doubles per attempt (`base * 2^(attempt-1)`) and the actual
 * sleep is a random value in `[0, cappedBase]` so concurrent retries spread out.
 *
 * Exported for unit testing — the bounds are deterministic even though the
 * point value is random.
 *
 * @param attempt 1-based retry number (1 = first retry)
 */
export function backoffDelayMs(attempt: number, baseMs: number, capMs = 30_000): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, capMs);
  return Math.floor(Math.random() * capped);
}

/**
 * Insert records in batches instead of individually.
 *
 * @example
 * ```ts
 * const inserted = await batchInsert(
 *   prisma.requestLog.createMany,
 *   records,
 *   { batchSize: 100 }
 * );
 * console.log(`Inserted ${inserted} records`);
 * ```
 */
export async function batchInsert<T>(
  insertFn: (data: { data: T[] }) => Promise<{ count: number }>,
  records: T[],
  options: BatchOptions = {},
): Promise<number> {
  const opts: Required<BatchOptions> = { ...DEFAULT_BATCH_OPTIONS, ...options };
  let totalInserted = 0;

  for (let i = 0; i < records.length; i += opts.batchSize) {
    const batch = records.slice(i, i + opts.batchSize);

    let retries = 0;
    while (retries < opts.maxRetries) {
      try {
        const result = await insertFn({ data: batch });
        totalInserted += result.count ?? batch.length;
        break;
      } catch (error) {
        retries++;
        if (retries >= opts.maxRetries) {
          log.error(
            { error: error instanceof Error ? error.message : String(error), batch: i / opts.batchSize },
            'Batch insert failed after max retries',
          );
          throw error;
        }
        // #729: exponential backoff with jitter (was linear `retryDelayMs * retries`).
        await new Promise((r) => setTimeout(r, backoffDelayMs(retries, opts.retryDelayMs)));
      }
    }
  }

  log.log({ totalInserted, totalRecords: records.length }, 'Batch insert complete');
  return totalInserted;
}

/**
 * Upsert records in batches.
 *
 * @example
 * ```ts
 * await batchUpsert(
 *   async (batch) => {
 *     return prisma.$transaction(
 *       batch.map(record =>
 *         prisma.gpuTypeCache.upsert({
 *           where: { name: record.name },
 *           update: record,
 *           create: record,
 *         })
 *       )
 *     );
 *   },
 *   gpuTypes
 * );
 * ```
 */
export async function batchUpsert<T, R>(
  upsertFn: (batch: T[]) => Promise<R[]>,
  records: T[],
  options: BatchOptions = {},
): Promise<R[]> {
  const opts: Required<BatchOptions> = { ...DEFAULT_BATCH_OPTIONS, ...options };
  const allResults: R[] = [];

  for (let i = 0; i < records.length; i += opts.batchSize) {
    const batch = records.slice(i, i + opts.batchSize);

    // #728: mirror batchInsert's retry/backoff — previously a single transient
    // Neon error aborted the whole upsert with no retry despite the docstring
    // implying parity with batchInsert.
    let retries = 0;
    while (true) {
      try {
        const results = await upsertFn(batch);
        allResults.push(...results);
        break;
      } catch (error) {
        retries++;
        if (retries >= opts.maxRetries) {
          log.error(
            { error: error instanceof Error ? error.message : String(error), batch: i / opts.batchSize },
            'Batch upsert failed after max retries',
          );
          throw error;
        }
        await new Promise((r) => setTimeout(r, backoffDelayMs(retries, opts.retryDelayMs)));
      }
    }
  }

  log.log({ totalUpserted: allResults.length, totalRecords: records.length }, 'Batch upsert complete');
  return allResults;
}

/**
 * Execute a query with WHERE IN clause instead of N separate queries.
 *
 * @example
 * ```ts
 * // Instead of: for each gpuType, query separately
 * const results = await queryIn(prisma.hostLatency.findMany, 'gpuName', gpuTypes);
 * ```
 */
export async function queryIn<T, K extends keyof T>(
  queryFn: (args: { where: { [P in K]?: { in: T[P][] } } }) => Promise<T[]>,
  fieldName: K,
  values: T[K][],
): Promise<T[]> {
  if (values.length === 0) return [];

  const results = await queryFn({
    where: { [fieldName]: { in: values } } as { [P in K]?: { in: T[P][] } },
  });

  log.log({ fieldName: String(fieldName), valueCount: values.length, resultCount: results.length }, 'IN query executed');
  return results;
}

/**
 * Execute a grouped query with aggregation.
 *
 * @example
 * ```ts
 * // Single query instead of 6 separate count queries
 * const stats = await groupedQuery(
 *   prisma.hostLatency.groupBy,
 *   { by: ['status'], _count: true }
 * );
 * ```
 */
export async function groupedQuery<T, R>(
  queryFn: (args: T) => Promise<R[]>,
  args: T,
): Promise<R[]> {
  const results = await queryFn(args);
  log.log({ resultCount: results.length }, 'Grouped query executed');
  return results;
}

/**
 * Compute stats in a single query instead of multiple queries.
 *
 * @example
 * ```ts
 * // Instead of 6 separate count() calls:
 * const stats = await computeStats(
 *   prisma.hostLatency.findMany,
 *   { where: { createdAt: { gte: startDate } } },
 *   records => ({
 *     total: records.length,
 *     success: records.filter(r => r.status === 'success').length,
 *     failed: records.filter(r => r.status === 'failed').length,
 *     avgLatency: records.reduce((sum, r) => sum + r.latencyMs, 0) / records.length,
 *   })
 * );
 * ```
 */
export async function computeStats<T, R>(
  queryFn: (args: T) => Promise<T[]>,
  args: T,
  compute: (records: T[]) => R,
): Promise<R> {
  const records = await queryFn(args);
  return compute(records as unknown as T[]);
}

/**
 * Aggregate-aware stats (#734). Prefer this for high-cardinality tables: it
 * runs a single DB-side aggregate (`COUNT`/`AVG`/`groupBy`) via `aggregateFn`
 * instead of streaming every matching row into JS just to reduce it (which
 * transfers far more egress). When no `aggregateFn` is supplied it falls back
 * to the row-scan `computeStats` behaviour so existing callers are unaffected.
 *
 * @example
 * ```ts
 * const stats = await computeStatsAggregated(
 *   () => prisma.hostLatency.aggregate({ _count: true, _avg: { medianMs: true } }),
 *   (agg) => ({ total: agg._count, avg: agg._avg.medianMs }),
 * );
 * ```
 */
export async function computeStatsAggregated<A, R>(
  aggregateFn: () => Promise<A>,
  map: (agg: A) => R,
): Promise<R> {
  const agg = await aggregateFn();
  return map(agg);
}

/**
 * Differential update — only write changed fields instead of full state.
 *
 * @example
 * ```ts
 * const changes = diffState(oldState, newState);
 * if (changes.length > 0) {
 *   await prisma.deployState.update({ where: { id }, data: { changes } });
 * }
 * ```
 */
export function diffState<T extends Record<string, unknown>>(
  oldState: T,
  newState: T,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};

  for (const key of Object.keys(newState)) {
    // #735: compare by value, not reference. The old `!==` flagged every
    // object/array field as "changed" (reference inequality), so an unchanged
    // nested field was rewritten on every update — defeating the differential
    // write. Scalars short-circuit on `===`; non-scalars fall back to a
    // structural (JSON) comparison.
    if (!valuesEqual(oldState[key], newState[key])) {
      changes[key] = newState[key];
    }
  }

  return changes;
}

/**
 * Structural equality used by `diffState` (#735). Scalars compare with `===`
 * (incl. NaN-safe via Object.is); objects/arrays compare by stable JSON so a
 * deep-equal-but-distinct reference is NOT reported as a change. Intended for
 * the plain serializable state objects this module persists — not a general
 * deep-equal (it does not handle cyclic refs or Map/Set).
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Non-serializable (cyclic) — fall back to reference inequality (already
    // known false here) so we err on the side of "changed".
    return false;
  }
}
