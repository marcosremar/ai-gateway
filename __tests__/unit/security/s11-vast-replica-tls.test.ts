import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOSE_SSH, vastReplicaInit } from '../../../src/deployments/cloud-init';
import { replicaBase } from '../../../src/deployments/http';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { replicaCaCert, replicaTls } from '../../../src/deployments/replica-tls';
import { buildSpec } from '../../../src/deployments/spec';
import { VastDeploymentBackend } from '../../../src/deployments/vast-backend';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const OTHER = 'zyxwvutsrqponmlkjihgfedcba543210';
const SRC = resolve(__dirname, '../../../src');
const spec = buildSpec('speech', {
  provider: 'vast', image: 'vastai/base', bootScript: 'serve', port: 8010, machineType: 'RTX 5090', maxEurPerHour: 0.5,
}, { profiles: new Map(BUILTIN_PROFILES.map(p => [p.name, p])) });

function tlsSection(init: string): string {
  const lines = init.split('\n');
  const from = lines.findIndex(l => l.includes('"$PUBLIC_IPADDR" ] || eval'));
  const to = lines.findIndex(l => l.startsWith('rm -f /srv/aigw/tls/ca.key'));
  return lines.slice(from, to + 1).join('\n');
}

describe('S11: the gateway talks to a Vast replica over TLS pinned to the replica token, and the host SSH is closed', () => {
  it('Vast machines are TLS fronts: created and listed with tls, reached over https', async () => {
    const fetchImpl = async (url: string) => new Response(JSON.stringify(
      url.endsWith('/bundles/') ? { offers: [{ id: 2, machine_id: 102, geolocation: 'Paris, FR', dph_total: 0.3, reliability2: 0.99, inet_down: 900 }] }
        : url.endsWith('/instances/') ? { instances: [{ id: 7, label: 'aigw:ns:speech', public_ipaddr: '1.2.3.4', ports: { '80/tcp': [{ HostPort: '16729' }] } }] }
          : { success: true, new_contract: 7 }));
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl as typeof fetch });
    expect((await backend.createReplica({ spec, replicaToken: TOKEN, cloudInit: '', namespace: 'ns' })).tls).toBe(true);
    const [listed] = await backend.listReplicas('ns');
    expect(listed.tls).toBe(true);
    expect(replicaBase(listed)).toBe('https://1.2.3.4:16729');
    expect(replicaBase({ ip: '1.2.3.4' })).toBe('http://1.2.3.4');
  });

  it('the boot script serves TLS on :80, keeps the CA key out of the trace, and closes SSH before anything else', () => {
    const init = vastReplicaInit(spec, TOKEN);
    expect(spawnSync('bash', ['-n'], { input: init }).status).toBe(0);
    const nginx = Buffer.from(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/srv\/aigw\/nginx.conf/.exec(init)![1], 'base64').toString();
    expect(nginx).toContain('listen 80 ssl default_server;');
    expect(nginx).toContain('ssl_certificate /srv/aigw/tls/cert.pem;');
    expect(init).toMatch(/set \+x\necho '[A-Za-z0-9+/=]+' \| base64 -d > \/srv\/aigw\/tls\/ca\.key\nset -x/);
    expect(init).toContain('rm -f /srv/aigw/tls/ca.key');
    expect(init).toContain(CLOSE_SSH);
    expect(CLOSE_SSH).toContain('rm -f /root/.ssh/authorized_keys');
    expect(init.indexOf(CLOSE_SSH)).toBeLessThan(init.indexOf('nginx -t'));
  });

  it('only a CA derived from the same token is trusted, and only https URLs carry it', () => {
    expect(replicaCaCert(TOKEN)).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(replicaCaCert(TOKEN)).not.toBe(replicaCaCert(OTHER));
    expect(replicaTls('https://1.2.3.4:1', TOKEN)).toEqual({ tls: { ca: replicaCaCert(TOKEN) } });
    expect(replicaTls('wss://1.2.3.4:1', TOKEN).tls).toBeDefined();
    expect(replicaTls('http://1.2.3.4:1', TOKEN)).toEqual({});
  });

  it('end to end in Bun: the certificate the boot script makes is accepted with the right token and refused otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 's11-'));
    const section = tlsSection(vastReplicaInit(spec, TOKEN)).replaceAll('/srv/aigw/tls', dir);
    const made = spawnSync('bash', ['-c', section], { env: { ...process.env, PUBLIC_IPADDR: '127.0.0.1' }, encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const script = join(dir, 'probe.ts');
    writeFileSync(script, `
import { replicaTls } from '${SRC}/deployments/replica-tls';
import { HttpReplicaProbe } from '${SRC}/deployments/http';
const srv = Bun.serve({ port: 0, tls: { key: Bun.file('${dir}/key.pem'), cert: Bun.file('${dir}/cert.pem') },
  fetch(req, s) { if (s.upgrade(req)) return; return new Response(req.headers.get('x-aigw-token') === '${TOKEN}' ? '{}' : 'no', { status: req.headers.get('x-aigw-token') === '${TOKEN}' ? 200 : 401 }); },
  websocket: { message(ws, m) { ws.send('echo:' + m); } } });
const out: Record<string, string> = {};
const get = async (name: string, url: string, init: object) => {
  try { out[name] = String((await fetch(url, init as RequestInit)).status); } catch { out[name] = 'refused'; }
};
const ws = (url: string, tls: object) => new Promise<string>(res => {
  const w = new WebSocket(url, { headers: {}, ...tls } as never);
  w.onopen = () => w.send('hi'); w.onmessage = (e) => { res(String(e.data)); w.close(); }; w.onerror = () => res('refused');
});
const ip = 'https://127.0.0.1:' + srv.port;
await get('right', ip + '/x', { headers: { 'X-Aigw-Token': '${TOKEN}' }, ...replicaTls(ip, '${TOKEN}') });
await get('otherToken', ip + '/x', replicaTls(ip, '${OTHER}'));
await get('noPin', ip + '/x', {});
await get('otherName', 'https://localhost:' + srv.port + '/x', replicaTls('https://localhost', '${TOKEN}'));
out.wsRight = await ws('wss://127.0.0.1:' + srv.port, replicaTls('wss://x', '${TOKEN}'));
out.wsOther = await ws('wss://127.0.0.1:' + srv.port, replicaTls('wss://x', '${OTHER}'));
const probe = new HttpReplicaProbe(4000);
const machine = { id: 'r', deployment: 'd', ip: '127.0.0.1:' + srv.port, state: 'running', createdAt: 0, zone: '', machineType: '', pricePerHour: null, tls: true };
out.probe = await probe.check(machine, { healthPath: '/health' } as never, '${TOKEN}');
out.probeOther = await probe.check(machine, { healthPath: '/health' } as never, '${OTHER}');
srv.stop(true);
console.log(JSON.stringify(out));
`);
    const run = spawnSync('bun', [script], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim().split('\n').pop()!)).toEqual({
      right: '200', otherToken: 'refused', noPin: 'refused', otherName: 'refused',
      wsRight: 'echo:hi', wsOther: 'refused', probe: 'ready', probeOther: 'down',
    });
  });
});
