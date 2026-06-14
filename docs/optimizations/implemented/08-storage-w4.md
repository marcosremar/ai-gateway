# Storage, Database, State & Config — Wave 4 (IDs 701-800)

Fourth implementation pass over `docs/optimizations/08-storage-database-state.md`.
Disjoint from waves 1-3. Each item is high-value, SAFE, and LOCALIZED — most ship
as **pure, exported helpers** (trivially unit-testable, zero behavioural risk) and
are wired into the hot path only where the change is obviously safe. All new logic
is covered by `__tests__/opt/08-storage-w4.test.ts` (27 tests, unit-only: Prisma /
pg / `Bun.S3Client` / Neon-management are mocked; no real DB / network / FS writes).

## Implemented

| ID  | Theme | File | Change |
|-----|-------|------|--------|
| 716 | Debounce max-staleness | `src/gateway/state/cost-state.ts` | `spendPersistDecision()` (pure) + leading-edge flush: when `daily_spend.json` is older than `MAX_SPEND_STALENESS_MS` (30s) the debounce flushes immediately instead of re-arming the trailing 10s timer, so spend is never >30s stale on disk. `_lastPersistAt` tracked on each persist. |
| 722 | DB N+1 | `server/latency-db.ts` | `sortGpuTypesByLatency` did one `findMany` **per GPU type**. Now ONE `findMany` over all non-failing hosts + pure `partitionGpuTypesByLatency()` / `normalizeGpuModel()` group client-side. |
| 724 | DB N+1 | `server/latency-db.ts` | `getLatencyDbStats` fired **6 `count()`** round-trips. Now ONE host `findMany` + ONE history `count`, reduced by pure `mapHostStatsFromRows()`. |
| 725 | Migration batching | `server/latency-db-migrate.ts` | History rows inserted one-by-one. Pure `buildHistoryCreateManyData()` builds a `createMany` payload; loader uses `createMany({ skipDuplicates })` with per-row fallback. |
| 726 | Migration batching | `server/latency-db-migrate.ts` | Host upserts one-by-one. Pure `buildHostUpsertArgs()` + `$transaction`-chunked upserts (chunk=50) with row-by-row fallback on chunk failure (preserves skip-on-error). |
| 732 | Prepared statements | `src/database/pg-driver.ts` | Pure `nameStatement()` derives a stable pg identifier from SQL; the pg driver now sends a **named** prepared statement (`{ name, text, values }`) so the server caches the plan and skips re-parsing identical SQL. |
| 748 | S3 404 signal | `src/storage/s3-store.ts`, `src/storage/types.ts` | `getStream` only fails lazily on consume. Added `getStreamChecked()` that pre-`stat`s → returns `null` for 404, throws for real errors (e.g. 403), consistent with `head`/`get`. |
| 754 | S3 cache/ACL | `src/storage/s3-store.ts`, `types.ts`, `r2-store.ts`, `b2-store.ts` | Added `PutOptions.cacheControl`, `S3StoreConfig.defaultPut`, pure `mergePutOptions()` (per-call wins). R2/B2 constructors forward `defaultPut` so CDN buckets get cache/ACL headers without callers repeating them. |
| 775 | Cache merge cost | `server/config-persistence.ts` | Cold-load `find`-per-default (O(n·m)) replaced with single-pass `mergeMissingDefaultApps()` (Set lookup); pure + idempotent, existing apps never overwritten. |
| 789 | Backup naming | `src/backup-scheduler/index.ts` | Artifact was misnamed `*.tar.gz` (it's a dir of `.gz`). Pure `finalBackupName()` now uses an honest `backup-<ts>.gzdir` suffix. |
| 790 | Backup temp/final | `src/backup-scheduler/index.ts` | Build dir and kept backup shared the `.backup-temp-*` prefix → a crashed partial build counted as a valid backup. Now builds in `.backup-inprogress-*`, renames to `backup-*` on success; `cleanupOldBackups` matches only `isFinalBackup()`. |
| 793 | Branch retention | `src/database/backup.ts` | `branchBackup` never pruned old Neon branches. Pure `selectBranchesToPrune()` (keep newest N, ignore non-backup branches) + best-effort prune wired in (`DB_BACKUP_MAX_BRANCHES`, default 7). |
| 795 | Backup integrity | `src/database/backup.ts` | Dump backups had no checksum. `computeBackupChecksum()` stored in metadata; `verifyBackupChecksum()` checked before restore (throws `BACKUP_CHECKSUM_MISMATCH`); no-checksum backups still restore (back-compat). |
| 796 | Restore atomicity | `src/database/backup.ts` | `psql` restore ran without a transaction. Pure `buildPsqlRestoreArgs()` always includes `--single-transaction` for all-or-nothing restore. |
| 798 | Migration idempotency | `server/latency-db-migrate.ts` | History `create` had no idempotency key → duplicates on re-run. Pure `historyRowDeterministicId()` (`hostId:probedAt`) + `createMany skipDuplicates`. |

**Net: 15 findings implemented**, 27 unit tests, all passing. Existing waves 1-3
(`08-storage`, `08-storage-w2`, `08-storage-w3` = 101 tests) re-run green — no
regressions.

## Notes / scope discipline

- **Pure-helper bias.** Every wired change keeps the original control flow and
  error-handling (skip-on-error in migration, idempotent S3 deletes, best-effort
  pruning) and adds a typeof/feature guard before any new client method
  (`$transaction`, `createMany`, native `copy`/`cacheControl`), so a no-op Prisma
  proxy or older Bun runtime degrades gracefully.
- **`server/state.ts` untouched** (explicitly out of ownership). Tests swap the
  latency-db Prisma via the existing `setPrisma()` setter rather than editing
  state.
- Only files within the stated ownership set were edited.

## Deferred (and why)

| ID  | Reason deferred |
|-----|------|
| 703, 709 | `.bak` copy / `.env` rewrite atomicity — touch real config/secret files; want a dedicated wave with FS-injection tests rather than risk the `.env` munge path. |
| 704, 710, 720 | fsync on deploy-state / pid-lock / readiness writes — durability-only, hard to assert in a unit test without real fsync; low marginal value vs #701/#705 already done. |
| 708 | `clearPersistedDeploy` vs concurrent persist race — needs a write-lock spanning deploy-state, larger than a localized change. |
| 711, 712, 713 | Shutdown-flush wiring lives in `server/ws/pid-lock.ts` signal handlers — cross-module wiring; deferred to a focused shutdown wave. |
| 715 | `stampAppRequest` full-config rewrite per flush — needs a separate small-file store; behavioural change to persistence layout. |
| 730, 731 | Composite / computed-column indexes — require `prisma/schema.prisma` migration (out of ownership). |
| 737, 739, 740, 743 | Real undici dispatcher / single Prisma client / keep-alive — non-trivial infra; #738/#742 (honest stats + singleton warning) already landed. |
| 745, 746, 752, 756 | S3 multipart / streaming get / PUT presign constraints / tree-shake audit — multipart needs real client APIs; presign-PUT constraints need provider-specific testing. |
| 764, 769, 773, 774, 777, 778 | Redis pipelining, p95 concurrency doc, config cache invalidation / DB-sync surfacing / tenant tagging / cross-process invalidation — coordination/coherence concerns spanning multiple modules. |
| 779, 780, 781, 788 | `src/modules/` 590-file dedup — large refactor, explicitly out of scope. |
| 782, 783, 785, 787 | Typed Prisma surface / SettingsStore routing / Vault+UsageLog adapters / user-profiles DB impl — require new adapter implementations + DB wiring. |
| 786 | `loadPrisma` console.log → structured logger — `src/database/service.ts` change is fine but trivial; bundled into a future logging pass. |
| 791, 792, 794, 799 | Backup encryption / streaming dump / branch restore / scheduled DB backup — each needs vault wiring, streaming I/O, or the Neon management restore path (network-heavy). |
| 797, 800 | #800 already done (wave 3); #797 durable migration marker overlaps the #798 idempotency fix now landed. |
