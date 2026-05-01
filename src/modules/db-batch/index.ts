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

import { createLogger } from '../logger';

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
        await new Promise((r) => setTimeout(r, opts.retryDelayMs * retries));
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
    const results = await upsertFn(batch);
    allResults.push(...results);
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
    if (oldState[key] !== newState[key]) {
      changes[key] = newState[key];
    }
  }

  return changes;
}
