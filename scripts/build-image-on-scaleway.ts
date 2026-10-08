/**
 * Builds a Docker context on a short-lived Scaleway CPU machine and pushes it to the Scaleway Container Registry
 * (rg.fr-par.scw.cloud/<namespace>), next to the GPUs that pull it. For images too big for a CI runner or a laptop
 * (docker/speech-stack: CUDA base + three models ≈ 25 GB).
 *
 *   SCW_SECRET_KEY=… [SCW_PROJECT_ID=…] bun scripts/build-image-on-scaleway.ts docker/speech-stack speech-stack
 *   … --app parle [--gateway https://parle-ai-gateway.up.railway.app]   also saves the address in the app's account
 *       (PUT /v1/apps/parle/images/speech-stack, with SANDBOX_TOKEN), so deploys name it: {"appImage": "speech-stack"}
 *
 * The machine serves only its build status on :80 (/done.json, /build.log — no secrets), the script polls it, prints
 * the log tail, and deletes the machine (and its volume) whatever happens.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ScalewayClient } from '../src/cpu-providers/scaleway-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';
import { loadSandboxEnv } from '../src/config/sandbox-env';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const appId = flag('app');
const gatewayUrl = (flag('gateway') ?? process.env.GATEWAY_URL ?? 'https://parle-ai-gateway.up.railway.app').replace(/\/$/, '');
const [contextDir, imageName] = args;
if (!contextDir || !imageName || !/^[a-z0-9-]+$/.test(imageName)) {
  console.error('usage: bun scripts/build-image-on-scaleway.ts <context-dir> <image-name>');
  process.exit(2);
}
await loadSandboxEnv(process.env);
const secret = process.env.SCW_SECRET_KEY || process.env.SCALEWAY_SECRET_KEY;
const projectId = process.env.SCW_PROJECT_ID || process.env.SCW_DEFAULT_PROJECT_ID;
if (!secret || !projectId) throw new Error('SCW_SECRET_KEY and SCW_PROJECT_ID are required (or SANDBOX_TOKEN)');
const ZONE = process.env.BUILD_ZONE || 'fr-par-2';
const REGION = ZONE.slice(0, -2);
const NAMESPACE = process.env.REGISTRY_NAMESPACE || 'aigw';
const TYPE = process.env.BUILD_TYPE || 'POP2-HC-8C-16G';
const tag = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const registry = `rg.${REGION}.scw.cloud`;
const image = `${registry}/${NAMESPACE}/${imageName}:${tag}`;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function scw(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.scaleway.com${path}`, {
    ...init, headers: { 'X-Auth-Token': secret!, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`scaleway ${res.status} ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body as Record<string, unknown>;
}

// 1. Registry namespace (private), created once.
const list = await scw(`/registry/v1/regions/${REGION}/namespaces?project_id=${projectId}&name=${NAMESPACE}`) as { namespaces: { name: string }[] };
if (!list.namespaces.some(n => n.name === NAMESPACE)) {
  await scw(`/registry/v1/regions/${REGION}/namespaces`, {
    method: 'POST', body: JSON.stringify({ name: NAMESPACE, project_id: projectId, is_public: false, description: 'ai-gateway images' }),
  });
  log('registry namespace created', NAMESPACE);
}

// 2. Context files, embedded in the boot script (small text files only).
const files = readdirSync(contextDir).filter(f => statSync(join(contextDir, f)).isFile());
const total = files.reduce((n, f) => n + statSync(join(contextDir, f)).size, 0);
if (total > 80_000) throw new Error(`context ${total} bytes: keep it under 80 KB (the boot script must stay under 128 KB)`);
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const writes = files.map(f => `echo '${b64(readFileSync(join(contextDir, f)))}' | base64 -d > /srv/ctx/${f}`).join('\n');
const script = `#!/bin/bash
mkdir -p /srv/ctx /srv/status
exec > >(tee -a /srv/status/build.log) 2>&1
set -x
shutdown -h +240
echo '{"state":"booting"}' > /srv/status/done.json
(cd /srv/status && nohup python3 -m http.server 80 >/dev/null 2>&1 &)
${writes}
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
set +x  # the build log is served on :80: the key must never be traced into it
echo '${secret}' | docker login ${registry}/${NAMESPACE} -u nologin --password-stdin
set -x
echo '{"state":"building"}' > /srv/status/done.json
started=$(date +%s)
push() { for i in 1 2 3 4 5; do docker push ${image} && return 0; sleep 20; done; return 1; }
if cd /srv/ctx && DOCKER_BUILDKIT=1 docker build --progress=plain -t ${image} . && push; then
  digest=$(docker image inspect --format '{{index .RepoDigests 0}}' ${image})
  size=$(docker image inspect --format '{{.Size}}' ${image})
  echo "{\\"state\\":\\"done\\",\\"ok\\":true,\\"image\\":\\"${image}\\",\\"digest\\":\\"$digest\\",\\"size\\":$size,\\"seconds\\":$(( $(date +%s) - started ))}" > /srv/status/done.json
else
  echo "{\\"state\\":\\"done\\",\\"ok\\":false,\\"seconds\\":$(( $(date +%s) - started ))}" > /srv/status/done.json
fi
`;

// 3. Machine → poll → delete.
const client = new ScalewayClient();
const credentials = { apiKey: secret } as ProviderCredentials;
log(`creating ${TYPE} in ${ZONE} to build ${image}`);
const inst = await client.createInstance({
  label: `aigw-build-${imageName}`, region: ZONE, commercialType: TYPE, volumeGb: 150, tags: ['aigw-build'], cloudInit: script, projectId,
}, credentials);
log('machine', inst.instanceId, inst.ipAddress);
// Stopped from outside (Ctrl-C, kill): still delete the machine and its volume — an orphaned build box keeps billing.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log(`${signal}: deleting build machine`);
    client.releaseInstance(inst.instanceId, credentials, { awaitVolumes: true }).catch(e => log('release failed', e))
      .finally(() => process.exit(130));
  });
}
let result: Record<string, unknown> = {};
try {
  const deadline = Date.now() + 120 * 60_000;
  let lastLen = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 30_000));
    const done = await fetch(`http://${inst.ipAddress}/done.json`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()).catch(() => null);
    const text = await fetch(`http://${inst.ipAddress}/build.log`, { signal: AbortSignal.timeout(10_000) }).then(r => r.text()).catch(() => '');
    const fresh = text.slice(lastLen).split('\n').filter(l => /^#\d+ (DONE|ERROR)|^#\d+ \[|pushed|digest:|error|Error/.test(l)).slice(-6);
    if (fresh.length) fresh.forEach(l => log('  ', l.slice(0, 160)));
    lastLen = text.length;
    if (done?.state === 'done') { result = done; break; }
    log('state', done?.state ?? 'unreachable');
  }
} finally {
  log('deleting build machine');
  await client.releaseInstance(inst.instanceId, credentials, { awaitVolumes: true }).catch(e => log('release failed', e));
}
log('result', JSON.stringify(result));
if (result.ok && appId) {
  // Save the address in the app's account: later deploys name the image instead of carrying the registry address.
  const token = process.env.SANDBOX_TOKEN || process.env.PALCO_PROXY_TOKEN || process.env.PALCO_PROXY;
  const digest = typeof result.digest === 'string' ? result.digest.split('@')[1] ?? null : null;
  const res = await fetch(`${gatewayUrl}/v1/apps/${appId}/images/${imageName}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'X-App': appId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, ...(digest ? { digest } : {}) }),
  }).catch((err) => ({ ok: false, status: 0, text: async () => String(err) }) as const);
  log(res.ok ? `saved in app '${appId}' as image '${imageName}'` : `could not save in app '${appId}': HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
process.exit(result.ok ? 0 : 1);
