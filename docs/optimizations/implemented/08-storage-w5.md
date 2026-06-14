# Storage, Database, State & Config — Wave 5 (IDs 701-800)

Fifth implementation pass over `docs/optimizations/08-storage-database-state.md`.
Disjoint from waves 1-4 (see `08-storage-w2/w3/w4.md`). Each item is SAFE and
LOCALIZED: pure helpers extracted for unit-testability, minimal wiring at the
call sites, no behavioural change beyond the stated fix. No source outside the
allowed ownership list was touched.

Tests: `__tests__/opt/08-storage-w5.test.ts` — 19 tests, all passing
(`bunx vitest run --config vitest.opt.config.ts __tests__/opt/08-storage-w5.test.ts`).
Unit-only: Prisma/pg/Bun.S3Client/user-profiles mocked; FS tests redirect `$HOME`
into `os.tmpdir()`.

## Implemented

| ID | Item | File(s) | What changed |
|----|------|---------|--------------|
| 709 | `.env` rewrite not atomic, can truncate secrets | `server/config-handlers.ts` | Extracted pure `mergeEnvContent(existing, updates)` (the key-replace/remove/append munging) and `atomicWriteEnv(path, content)` (open → `writeFileSync(fd)` → `fsyncSync` → `chmodSync 0o600` → `renameSync`). `handleSetApiKeys` now builds the body then writes atomically, so a crash mid-write leaves either the old or new complete `.env`, never a truncated one losing unrelated keys. |
| 773 | Config cache TTL allows 5s stale reads after external edit | `server/config-persistence.ts` | Added pure `isConfigCacheFresh(now, cachedAt, cachedMtime, currentMtime, ttl)` and `invalidateConfigCache()`. `loadProviderConfig` now stats the file on a cache hit and busts the cache when the on-disk mtime is newer than what was cached (or the file vanished), so manual edits are seen within the TTL instead of after it. Save/load both record the file mtime. |
| 774 | `saveProviderConfig` resolves before DB write completes | `server/config-persistence.ts` | The user-DB sync is fire-and-forget, so callers can't observe its failure. Added a `_dbSyncFailures` counter (incremented in both DB-sync catch paths), exposed via `getConfigDbSyncFailures()` (+ `__resetConfigDbSyncFailures()` for tests) so silent durability loss is detectable from a `/metrics` scrape. |
| 786 | `loadPrisma` logs a redacted URL to console on every init | `src/database/service.ts` | Extracted pure `redactDatabaseUrl(url)` (URL-parse → mask password fully + truncate username; `<unparseable>` fallback; handles passwords containing literal `@`). Replaced the unconditional `console.log` with `createLogger('database').debug(...)` so it is gated by `LOG_LEVEL` and goes through the structured logger. |
| 797 | Migration marks done via non-atomic rename only | `server/latency-db-migrate.ts` | Added a durable sidecar flag `latency.db.migrated.flag` written (via `writeFileSync`) BEFORE the `renameSync`, plus pure `migrationFlagPath(dbPath)` and `isMigrationComplete(hasRename, hasFlag)`. The guard treats EITHER marker as done, so a rename that fails after a successful import no longer re-runs the import (which could duplicate history rows). |
| 745 | No multipart threshold for large `put()` | `src/storage/s3-store.ts` | Added pure `shouldUseMultipart(size, threshold)`, `putBodyByteLength(body)` and `DEFAULT_MULTIPART_THRESHOLD` (100MB) + a `multipartThresholdBytes` config field. `put()` measures the body when its size is known and passes a `partSize` hint to `client.write` for large bodies so a mid-transfer failure re-uploads only the failed part. Unknown-size (streaming) bodies are unaffected. |
| 752 | Presign TTL cap not applied to PUT uploads consistently | `src/storage/s3-store.ts` | Added pure `presignTtlSeconds(method, requested)`: PUT (write) presigns default to a shorter 15-min TTL (open-ended uploads are a bigger exposure than reads) while GET/HEAD/DELETE keep the 1h default; all clamp to `[60s, 24h]`. `presign()` routes through it. |

## Deferred (with reasons)

The safe, localized pool for IDs 701-800 is now largely **exhausted** — waves 1-4
plus this wave have implemented the vast majority of S-effort items. Remaining
items are deferred because they are not safe/localized within the scope and
ownership constraints:

| ID | Item | Why deferred |
|----|------|--------------|
| 737 | Connection-pool is a no-op stub (wire real undici Agent) | M effort; requires importing/owning an undici `Dispatcher`/`Agent` and changing the fetch path's runtime behaviour — too invasive for a minimal-diff wave. The honest `getStats()→null` (#738) already removed the misleading metrics. |
| 730 / 731 | Add composite index / `nextProbeAt` column | Requires editing `prisma/schema.prisma` + a migration; schema/migration files are outside the safe scope and need a real DB to validate. |
| 739 / 740 | Unify the two Prisma clients / pooled WS adapter | M effort, cross-module (server `prisma-init` vs `src/database/service`); changing client topology risks connection-lifecycle regressions. |
| 779 / 780 / 781 | Delete/dedupe `src/modules/` clone | L effort, 590-file deletion across an owned/disallowed boundary (`src/modules/**` is explicitly out of scope); high blast radius. |
| 783 / 787 / 785 | Route config-persistence through `SettingsStore` / implement `user-profiles` DB / `VaultStore` adapters | Each needs real Prisma wiring and a DI refactor spanning multiple modules; not localized. |
| 789 / 791 / 792 / 793-796 / 799 | Backup tar/encrypt/stream/retention/restore-txn/schedule | Largely done in wave 4 (#789/#790/#793/#795/#796); the rest (real tar lib, at-rest encryption, streaming pg_dump, branch auto-restore, wiring a schedule) are M effort and touch process spawning / external services that can't be unit-validated safely. |
| 708 / 716(done)/ 718(done) | `clearPersistedDeploy` serialization, etc. | `deploy-state` serialization (#708) needs an in-process write lock shared with `persistDeployState`; cross-cutting concurrency change deferred to avoid subtle races. |
| 704 (partial) | fsync + dir-fsync for every `~/.babelcast` write | `atomicWrite` already fsyncs (#705); extending to every direct `writeFileSync` caller (`cost-state`, `cooldowns`, etc.) is broad and several were already converted in earlier waves. |
| 769 / 741 / 744 / 772 / 777 / 778 | Documentation-only / contract clarifications / cross-process invalidation | Either doc-only (no code change to test meaningfully), already effectively satisfied by earlier waves, or require multi-node infra (pub/sub) that can't be unit-tested. |

Note: subsequent waves will hit diminishing returns — most remaining items are
M/L effort, require schema/migration changes, span the `src/modules/` duplication
boundary, or are documentation-only.
