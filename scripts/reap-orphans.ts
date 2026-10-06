/**
 * Orphan guard entry point (see src/deployments/reaper.ts). Runs as a Railway cron service next to the gateway:
 *
 *   SANDBOX_TOKEN=… GATEWAY_URL=https://ai-gateway.up.railway.app DEPLOYMENTS_NAMESPACE=prod bun scripts/reap-orphans.ts
 *
 * Exit 0 when the gateway is up or every orphan was released, 1 when a release failed (the next run retries).
 */

import { loadSandboxEnv } from '../src/config/sandbox-env';
import { reapIfGatewayDown } from '../src/deployments/reaper';
import { ScalewayDeploymentBackend } from '../src/deployments/scaleway-backend';
import { VastDeploymentBackend } from '../src/deployments/vast-backend';

await loadSandboxEnv(process.env);
const secret = process.env.SCW_SECRET_KEY || process.env.SCALEWAY_SECRET_KEY;
const vastKey = process.env.VAST_API_KEY;
const gateway = (process.env.GATEWAY_URL || '').replace(/\/$/, '');
if ((!secret && !vastKey) || !gateway) {
  console.error('reaper: SCW_SECRET_KEY and/or VAST_API_KEY (or SANDBOX_TOKEN) and GATEWAY_URL are required');
  process.exit(2);
}
const projectId = process.env.SCW_DEFAULT_PROJECT_ID || process.env.SCW_PROJECT_ID || process.env.SCALEWAY_PROJECT_ID || undefined;
const result = await reapIfGatewayDown({
  backends: [
    ...(secret ? [new ScalewayDeploymentBackend(secret, { projectId })] : []),
    ...(vastKey ? [new VastDeploymentBackend(vastKey)] : []),
  ],
  namespace: process.env.DEPLOYMENTS_NAMESPACE || 'default',
  gatewayUp: async () => (await fetch(`${gateway}/health`, { signal: AbortSignal.timeout(15_000) })).ok,
  log: (msg, data) => console.log(msg, JSON.stringify(data ?? {})),
});
console.log('reaper:', JSON.stringify(result));
process.exit(result.failed.length ? 1 : 0);
