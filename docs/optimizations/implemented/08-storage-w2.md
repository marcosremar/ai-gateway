# Implemented — Storage, Database, State & Config, WAVE 2 (IDs 701-800)

Second batch of localized, low-risk fixes from
`docs/optimizations/08-storage-database-state.md`. All edits are minimal diffs
inside the owned file set (`src/db-batch/`, `src/connection-pool/`,
`src/platform/adapters/` [canonical source behind the `src/adapters/` barrel],
`src/gateway/state/`, `src/storage/`, `src/backup-scheduler/`,
`src/database/pg-driver.ts`).

Wave-1 items (#701, #702, #705, #711, #712, #713, #717, #718, #719, #721, #770,
#771) were left untouched — this wave covers a **disjoint** set.

Tests live in `__tests__/opt/08-storage-w2.test.ts` (separate from the wave-1
file). Run:
`bunx vitest run --config vitest.opt.config.ts __tests__/opt/08-storage-w2.test.ts`
→ **28 passed**. Unit-only: no real DB/network (Prisma/pg/S3 are stubbed; FS
tests stay in `os.tmpdir()`).

Dominant themes: **cost** (fewer Neon round-trips via working backoff/retry and
aggregate-side stats; fewer S3 requests via batched delete + auto-pagination;
honest pool stats), and **reliability** (bounded in-memory growth so a runaway
producer can't OOM the process; TTL parity for counters; pg reconnect-and-retry;
differential writes that actually skip unchanged nested fields).

## Changes

| ID | Lens / Impact | File:area | Change made | Test |
|----|---------------|-----------|-------------|------|
| #729 | Cost/Low | db-batch/index.ts `backoffDelayMs` | New exported helper: exponential backoff (`base * 2^(attempt-1)`) with **full jitter** and a cap, replacing the linear, deterministic `retryDelayMs * retries` that synchronized retries (thundering herd) during a Neon brownout. Used by `batchInsert`. | bounded-by-cap per attempt; jitter (random=0 → 0, capped at high random) |
| #728 | Reliability/Low | db-batch/index.ts `batchUpsert` | Added the same retry/backoff loop `batchInsert` already had — previously one transient error aborted the whole upsert despite the docstring implying parity. | retries→success (retryDelayMs:0); throws after maxRetries |
| #735 | Functionality/Low | db-batch/index.ts `diffState` + new `valuesEqual` | `diffState` now compares **by value**: scalars via `Object.is` (NaN-safe), objects/arrays structurally (stable JSON). The old `!==` flagged every object/array field as changed (reference inequality), defeating differential writes. | deep-equal objects → no change; only differing fields reported; valuesEqual scalar/object/NaN/null |
| #734 | Cost/Low | db-batch/index.ts `computeStatsAggregated` | New aggregate-aware stats helper that runs a single DB-side `aggregate`/`groupBy` call (`COUNT`/`AVG`) instead of streaming every matching row into JS to reduce it (egress). Additive — `computeStats` row-scan path unchanged. | one aggregate call maps to result |
| #738 | Usability/Med | connection-pool/index.ts `getStats` | Returns `null` ("unknown") instead of fabricated `connected/free/...` numbers that masked real connection exhaustion on dashboards. Added `getConfig()` for honest diagnostics. | getStats null; getConfig exposes maxConnections |
| #742 | Functionality/Low | connection-pool/index.ts `getGlobalPool` / new `resetGlobalPool` | Documented the singleton, **warn** when a later call passes conflicting config (was silently ignored), and added `resetGlobalPool()` to deliberately rebuild with new config. | first config kept; reset rebuilds with new config |
| #757 | Reliability/Med | platform/adapters/in-memory-state.ts `rpush` | Hard `MAX_LIST_LEN` cap — drops oldest (FIFO) once over the cap so a producer that never `ltrim`s can't OOM before the 48h idle sweep. | over-cap keeps newest N, evicts oldest |
| #759 | Reliability/Med | in-memory-state.ts `hset` | `MAX_HASH_FIELDS` cap on **new** fields (updates to existing fields always allowed) so heartbeat hashes can't grow per-field unbounded. | new field past cap throws; existing-field update OK |
| #760 | Functionality/Low | in-memory-state.ts `hincrby` | Accepts optional `ttlSecs` and sets `hashExpiry` so counters created via `hincrby` can expire — previously immortal, diverging from `hset` TTL semantics. (Extra optional param; interface unchanged.) | TTL set + sweeps on expiry; no TTL → immortal |
| #761 | Cost/Low | in-memory-state.ts `scan` | Streams matching keys to the callback in batches (`BATCH=100`, like Redis SCAN/COUNT) instead of materializing the entire matching keyspace into one array, and honors early-stop after any batch. | multiple batches summing to total; `return false` stops after 1st batch |
| #765 | Cost/Low | platform/adapters/redis-state.ts `scan` | COUNT now scales toward the caller's remaining `limit` (capped at 1000) instead of a flat 100 — a 10k scan drops from ~100 round-trips to ~10. | COUNT passed is > 100 and ≤ 1000 |
| #768 | Reliability/Low | gateway/state/metrics-state.ts | New `incrMetricCounter` + `MAX_METRIC_KEYS` (200): existing keys always increment; new keys past the cap fold into a single `__other__` bucket, bounding the `byStage`/`byProvider` cardinality maps against typo'd/attacker-supplied names. Empty key → `__unknown__`. | below-cap counts; over-cap → __other__; empty → __unknown__ |
| #749 | Usability/Med | storage/types.ts + s3-store.ts `listAll` / `listAllVia` | Optional `listAll(prefix, pageSize)` async-iterator on `ObjectStore`, implemented via standalone `listAllVia(listFn, …)` that transparently follows `nextContinuationToken` (prevents the "only first 1000 keys" bug) and guards against a backend returning the same token forever. | yields across pages; bails on repeated token |
| #750 | Cost/Med | storage/types.ts + s3-store.ts `deleteMany` | Optional `deleteMany(keys)` using S3 batch delete (≤1000 keys/request) instead of N per-key calls; chunks at 1000; idempotent; no-op on empty. Falls back to looping `delete` if the runtime lacks batch delete. | single batch ≤1000; empty no-op; 1500 → [1000,500] |
| #800 | Usability/Low | backup-scheduler/index.ts `getStatus` | Split the conflated `running` into `scheduled` (armed) and `inProgress` (actually executing); `running` kept as the OR for back-compat. | idle false/false; after start scheduled=true |
| #733 | Reliability/Med | database/pg-driver.ts | On a transient disconnect, the driver now **reconnects with a fresh client and retries the query once** (was: close + rethrow, leaving a dead client so the next query failed too). Extracted exported `isTransientDisconnect` (adds `EPIPE`). | classifies ECONNRESET/ENOTCONN/ECONNREFUSED/EPIPE; rejects syntax/plain/undefined |

## Notes on safety / ownership

- `ObjectStore.deleteMany` / `listAll` are declared **optional** so partial test
  fakes and other consumers (e.g. `server/gpu-snapshot.ts` injected stubs)
  keep compiling; `createS3Store` always provides concrete implementations.
- `hincrby`'s new `ttlSecs?` is an extra optional parameter on the
  implementation only — the `HashStore` interface in `src/platform/deps.ts`
  (not owned) is left untouched and remains satisfied.
- `connection-pool.getStats` already declared `PoolStats | null`, so returning
  `null` is type-compatible with existing callers (none outside the module).
- Canonical adapter source is `src/platform/adapters/`; `src/adapters/` (owned)
  is a thin re-export and needs no change.

## Deferred (this wave)

| ID | Why deferred |
|----|--------------|
| #703 | `.bak` non-atomic copy — `saveProviderConfig` already does tmp+rename for the primary (wave 1); the `.bak` copy fix touches the same hot write path and is better bundled with #714/#715 stamp work. |
| #722 / #723 / #724 | latency-db N+1 / 6-count collapse — correct, but rewriting live Prisma query shapes risks behavior drift; needs the `db-batch` helpers wired + schema/index review (#730/#731). Deferred to a DB-focused wave. |
| #725 / #726 / #797 / #798 | Migration batching + idempotent markers — touch `latency-db-migrate.ts` first-boot path; higher blast radius, defer with the latency-db batch. |
| #730 / #731 | Composite indexes / `nextProbeAt` column — require `prisma/schema.prisma` changes (migrations), out of scope for localized code-only edits. |
| #732 / #739 / #740 | Prepared-statement reuse / unify Prisma clients / pooled WS driver — cross-cutting connection-lifecycle changes spanning `prisma-init` + `database/service` (one owned, one not). |
| #737 | Real undici `Agent` in connection-pool — needs a runtime dependency/dispatcher; #738 already stops the misleading fake metrics. |
| #745 / #746 / #747 / #748 / #755 | S3 multipart / range GET / 404-on-stream / 5xx retry — depend on `Bun.S3Client` semantics not faithfully mockable in unit tests; need integration coverage. |
| #779 / #780 / #781 | `src/modules/` 590-file duplicate tree — large deletion/refactor, explicitly out of scope (and `src/modules/**` is not owned). |
| #789–#796 / #799 | Backup tar/encryption/streaming/retention/restore-txn — larger reliability features (real tar lib, AES vault wiring, Neon branch retention) beyond a localized diff. |
