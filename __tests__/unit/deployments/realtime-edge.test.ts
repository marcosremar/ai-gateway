/**
 * `spec.realtime` — the generic realtime edge sidecar (docker/aigw-edge, docs/realtime-edge.md): the replica's
 * first-boot script, its nginx front, its firewall, and the coturn TURN profile.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_EDGE_IMAGE, edgeEnv, nginxConfig, replicaCloudInit, RT_EDGE_PORT } from '../../../src/deployments/cloud-init';
import { BUILTIN_PROFILES, COTURN_RELAY_PORTS } from '../../../src/deployments/profiles';
import { realtimeGroupName, ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { buildSpec } from '../../../src/deployments/spec';

const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
const TOKEN = 'r'.repeat(32);
const speech = (extra: Record<string, unknown> = {}) => buildSpec('speech', { profile: 'speech-stack', ...extra }, { profiles });

/** The base64 file a cloud-init writes to `path`, decoded. */
function written(script: string, path: string): string | null {
  const line = script.split('\n').find(l => l.includes(` | base64 -d > ${path}`));
  const m = line && /echo '([A-Za-z0-9+/=]+)'/.exec(line);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
}

const bashOk = (script: string) => spawnSync('bash', ['-n'], { input: script }).status === 0;
const hasNginx = spawnSync('nginx', ['-v']).status === 0;

describe('cloud-init with and without realtime', () => {
  it('without realtime: no edge, no /__aigw/rt/ route', () => {
    const script = replicaCloudInit(speech(), TOKEN);
    expect(script).not.toContain('aigw-edge');
    expect(written(script, '/srv/aigw/edge.env')).toBeNull();
    expect(written(script, '/srv/aigw/nginx.conf')).not.toContain('/__aigw/rt/');
    expect(bashOk(script)).toBe(true);
  });

  it('with realtime: the sidecar on the host network, its env, the nginx route behind the token gate', () => {
    const spec = speech({ machineType: 'L40S-1-48G', realtime: {} });
    const script = replicaCloudInit(spec, TOKEN, { gatewayUrl: 'https://gw.example/' });
    expect(bashOk(script)).toBe(true);
    expect(script).toContain(`docker run -d --name aigw-edge --restart unless-stopped --network host --env-file /srv/aigw/edge.env '${DEFAULT_EDGE_IMAGE}'`);
    const env = Object.fromEntries(written(script, '/srv/aigw/edge.env')!.trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)));
    expect(env).toEqual({
      RT_MAX_SESSIONS: '16', // the L40S preset of the speech-stack profile
      RT_UDP_PORTS: '50000-50100', RT_PORT: String(RT_EDGE_PORT), RT_BIND: '127.0.0.1',
      EDGE_UPSTREAM: 'http://127.0.0.1:8000', AIGW_DEPLOYMENT: 'speech', AIGW_REPLICA_TOKEN: TOKEN,
      GATEWAY_URL: 'https://gw.example',
    });
    // Replica id (the token's `rep`, telemetry's X-Aigw-Replica) and public IP come from the machine itself.
    expect(script).toContain('echo "AIGW_REPLICA_ID=$RID" >> /srv/aigw/edge.env && echo "RT_PUBLIC_IP=$PUB" >> /srv/aigw/edge.env');
    expect(script).toMatch(/chmod 600 \/srv\/aigw\/edge\.env/);
    const nginx = written(script, '/srv/aigw/nginx.conf')!;
    expect(nginx).toContain(`location ^~ /__aigw/rt/ {`);
    expect(nginx).toContain(`proxy_pass http://127.0.0.1:${RT_EDGE_PORT};`);
    expect(nginx).toContain('large_client_header_buffers 4 16k;');
    // The token check is server-wide (auth_request), so it covers /__aigw/rt/* and the WS upgrade too.
    expect(nginx.indexOf('auth_request /__aigw/auth;')).toBeLessThan(nginx.indexOf('location ^~ /__aigw/rt/'));
    // The edge starts after the model container, before the readiness loop.
    expect(script.indexOf('--name app')).toBeLessThan(script.indexOf('--name aigw-edge'));
    expect(script.indexOf('--name aigw-edge')).toBeLessThan(script.indexOf('ready.json'));
  });

  it('realtime fields override: maxSessions, edgeImage, udpPorts; L4 preset; telemetry URL from AIGW_PUBLIC_URL', () => {
    vi.stubEnv('AIGW_PUBLIC_URL', 'https://gw2.example');
    try {
      expect(edgeEnv(speech({ machineType: 'L4-1-24G', realtime: {} }), TOKEN)).toMatchObject({ RT_MAX_SESSIONS: '8', GATEWAY_URL: 'https://gw2.example' });
      expect(edgeEnv(speech({ realtime: {} }), TOKEN)).toMatchObject({ RT_MAX_SESSIONS: '16' });
      const spec = speech({ realtime: { maxSessions: 5, edgeImage: 'ghcr.io/x/edge:2', udpPorts: [40000, 40049] } });
      const script = replicaCloudInit(spec, TOKEN);
      expect(edgeEnv(spec, TOKEN)).toMatchObject({ RT_MAX_SESSIONS: '5', RT_UDP_PORTS: '40000-40049' });
      expect(script).toContain("--env-file /srv/aigw/edge.env 'ghcr.io/x/edge:2'");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('boot-script mode: the edge reaches the app on spec.port', () => {
    const spec = buildSpec('bs', { bootScript: 'echo hi', port: 8010, machineType: 'L4-1-24G', realtime: {} }, { profiles });
    expect(edgeEnv(spec, TOKEN).EDGE_UPSTREAM).toBe('http://127.0.0.1:8010');
    expect(bashOk(replicaCloudInit(spec, TOKEN))).toBe(true);
  });

  it.skipIf(!hasNginx)('the generated nginx config passes `nginx -t`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aigw-nginx-'));
    try {
      writeFileSync(join(dir, 'aigw.conf'), nginxConfig(TOKEN, 18080, 8000, RT_EDGE_PORT));
      writeFileSync(join(dir, 'nginx.conf'), `pid ${dir}/nginx.pid; error_log ${dir}/error.log; events {}
http { access_log off; client_body_temp_path ${dir}; proxy_temp_path ${dir}; fastcgi_temp_path ${dir}; uwsgi_temp_path ${dir}; scgi_temp_path ${dir}; include ${dir}/aigw.conf; }`);
      const run = spawnSync('nginx', ['-t', '-p', dir, '-c', join(dir, 'nginx.conf')], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('realtime spec validation', () => {
  it('accepts the fields and refuses the rest', () => {
    expect(speech({ realtime: { maxSessions: 16, udpPorts: [50000, 50100] } }).realtime).toEqual({ maxSessions: 16, udpPorts: [50000, 50100] });
    expect(() => speech({ realtime: { foo: 1 } })).toThrow(/unknown field 'foo'/);
    expect(() => speech({ realtime: { udpPorts: [50000] } })).toThrow(/\[lo, hi\]/);
    expect(() => speech({ realtime: { udpPorts: [80, 100] } })).toThrow(/udpPorts\[0\]/);
    expect(() => speech({ realtime: { udpPorts: [50000, 52000] } })).toThrow(/udpPorts\[1\]/);
    expect(() => speech({ realtime: { maxSessions: 0 } })).toThrow(/maxSessions/);
  });

  it('is refused on vast (one container per host: no sidecar)', () => {
    expect(() => buildSpec('v', { provider: 'vast', image: 'vastai/base', bootScript: 'x', machineType: 'RTX 4090', realtime: {} }, { profiles }))
      .toThrow(/realtime is not supported on vast/);
  });
});

function fakeClient() {
  return {
    createInstance: vi.fn(async (spec: Record<string, unknown>) => ({
      instanceId: `${spec.region}:srv-1`, ipAddress: '51.0.0.1', status: 'starting',
      providerMeta: { zone: spec.region, tags: spec.tags as string[] },
    })),
    listInstancesByTag: vi.fn(async () => []),
    releaseInstance: vi.fn(async () => {}),
    getHourlyPrice: vi.fn(async () => 1.47),
    imageLike: vi.fn(async () => 'img'),
    defaultProjectId: vi.fn(async () => 'proj'),
    listSecurityGroups: vi.fn(async (): Promise<Array<{ id: string; name: string }>> => []),
    createSecurityGroup: vi.fn(async (_zone: string, _c: unknown, opts: { name: string }) => `sg-${opts.name}`),
    listIps: vi.fn(async () => []),
    reserveRoutedIp: vi.fn(async () => ({ id: 'ip-1', address: '51.15.0.9' })),
  };
}

describe('firewall of realtime replicas (fake Scaleway)', () => {
  it('a realtime replica gets the shared realtime group: TCP 80 + its UDP range; a plain one keeps the gateway-only group', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never, projectId: 'proj' });
    await backend.createReplica({ spec: speech({ realtime: {} }), replicaToken: TOKEN, cloudInit: 'x', namespace: 'prod' });
    await backend.createReplica({ spec: speech({ realtime: {} }), replicaToken: TOKEN, cloudInit: 'x', namespace: 'prod' });
    await backend.createReplica({ spec: speech(), replicaToken: TOKEN, cloudInit: 'x', namespace: 'prod' });
    const created = client.createSecurityGroup.mock.calls.map(c => c[2] as { name: string; rules: unknown[] });
    expect(created.map(g => g.name)).toEqual([realtimeGroupName('prod', [50000, 50100]), 'aigw-prod-gateway-only']);
    expect(created[0].rules).toEqual([{ protocol: 'TCP', port: 80 }, { protocol: 'UDP', port: 50000, portTo: 50100 }]);
    expect(created[1].rules).toEqual([{ protocol: 'TCP', port: 80 }]);
    const groups = client.createInstance.mock.calls.map(c => (c[0] as { securityGroupId: string }).securityGroupId);
    expect(groups).toEqual([`sg-${realtimeGroupName('prod', [50000, 50100])}`, `sg-${realtimeGroupName('prod', [50000, 50100])}`, 'sg-aigw-prod-gateway-only']);
  });

  it('coturn: exposure with its relay range as one rule, plus the probe port', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never, projectId: 'proj' });
    const spec = buildSpec('turn', { profile: 'coturn', env: { REALTIME_TURN_SECRET: 's'.repeat(32) } }, { profiles });
    await backend.ensureNetwork(spec, 'prod');
    const rules = (client.createSecurityGroup.mock.calls[0][2] as { rules: unknown[] }).rules;
    expect(rules).toEqual([
      { protocol: 'UDP', port: 3478 }, { protocol: 'TCP', port: 3478 }, { protocol: 'TCP', port: 443 },
      { protocol: 'UDP', port: COTURN_RELAY_PORTS[0], portTo: COTURN_RELAY_PORTS[1] }, { protocol: 'TCP', port: 8089 },
    ]);
  });
});

describe('coturn profile', () => {
  it('builds, boots coturn with use-auth-secret on the host network, and its scripts parse', () => {
    const spec = buildSpec('turn', { profile: 'coturn', env: { REALTIME_TURN_SECRET: 's'.repeat(32) } }, { profiles });
    expect(spec).toMatchObject({ machineType: 'DEV1-S', gpu: false, port: 9641, healthPath: '/metrics' });
    expect(spec.bootScript).toContain('--use-auth-secret --static-auth-secret="$REALTIME_TURN_SECRET"');
    expect(spec.bootScript).toMatch(/coturn\/coturn:\d+\.\d+\.\d+/);
    expect(spec.bootScript).toContain('--dport 443 -j REDIRECT --to-ports 3478');
    expect(spec.bootScript).toContain('--denied-peer-ip=10.0.0.0-10.255.255.255');
    expect(bashOk(spec.bootScript!)).toBe(true);
    expect(bashOk(replicaCloudInit(spec, TOKEN))).toBe(true);
  });

  it('refuses a relay range that would cover the probe port', () => {
    expect(() => buildSpec('t', { profile: 'coturn', exposure: { ports: [{ protocol: 'tcp', port: 8000, to: 8100 }] } }, { profiles }))
      .toThrow(/probe port/);
  });
});
