/**
 * Orphan guard entry point (see src/deployments/reaper.ts). Runs as a Railway cron service next to the gateway:
 *
 *   SANDBOX_TOKEN=… GATEWAY_URL=https://ai-gateway.up.railway.app DEPLOYMENTS_NAMESPACE=prod \
 *     AI_GATEWAY_ADMIN_KEY=… bun scripts/reap-orphans.ts [--apply]
 *
 * Without `--apply` it is a DRY RUN (lists what it would release, releases nothing) — the default when run by hand.
 * The Railway cron (`railway.reaper.json`) passes `--apply`; `REAPER_APPLY=1` on the service does the same when the
 * live start command lost the flag.
 *
 * Machines of OTHER namespaces (dev/test gateways sharing the provider account) are listed on every run and never
 * released by `--apply`: each one past the grace is a line `ALERT reaper.foreign_quota_held` when its machine type is
 * one this namespace's deployments use (or when that is unknown: no admin key), also posted to `ALERT_WEBHOOK_URL`.
 * `--apply-foreign` deletes the STOPPED ones older than `REAPER_FOREIGN_MIN_AGE_HOURS` (default 6, never under 1).
 *
 * Env: GATEWAY_URL (required); SCW_SECRET_KEY and/or VAST_API_KEY (or SANDBOX_TOKEN, which fetches them from the dev
 * API); DEPLOYMENTS_NAMESPACE (default `default`); SCW_DEFAULT_PROJECT_ID / SCW_PROJECT_ID (optional, scopes Scaleway);
 * AI_GATEWAY_ADMIN_KEY (an admin key of the gateway, i.e. a key whose user is in DEPLOYMENTS_ADMIN_USERS — enables the
 * cross-check while the gateway is up; never the SANDBOX_TOKEN); REAPER_GRACE_MINUTES (default 30).
 *
 * Exit 0 when nothing failed, 1 when a list or a release failed (the next run retries), 2 on bad configuration,
 * 3 when the gateway is up and the cross-check did not run (no admin key, untrusted answer): NOT a clean run.
 */

import { loadSandboxEnv } from '../src/config/sandbox-env';
import { DEFAULT_REAPER_GRACE_MS, ownedFromGateway, reapExitCode, reapOrphans, reapSummary } from '../src/deployments/reaper';
import { ScalewayDeploymentBackend } from '../src/deployments/scaleway-backend';
import { ScalewayNetworkSweeper } from '../src/deployments/scaleway-leftovers';
import { VastDeploymentBackend } from '../src/deployments/vast-backend';

const apply = process.argv.includes('--apply') || process.env.REAPER_APPLY === '1';
const applyForeign = process.argv.includes('--apply-foreign');
// Read before the sandbox fetch: the admin key comes from this service's own env, never from the dev API.
const adminKey = process.env.AI_GATEWAY_ADMIN_KEY?.trim() || '';
await loadSandboxEnv(process.env);
const secret = process.env.SCW_SECRET_KEY || process.env.SCALEWAY_SECRET_KEY;
const vastKey = process.env.VAST_API_KEY;
const gateway = (process.env.GATEWAY_URL || '').replace(/\/$/, '');
if ((!secret && !vastKey) || !gateway) {
  console.error('reaper: SCW_SECRET_KEY and/or VAST_API_KEY (or SANDBOX_TOKEN) and GATEWAY_URL are required');
  process.exit(2);
}
const sandboxToken = process.env.SANDBOX_TOKEN?.trim();
if (adminKey && sandboxToken && adminKey === sandboxToken) {
  console.error('reaper: AI_GATEWAY_ADMIN_KEY must be a gateway admin key, not the SANDBOX_TOKEN');
  process.exit(2);
}
const namespace = process.env.DEPLOYMENTS_NAMESPACE || 'default';
const projectId = process.env.SCW_DEFAULT_PROJECT_ID || process.env.SCW_PROJECT_ID || process.env.SCALEWAY_PROJECT_ID || undefined;
const graceMinutes = Number(process.env.REAPER_GRACE_MINUTES);
const graceMs = Number.isFinite(graceMinutes) && graceMinutes > 0 ? graceMinutes * 60_000 : DEFAULT_REAPER_GRACE_MS;
const foreignHours = Number(process.env.REAPER_FOREIGN_MIN_AGE_HOURS);
const alertUrl = process.env.ALERT_WEBHOOK_URL?.trim();

const result = await reapOrphans({
  backends: [
    // awaitVolumes: this process exits right after; a background volume delete would die with it.
    ...(secret ? [new ScalewayDeploymentBackend(secret, { projectId, awaitVolumes: true })] : []),
    ...(vastKey ? [new VastDeploymentBackend(vastKey)] : []),
  ],
  networks: secret ? [new ScalewayNetworkSweeper(secret, { projectId })] : [],
  namespace,
  gatewayUp: async () => (await fetch(`${gateway}/health`, { signal: AbortSignal.timeout(15_000) })).ok,
  ...(adminKey ? { owned: () => ownedFromGateway({ gatewayUrl: gateway, adminKey, namespace }) } : {}),
  graceMs,
  dryRun: !apply,
  applyForeign,
  ...(Number.isFinite(foreignHours) && foreignHours > 0 ? { foreignMinAgeMs: foreignHours * 3_600_000 } : {}),
  log: (msg, data) => console.log(msg, JSON.stringify(data ?? {})),
});
console.log(reapSummary(result), JSON.stringify(result));
const held = result.foreign.filter(f => f.holdsNeededQuota !== false);
if (alertUrl && (held.length || result.skipped)) {
  await fetch(alertUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ event: held.length ? 'reaper.foreign_quota_held' : 'reaper.not_checked', namespace, skipped: result.skipped ?? null, foreign: held }),
  }).catch(err => console.error('reaper: alert webhook failed', String(err)));
}
process.exit(reapExitCode(result));
