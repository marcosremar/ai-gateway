import { loadSandboxEnv } from '../../src/config/sandbox-env';
import { VAST_API, VastDeploymentBackend } from '../../src/deployments/vast-backend';

const [command, id] = process.argv.slice(2);
await loadSandboxEnv(process.env);
const key = process.env.VAST_API_KEY?.trim();
const namespace = process.env.DEPLOYMENTS_NAMESPACE?.trim();
if (!key || !namespace) {
  console.error('vast-stress: VAST_API_KEY (or SANDBOX_TOKEN) and DEPLOYMENTS_NAMESPACE are required');
  process.exit(2);
}
const backend = new VastDeploymentBackend(key);

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${VAST_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`vast ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function own(instanceId: string) {
  const machine = (await backend.listReplicas(namespace!)).find(m => m.id === instanceId);
  if (!machine) throw new Error(`instance ${instanceId} is not labelled aigw:${namespace}: — refusing to touch it`);
  return machine;
}

if (command === 'balance') {
  const user = await api('GET', '/users/current/');
  console.log(JSON.stringify({ at: new Date().toISOString(), credit: user.credit, balance: user.balance }));
} else if (command === 'list') {
  const mine = await backend.listReplicas(namespace);
  const foreign = await backend.listForeign(namespace);
  console.log(JSON.stringify({
    at: new Date().toISOString(), namespace,
    mine: mine.map(m => ({ id: m.id, deployment: m.deployment, state: m.state, ip: m.ip, zone: m.zone, pricePerHour: m.pricePerHour })),
    otherNamespaces: foreign.map(m => ({ namespace: m.namespace, id: m.id, state: m.state })),
  }, null, 1));
} else if (command === 'show' && id) {
  await own(id);
  const { instances } = await api('GET', `/instances/${id}/`) as { instances: Record<string, unknown> };
  const pick = ['id', 'machine_id', 'actual_status', 'intended_status', 'status_msg', 'public_ipaddr', 'ports', 'geolocation', 'gpu_name',
    'dph_total', 'start_date', 'duration', 'inet_down', 'inet_up', 'reliability2', 'driver_version', 'cuda_max_good'];
  console.log(JSON.stringify(Object.fromEntries(pick.map(k => [k, instances?.[k]])), null, 1));
} else if (command === 'destroy' && id) {
  await backend.releaseReplica(await own(id));
  console.log(JSON.stringify({ at: new Date().toISOString(), destroyed: id }));
} else if (command === 'stop' && id) {
  await own(id);
  await api('PUT', `/instances/${id}/`, { state: 'stopped' });
  console.log(JSON.stringify({ at: new Date().toISOString(), stopped: id }));
} else {
  console.error('usage: bun scripts/vast-stress/vast.ts balance | list | show <instance id> | destroy <instance id> | stop <instance id>');
  process.exit(2);
}
