import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBE_PORT } from '../../../src/deployments/spec';
import { REPLICA_TLS_DIR, SCALEWAY_METADATA_URL, nginxConfig, replicaCloudInit } from '../../../src/deployments/cloud-init';
import { replicaBase } from '../../../src/deployments/http';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { ScalewayDeploymentBackend, TLS_TAG } from '../../../src/deployments/scaleway-backend';
import { buildSpec } from '../../../src/deployments/spec';
import type { GpuInstance } from '../../../src/gpu-providers/types';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const OTHER = 'zyxwvutsrqponmlkjihgfedcba543210';
const SRC = resolve(__dirname, '../../../src');
const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
const spec = buildSpec('speech', { image: 'ghcr.io/x/speech:1', port: 8000, machineType: 'L4-1-24G', zone: 'fr-par-2' }, { profiles });
const hasNginx = spawnSync('nginx', ['-v']).status === 0;

function written(script: string, path: string): string {
  const line = script.split('\n').find(l => l.endsWith(`| base64 -d > ${path}`))!;
  return Buffer.from(line.split("'")[1], 'base64').toString();
}

function tlsSection(init: string): string {
  const lines = init.split('\n');
  const from = lines.findIndex(l => l.startsWith('[ -n "$AIGW_TLS_SAN" ] ||'));
  const to = lines.findIndex(l => l.startsWith(`rm -f ${REPLICA_TLS_DIR}/ca.key`));
  return lines.slice(from, to + 1).join('\n');
}

function instance(id: string, tags: string[]): GpuInstance {
  return { instanceId: id, ipAddress: '51.15.0.1', status: 'running', providerMeta: { tags, zone: 'fr-par-2', state: 'running' } } as GpuInstance;
}

describe('S11b: the gateway talks to a Scaleway replica over TLS pinned to the replica token', () => {
  it('new Scaleway replicas are tagged and reached over https; replicas created before stay on http', async () => {
    const old = instance('fr-par-2:old', ['aigw-deploy', 'aigw-ns-ns', 'aigw-dep-speech']);
    const created = instance('fr-par-2:new', ['aigw-deploy', 'aigw-ns-ns', 'aigw-dep-speech', TLS_TAG]);
    let sentTags: string[] = [];
    const client = {
      createInstance: async (req: { tags: string[] }) => { sentTags = req.tags; return created; },
      listInstancesByTag: async () => [old, created],
      releaseInstance: async () => {}, getHourlyPrice: async () => 1, imageLike: async () => 'img',
      listSecurityGroups: async () => [{ id: 'g', name: 'aigw-ns-gateway-only' }],
    };
    const backend = new ScalewayDeploymentBackend('scw-secret-key-for-test', { client: client as never });
    const machine = await backend.createReplica({ spec, replicaToken: TOKEN, cloudInit: '', namespace: 'ns', network: { zone: 'fr-par-2', ipId: 'i', ip: '1.1.1.1', groupId: 'g' } });
    expect(sentTags).toContain(TLS_TAG);
    expect(machine.tls).toBe(true);
    const listed = await backend.listReplicas('ns');
    const byId = Object.fromEntries(listed.map(m => [m.id, m]));
    expect(replicaBase(byId['fr-par-2:new'])).toBe('https://51.15.0.1');
    expect(replicaBase(byId['fr-par-2:new'], true)).toBe(`https://51.15.0.1:${PROBE_PORT}`);
    expect(byId['fr-par-2:old'].tls).toBeUndefined();
    expect(replicaBase(byId['fr-par-2:old'])).toBe('http://51.15.0.1');
  });

  it('the cloud-init serves TLS on :80 (PROBE_PORT when exposed), makes the certificate before nginx starts and keeps the CA key out of the trace', () => {
    const init = replicaCloudInit(spec, TOKEN);
    expect(spawnSync('bash', ['-n'], { input: init }).status).toBe(0);
    expect(written(init, '/srv/aigw/nginx.conf')).toBe(nginxConfig(TOKEN, 80, 8000, undefined, true));
    expect(init).toMatch(/set \+x\necho '[A-Za-z0-9+/=]+' \| base64 -d > \/srv\/aigw\/tls\/ca\.key\nset -x/);
    expect(init.indexOf(`rm -f ${REPLICA_TLS_DIR}/ca.key`)).toBeLessThan(init.indexOf('systemctl restart nginx'));
    expect(init).toContain(SCALEWAY_METADATA_URL);
    const exposed = buildSpec('web', { image: 'ghcr.io/x/web:1', port: 3000, machineType: 'DEV1-S', zone: 'fr-par-2', exposure: { ports: [{ protocol: 'tcp', port: 443 }] } }, { profiles });
    expect(written(replicaCloudInit(exposed, TOKEN), '/srv/aigw/nginx.conf')).toContain(`listen ${PROBE_PORT} ssl default_server;`);
  });

  it.skipIf(!hasNginx)('end to end with the real nginx: the right token connects; another token, no pin or another host is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 's11b-'));
    try {
      const section = tlsSection(replicaCloudInit(spec, TOKEN)).replaceAll(REPLICA_TLS_DIR, dir);
      writeFileSync(join(dir, 'section.sh'), section);
      writeFileSync(join(dir, 'ready.json'), '{"ready":true}');
      const conf = nginxConfig(TOKEN, 0, 0, undefined, true).replaceAll(REPLICA_TLS_DIR, dir).replace('/srv/aigw/ready.json', join(dir, 'ready.json'));
      writeFileSync(join(dir, 'aigw.conf.tpl'), conf);
      const script = join(dir, 'probe.ts');
      writeFileSync(script, `
import { replicaTls } from '${SRC}/deployments/replica-tls';
import { HttpReplicaProbe } from '${SRC}/deployments/http';
const dir = '${dir}';
const meta = Bun.serve({ port: 0, fetch: () => Response.json({ id: 's', public_ip: { address: '127.0.0.1' }, public_ips: [{ address: '127.0.0.1', family: 'inet' }, { address: '2001:db8::1', family: 'inet6' }] }) });
const section = (await Bun.file(dir + '/section.sh').text()).replace('${SCALEWAY_METADATA_URL}', 'http://127.0.0.1:' + meta.port + '/conf');
const made = Bun.spawn(['bash', '-c', section], { stderr: 'pipe' });
if (await made.exited !== 0) throw new Error(await new Response(made.stderr).text());
meta.stop(true);
const san = Bun.spawnSync(['openssl', 'x509', '-in', dir + '/cert.pem', '-noout', '-ext', 'subjectAltName']).stdout.toString();
const up = Bun.serve({ port: 0, fetch(req, s) { if (s.upgrade(req)) return; return new Response(new URL(req.url).pathname === '/health' ? 'ok' : 'app:' + (req.headers.get('x-aigw-token') ?? 'stripped')); },
  websocket: { message(ws, m) { ws.send('echo:' + m); } } });
const port = 20000 + Math.floor(Math.random() * 20000);
const tpl = await Bun.file(dir + '/aigw.conf.tpl').text();
await Bun.write(dir + '/aigw.conf', tpl.replace('listen 0 ssl', 'listen ' + port + ' ssl').replace('http://127.0.0.1:0;', 'http://127.0.0.1:' + up.port + ';'));
await Bun.write(dir + '/nginx.conf', 'pid ' + dir + '/nginx.pid; error_log ' + dir + '/error.log; daemon off; events {}\\nhttp { access_log off; client_body_temp_path ' + dir + '; proxy_temp_path ' + dir + '; fastcgi_temp_path ' + dir + '; uwsgi_temp_path ' + dir + '; scgi_temp_path ' + dir + '; include ' + dir + '/aigw.conf; }');
const nginx = Bun.spawn(['nginx', '-p', dir, '-c', dir + '/nginx.conf'], { stderr: 'pipe' });
const base = 'https://127.0.0.1:' + port;
for (let i = 0; i < 50; i++) { try { await fetch(base, { tls: { rejectUnauthorized: false } } as never); break; } catch { await Bun.sleep(100); } }
const out: Record<string, string> = { san: san.includes('IP Address:127.0.0.1') && !san.includes('2001') ? 'ipv4 from metadata' : san };
const get = async (name: string, url: string, init: object) => {
  try { const r = await fetch(url, init as RequestInit); out[name] = r.status + ':' + await r.text(); } catch { out[name] = 'refused'; }
};
const ws = (url: string, tls: object) => new Promise<string>(res => {
  const w = new WebSocket(url, { headers: { 'X-Aigw-Token': '${TOKEN}' }, ...tls } as never);
  w.onopen = () => w.send('hi'); w.onmessage = (e) => { res(String(e.data)); w.close(); }; w.onerror = () => res('refused');
});
await get('right', base + '/x', { headers: { 'X-Aigw-Token': '${TOKEN}' }, ...replicaTls(base, '${TOKEN}') });
await get('wrongTokenHeader', base + '/x', { headers: { 'X-Aigw-Token': '${OTHER}' }, ...replicaTls(base, '${TOKEN}') });
await get('otherToken', base + '/x', { headers: { 'X-Aigw-Token': '${TOKEN}' }, ...replicaTls(base, '${OTHER}') });
await get('noPin', base + '/x', { headers: { 'X-Aigw-Token': '${TOKEN}' } });
await get('plainHttp', 'http://127.0.0.1:' + port + '/x', { headers: { 'X-Aigw-Token': '${TOKEN}' } });
await get('otherName', 'https://localhost:' + port + '/x', { headers: { 'X-Aigw-Token': '${TOKEN}' }, ...replicaTls('https://localhost', '${TOKEN}') });
out.wsRight = await ws('wss://127.0.0.1:' + port + '/ws', replicaTls('wss://x', '${TOKEN}'));
out.wsOther = await ws('wss://127.0.0.1:' + port + '/ws', replicaTls('wss://x', '${OTHER}'));
const probe = new HttpReplicaProbe(4000);
const machine = { id: 'r', deployment: 'd', ip: '127.0.0.1:' + port, state: 'running', createdAt: 0, zone: '', machineType: '', pricePerHour: null, tls: true };
out.probe = await probe.check(machine, { healthPath: '/health' } as never, '${TOKEN}');
out.probeOther = await probe.check(machine, { healthPath: '/health' } as never, '${OTHER}');
out.probeLegacyHttp = await probe.check({ ...machine, tls: undefined }, { healthPath: '/health' } as never, '${TOKEN}');
nginx.kill(); up.stop(true);
console.log(JSON.stringify(out));
`);
      const run = spawnSync('bun', [script], { encoding: 'utf8', timeout: 60_000 });
      expect(run.status, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout.trim().split('\n').pop()!);
      expect(result.plainHttp).toMatch(/^400:/);
      delete result.plainHttp;
      expect(result).toEqual({
        san: 'ipv4 from metadata', right: '200:app:stripped', wrongTokenHeader: expect.stringMatching(/^401:/),
        otherToken: 'refused', noPin: 'refused', otherName: 'refused',
        wsRight: 'echo:hi', wsOther: 'refused', probe: 'ready', probeOther: 'down', probeLegacyHttp: 'down',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
