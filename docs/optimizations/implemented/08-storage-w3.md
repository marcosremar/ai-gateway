# Storage, Database, State & Config — Wave 3 (IDs 701-800)

Third batch of safe, localized optimizations from
[`../08-storage-database-state.md`](../08-storage-database-state.md). Disjoint
from waves 1-2 (which covered #701/#702/#705/#711-#713/#717-#719/#721/#728/#729/
#733/#734/#735/#738/#742/#749/#750/#757/#759/#760/#761/#765/#768/#770/#771/#800).

All changes stay inside the allowed ownership set, keep files compiling, and ship
with unit tests in [`__tests__/opt/08-storage-w3.test.ts`](../../../__tests__/opt/08-storage-w3.test.ts)
(31 tests, no real DB/network/S3 — Prisma/pg/Bun.S3Client mocked; filesystem in
`os.tmpdir()` only).

## Implemented

| ID | Optimization | File(s) | What changed |
|----|--------------|---------|--------------|
| 706 | App-registry seed/save writes in-place | `server/app-registry.ts` | `saveToDisk` + first-boot seed now go through `atomicWriteRegistry` (tmp → rename), so a crash mid-write can't truncate `apps.json` into a permanent "fall back to seed" state. |
| 707 | App-registry has no `.bak` recovery path | `server/app-registry.ts` | Each save snapshots the prior good file to `apps.json.bak` before overwriting; `loadFromDisk` attempts `.bak` recovery (via new `parseRegistry`) before discarding operator edits and reverting to seed. |
| 714 | `stampAppRequest` flushes wrong app on switch | `server/config-persistence.ts` | Pending stamps tracked in a `Set<string>` (was a single `_pendingStampId` that a later call clobbered); `_flushStamps` records `lastRequestAt` for every app touched in the debounce window in one write. Added `__getPendingStampIds`/`__flushStampsNow` test hooks. |
| 723 | History prune uses findMany+deleteMany | `src/db-batch/index.ts` | New pure `buildPruneKeepNewest(idsNewestFirst, keepNewest, idField?)` returns a single `{ where: { id: { lt: cutoff } } }` (or `null` when nothing to prune) so callers collapse the two-query prune to one delete. |
| 736 | `prisma-init` pool has no max/idle/lifetime | `server/prisma-init.ts` | New pure `buildPgPoolOptions(connStr, env)` reads `DB_POOL_MAX` (clamped 1..100), `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_MAX_LIFETIME_S`, `DB_POOL_CONNECT_TIMEOUT_MS` with safe Neon-friendly defaults (never NaN); wired into the `pg.Pool` constructor. |
| 747 | No GET-range / partial-fetch API | `src/storage/types.ts`, `src/storage/s3-store.ts` | Added optional `getRange(key, start, end?)` to `ObjectStore`; S3 adapter implements it via `file.slice` (inclusive end → exclusive slice) with a full-fetch fallback, wrapped in retry. |
| 751 | No server-side copy / rename | `src/storage/types.ts`, `src/storage/s3-store.ts` | Added optional `copy(src, dst)`; S3 adapter prefers native `client.copy` (no egress round-trip) and falls back to GET+PUT. |
| 753 | `head()` swallows non-404 errors by code heuristics | `src/storage/s3-store.ts` | New exported `isS3NotFound` treats any non-403 4xx + the well-known codes (`NoSuchKey`/`NoSuchBucket`/…) as not-found, so B2/MinIO/Wasabi 404 shapes are handled; replaces the inline detector. |
| 755 | No retry/backoff on transient S3 5xx | `src/storage/s3-store.ts` | New exported `isRetryableS3Error` (5xx/429/SlowDown) + `withS3Retry(op, {maxRetries, baseDelayMs, sleep})` with full-jitter exponential backoff; applied to idempotent `get`/`getRange`/`head`/`list`/`copy`. Non-retryable 4xx surface immediately. |
| 758 | InMemory sweep only runs on access | `src/platform/adapters/in-memory-state.ts` | Added `startPeriodicSweep(intervalMs)` / `stopPeriodicSweep()` using an `unref()`'d interval so TTL'd keys expire on a timer even for a write-only store. Idempotent. |
| 762 | Redis `hgetall` fetches whole hash then slices | `src/platform/adapters/redis-state.ts` | When the client exposes `hscan`, `hgetall` walks the hash with a bounded `COUNT` and stops at `limit` (new pure `parseHscanReply` folds the flat reply); falls back to `HGETALL`+slice otherwise. |
| 763 | Redis `hincrby` ignores TTL parity with InMemory | `src/platform/adapters/redis-state.ts`, `src/platform/deps.ts` | `hincrby` now accepts an optional `ttlSecs` and refreshes the hash TTL via `EXPIRE` (parity with InMemory.hincrby); `HashStore.hincrby` signature updated. |
| 766 | StateStore intersection forces full impl | `src/platform/deps.ts` | Added `PartialStateStore` (KV + partial List/Hash) and runtime guards `hasListOps`/`hasHashOps` so a host can supply a capability-scoped store and consumers feature-detect. |
| 767 | `lrange` `maxElements` guard declared but not enforced | `src/platform/adapters/in-memory-state.ts`, `src/platform/adapters/redis-state.ts` | Both adapters now accept the documented `maxElements` arg and **throw** when the returned range exceeds it; omitting it preserves the old unbounded behaviour (back-compat). |
| 776 | No schema version field in `provider-config.json` | `server/config-persistence.ts` | Added `CONFIG_SCHEMA_VERSION` + pure `needsConfigMigration(data)` (flags legacy `profiles`/`activeProfileId` and unversioned blobs); `saveProviderConfig` stamps `schemaVersion` on every write. |

## Test coverage

`__tests__/opt/08-storage-w3.test.ts` — 31 unit tests:

- **#723** single-delete cutoff, empty/under-count → null, custom id field.
- **#736** defaults, env overrides + clamp, non-numeric → default (no NaN).
- **#753/#755** classification matrices; retry-then-succeed; non-retryable fails fast.
- **#747/#751** ranged read (inclusive + to-EOF) and copy (native + GET+PUT fallback) against a stubbed `Bun.S3Client`.
- **#762** `parseHscanReply`; HSCAN walk honoring limit without HGETALL; fallback path.
- **#763** EXPIRE refresh with/without TTL.
- **#766** KV-only vs full-adapter capability detection.
- **#767** InMemory + Redis throw past `maxElements`, pass under, unbounded without.
- **#758** timer-driven eviction (fake timers) + idempotent start/stop.
- **#714** Set accumulation across the debounce window; flush clears it.
- **#776** migration detection + on-disk `schemaVersion` stamp.
- **#706/#707** atomic seed/save + `.bak` snapshot; recover from `.bak`; seed fallback when both corrupt.

## Deferred (with reason)

| ID | Reason deferred |
|----|-----------------|
| 703 | `config-persistence` `.bak` copy → atomic; touches the hot `saveProviderConfig` write path used by every profile mutation. Lower-risk to bundle with a focused config-persistence write-path pass; #776 already added there this wave. |
| 704 | Generic fsync-on-rename for all `~/.babelcast` writes — `cost-state`/`cooldown-persistence` already do it (waves 1-2); a cross-cutting sweep of every state writer is broader than "localized". |
| 708 | `clearPersistedDeploy` vs concurrent persist race needs a write lock in `deploy-state.ts` — concurrency-sensitive; defer to a deploy-state-focused change. |
| 709 | `.env` rewrite atomicity in `config-handlers.ts` — secret-bearing hot path (`handleSetApiKeys`); wants careful manual review, not a batched change. |
| 715 | `stampAppRequest` rewriting the whole config per flush — overlaps #714's area but is a larger persistence redesign (separate small file). |
| 716/717-rollover | Daily-spend max-staleness / leading-edge flush — #717 rollover already landed (wave 1); adding a leading-edge cap changes debounce timing semantics. |
| 720 | Readiness-state atomicity — `readiness-state.ts` is in `src/gateway/state/` (allowed) but writing it needs verifying its full write path; deferred to avoid touching readiness flow blindly. |
| 721-collapse / 722 / 724 / 725 / 726 / 727 / 730 / 731 | Latency-DB N+1 collapse, `getLatencyDbStats` groupBy, migration `createMany`, index hints — require real Prisma schema/query edits in `latency-db.ts`/`latency-db-migrate.ts`; #723 ships the reusable prune helper but wiring it into the live N+1 paths is a DB-behavioral change best validated against a real DB. |
| 732 / 740 | Prepared-statement reuse / pooled WS driver — driver-architecture changes. |
| 737 / 739 | Real undici dispatcher / unify two Prisma clients — multi-module wiring. |
| 745 / 746 / 748 / 752 / 754 / 756 | Multipart upload threshold, streaming get, getStream-404 semantics, PUT-presign constraints, default ACL/cache, barrel side-effects — each touches S3 behavior or build config; deferred to keep this wave's S3 additions (range/copy/retry/404) tightly scoped. |
| 762-pipeline / 764 | Redis pipelining (`MULTI` for rpush+ltrim) — needs a pipeline API on `RedisLike`; broader interface change. |
| 769 / 772 / 773 / 774 / 775 / 777 / 778 | Concurrency invariants / cache-coherence / cross-tenant tagging in config-persistence — reliability-sensitive, want dedicated review. |
| 779-788 | `src/modules/` dedup + DI rewiring — explicitly out of ownership (`src/modules/**` excluded) and large. |
| 789-799 | Backup tar/encryption/retention/restore-transaction — `backup-scheduler`/`database/backup.ts` behavioral changes that need integration validation; #800 (status split) already landed wave 2. |
