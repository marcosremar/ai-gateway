/**
 * Orphan guard entry point (see src/deployments/reaper.ts). Runs as a Railway cron service next to the gateway:
 *
 *   SANDBOX_TOKEN=… GATEWAY_URL=https://ai-gateway.up.railway.app DEPLOYMENTS_NAMESPACE=prod \
 *     AI_GATEWAY_ADMIN_KEY=… bun scripts/reap-orphans.ts [--apply]
 *
 * Without `--apply` it is a DRY RUN (lists what it would release, releases nothing) — the default when run by hand.
 * The Railway cron (`railway.reaper.json`) passes `--apply`.
 *
 * Env: GATEWAY_URL (required); SCW_SECRET_KEY and/or VAST_API_KEY (or SANDBOX_TOKEN, which fetches them from the dev
 * API); DEPLOYMENTS_NAMESPACE (default `default`); SCW_DEFAULT_PROJECT_ID / SCW_PROJECT_ID (optional, scopes Scaleway);
 * AI_GATEWAY_ADMIN_KEY (an admin key of the gateway, i.e. a key whose user is in DEPLOYMENTS_ADMIN_USERS — enables the
 * cross-check while the gateway is up; never the SANDBOX_TOKEN); REAPER_GRACE_MINUTES (default 30).
 *
 * Exit 0 when nothing failed, 1 when a list or a release failed (the next run retries), 2 on bad configuration.
 */

import { loadSandboxEnv } from '../src/config/sandbox-env';
import { DEFAULT_REAPER_GRACE_MS, ownedFromGateway, reapOrphans } from '../src/deployments/reaper';
import { ScalewayDeploymentBackend } from '../src/deployments/scaleway-backend';
import { ScalewayNetworkSweeper } from '../src/deployments/scaleway-leftovers';
import { VastDeploymentBackend } from '../src/deployments/vast-backend';

const apply = process.argv.includes('--apply');
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
if (!adminKey) console.log('reaper: AI_GATEWAY_ADMIN_KEY not set — the cross-check while the gateway is up is off');

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
  log: (msg, data) => console.log(msg, JSON.stringify(data ?? {})),
});
console.log(apply ? 'reaper:' : 'reaper (dry run, pass --apply to release):', JSON.stringify(result));
process.exit(result.failed.length ? 1 : 0);
