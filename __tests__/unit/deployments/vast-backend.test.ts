import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { edgeEnv, nginxConfig, RT_EDGE_PORT, VAST_EDGE_DIR, vastEdgeEnv, vastReplicaInit } from '../../../src/deployments/cloud-init';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec, VAST_ENV_MAX_BYTES } from '../../../src/deployments/spec';
import {
  BAD_HOST_MS, EUR_TO_USD, LIST_CACHE_MS, LIST_STALE_MAX_MS, MIN_RELIABILITY, TOO_FAR_HOST_MS, VastDeploymentBackend, vastState,
} from '../../../src/deployments/vast-backend';
import type { DeploymentSpec } from '../../../src/deployments/types';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));

function vastSpec(extra: Record<string, unknown> = {}): DeploymentSpec {
  return buildSpec('speech', {
    provider: 'vast', image: 'vllm/vllm-omni:v0.28.0', bootScript: 'python3 -m http.server 8010', port: 8010,
    machineType: 'RTX 5090', maxEurPerHour: 0.5, volumeGb: 80, env: { HF_TOKEN: 'hf' }, ...extra,
  }, { profiles });
}

interface Call { method: string; url: string; body: Record<string, unknown> | null }

function fakeVast(routes: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
    calls.push(call);
    const { status = 200, body } = routes(call);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

const offers = [
  { id: 1, machine_id: 101, geolocation: 'Dallas, US', dph_total: 0.30, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 5090' },
  { id: 2, machine_id: 102, geolocation: 'Paris, FR', dph_total: 0.45, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 5090' },
  { id: 3, machine_id: 103, geolocation: 'Frankfurt, DE', dph_total: 0.47, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 5090' },
  // Over the cap (the API filter is not trusted): never rented.
  { id: 4, machine_id: 104, geolocation: 'Paris, FR', dph_total: 0.90, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 5090' },
];

describe('VastDeploymentBackend', () => {
  it('searches with the cap in USD, reliability, direct port and GPU; rents the French offer with the namespace label', async () => {
    const { calls, fetchImpl } = fakeVast(({ method, url }) => {
      if (method === 'POST' && url.endsWith('/bundles/')) return { body: { offers } };
      if (method === 'PUT' && url.endsWith('/asks/2/')) return { body: { success: true, new_contract: 777 } };
      return { status: 500, body: 'unexpected' };
    });
    const backend = new VastDeploymentBackend('vast-key', { fetch: fetchImpl, now: () => 1_000 });
    const machine = await backend.createReplica({ spec: vastSpec(), replicaToken: TOKEN, cloudInit: '', namespace: 'prod' });

    const search = calls[0].body!;
    expect(search).toMatchObject({
      rentable: { eq: true }, verified: { eq: true }, num_gpus: { eq: 1 }, gpu_name: { in: ['RTX 5090'] },
      disk_space: { gte: 80 }, cuda_max_good: { gte: 12.8 }, reliability2: { gte: MIN_RELIABILITY },
      inet_down: { gte: 500 }, direct_port_count: { gte: 1 }, dph_total: { lte: Math.round(0.5 * EUR_TO_USD * 1000) / 1000 },
    });
    const rent = calls[1];
    expect(rent.url).toBe('https://console.vast.ai/api/v0/asks/2/');
    expect(rent.body).toMatchObject({ image: 'vllm/vllm-omni:v0.28.0', label: 'aigw:prod:speech', disk: 80 });
    const env = rent.body!.env as Record<string, string>;
    expect(env['-p 80:80']).toBe('1');
    expect(env.HF_TOKEN).toBe('hf');
    expect(Buffer.from(env.AIGW_INIT_B64, 'base64').toString('utf8')).toBe(vastReplicaInit(vastSpec(), TOKEN));
    expect(String(rent.body!.onstart)).toContain('AIGW_INIT_B64');
    expect(machine).toMatchObject({ id: '777', deployment: 'speech', provider: 'vast', ip: null, zone: 'Paris, FR', state: 'starting' });
    expect(machine.pricePerHour).toBeCloseTo(0.45 / EUR_TO_USD, 3);
    for (const c of calls) expect(c.url.startsWith('https://console.vast.ai/api/v0/')).toBe(true);
  });

  it('a spec with registryAuth rents with image_login; without it the field is absent', async () => {
    const run = async (extra: Record<string, unknown>) => {
      const { calls, fetchImpl } = fakeVast(({ method }) => (method === 'POST' ? { body: { offers } } : { body: { success: true, new_contract: 1 } }));
      await new VastDeploymentBackend('vast-key', { fetch: fetchImpl, now: () => 1_000 })
        .createReplica({ spec: vastSpec(extra), replicaToken: TOKEN, cloudInit: '', namespace: 'prod' });
      return calls[1].body!;
    };
    expect((await run({ registryAuth: { server: 'rg.fr-par.scw.cloud', username: 'nologin', password: 'pull-only' } })).image_login)
      .toBe('-u nologin -p pull-only rg.fr-par.scw.cloud');
    expect(await run({})).not.toHaveProperty('image_login');
  });

  it('previewOffers lists the ranking a create would walk, without renting', async () => {
    const { calls, fetchImpl } = fakeVast(() => ({ body: { offers: offers.map(o => ({ ...o, inet_up: 800, direct_port_count: 12 })) } }));
    const preview = await new VastDeploymentBackend('vast-key', { fetch: fetchImpl, now: () => 1_000 }).previewOffers(vastSpec());
    expect(preview.map(o => [o.rank, o.offerId, o.location, o.distanceKm])).toEqual([[1, 2, 'Paris, FR', 0], [2, 3, 'Frankfurt, DE', 478]]);
    expect(preview[0]).toMatchObject({ wouldTry: true, usdPerHour: 0.45, inetUpMbps: 800, directPorts: 12, reliability: 0.99 });
    expect(calls.every(c => c.method === 'POST' && c.url.endsWith('/bundles/'))).toBe(true);
  });

  it('minCuda raises the CUDA floor to the image\'s and skips a host whose driver is older (error 804 on 2026-10-06)', async () => {
    const { calls, fetchImpl } = fakeVast(({ method, url }) => {
      if (method === 'POST' && url.endsWith('/bundles/')) {
        // The API filter is not trusted: the French host on driver 570 (CUDA 12.8) comes back anyway.
        return { body: { offers: [{ ...offers[1], cuda_max_good: 12.8 }, { ...offers[2], cuda_max_good: 12.9 }] } };
      }
      if (method === 'PUT' && url.endsWith('/asks/3/')) return { body: { success: true, new_contract: 778 } };
      return { status: 500, body: 'unexpected' };
    });
    const backend = new VastDeploymentBackend('vast-key', { fetch: fetchImpl, now: () => 1_000 });
    const machine = await backend.createReplica({ spec: vastSpec({ minCuda: 12.9 }), replicaToken: TOKEN, cloudInit: '', namespace: 'prod' });
    expect(calls[0].body).toMatchObject({ cuda_max_good: { gte: 12.9 } });
    expect(machine).toMatchObject({ id: '778', zone: 'Frankfurt, DE' });
    // Below the GPU's own floor it changes nothing: Blackwell still needs 12.8.
    const low = fakeVast(() => ({ body: { offers: [] } }));
    await new VastDeploymentBackend('vast-key', { fetch: low.fetchImpl, now: () => 1_000 })
      .createReplica({ spec: vastSpec({ minCuda: 12.0 }), replicaToken: TOKEN, cloudInit: '', namespace: 'prod' }).catch(() => null);
    expect(low.calls[0].body).toMatchObject({ cuda_max_good: { gte: 12.8 } });
  });

  it('falls to 0.95 reliability only when nothing passes 0.97, and says out_of_stock when nothing fits at all', async () => {
    const seen: number[] = [];
    const { fetchImpl } = fakeVast(({ method, body }) => {
      if (method === 'POST') { seen.push((body!.reliability2 as { gte: number }).gte); return { body: { offers: [] } }; }
      return { status: 500, body: '' };
    });
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl });
    await expect(backend.createReplica({ spec: vastSpec(), replicaToken: TOKEN, cloudInit: '', namespace: 'prod' }))
      .rejects.toThrow(/out_of_stock/);
    expect(seen).toEqual([0.97, 0.95]);
  });

  it('an offer rented in between goes to the next one; a credential error stops at once', async () => {
    const { calls, fetchImpl } = fakeVast(({ method, url }) => {
      if (method === 'POST') return { body: { offers } };
      if (url.endsWith('/asks/2/')) return { status: 400, body: '{"error":"no_such_ask","msg":"not available"}' };
      if (url.endsWith('/asks/3/')) return { body: { success: true, new_contract: 9 } };
      return { status: 500, body: '' };
    });
    const logged: Array<Record<string, unknown> | undefined> = [];
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, log: (_msg, data) => logged.push(data) });
    const m = await backend.createReplica({ spec: vastSpec(), replicaToken: TOKEN, cloudInit: '', namespace: 'prod' });
    expect(m.id).toBe('9');
    expect(logged[0]).toMatchObject({ offer: 3, host: 103, location: 'Frankfurt, DE', rank: 2, of: 2 });
    expect(String((logged[0]!.skipped as string[])[0])).toMatch(/^offer 2: /);
    expect(calls.filter(c => c.method === 'PUT').map(c => c.url.split('/asks/')[1])).toEqual(['2/', '3/']);

    const denied = new VastDeploymentBackend('bad', { fetch: fakeVast(({ method }) => (method === 'POST'
      ? { body: { offers } } : { status: 401, body: 'unauthorized' })).fetchImpl });
    await expect(denied.createReplica({ spec: vastSpec(), replicaToken: TOKEN, cloudInit: '', namespace: 'prod' })).rejects.toThrow(/HTTP 401/);
  });

  it('lists only the namespace instances, ip = public_ipaddr:<host port of 80/tcp>, states mapped', async () => {
    const { fetchImpl } = fakeVast(() => ({
      body: {
        instances: [
          { id: 1, label: 'aigw:prod:speech', actual_status: 'running', public_ipaddr: '1.2.3.4 ', ports: { '80/tcp': [{ HostPort: '40123' }] },
            machine_id: 5, dph_total: 0.42, start_date: 1700000000.5, gpu_name: 'RTX 5090', geolocation: 'Paris, FR' },
          { id: 2, label: 'aigw:prod:tts', actual_status: 'loading', public_ipaddr: '1.2.3.5', ports: null },
          { id: 3, label: 'aigw:prod-2:speech', actual_status: 'running' },
          { id: 4, label: 'someone-else', actual_status: 'running' },
          { id: 5, label: 'aigw:prod:old', actual_status: 'exited' },
        ],
      },
    }));
    const list = await new VastDeploymentBackend('k', { fetch: fetchImpl }).listReplicas('prod');
    expect(list.map(m => [m.id, m.deployment, m.ip, m.state])).toEqual([
      ['1', 'speech', '1.2.3.4:40123', 'running'], ['2', 'tts', null, 'starting'], ['5', 'old', null, 'exited'],
    ]);
    expect(list[0].createdAt).toBe(1700000000500);
    expect(vastState('created')).toBe('starting');
  });

  it('a failed list throws (never reads as "nothing is running")', async () => {
    const { fetchImpl } = fakeVast(() => ({ status: 502, body: 'bad gateway' }));
    await expect(new VastDeploymentBackend('k', { fetch: fetchImpl }).listReplicas('prod')).rejects.toThrow(/HTTP 502/);
  });

  describe('instance list under rate limits', () => {
    const instances = [{ id: 1, label: 'aigw:prod:speech', actual_status: 'running', dph_total: 0.42 }];

    it('reuses a fresh list briefly (a kick storm is not a request storm)', async () => {
      let now = 1_000;
      const { calls, fetchImpl } = fakeVast(() => ({ body: { instances } }));
      const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, now: () => now });
      await backend.listReplicas('prod');
      now += 1_000;
      await backend.listReplicas('prod');
      expect(calls).toHaveLength(1);
      now += LIST_CACHE_MS;
      await backend.listReplicas('prod');
      expect(calls).toHaveLength(2);
    });

    it('after a 429 waits `retry_after` before asking again and serves the last good list meanwhile', async () => {
      let now = 1_000;
      let limited = false;
      const { calls, fetchImpl } = fakeVast(() => (limited ? { status: 429, body: { error: 'rate limited', retry_after: 30 } } : { body: { instances } }));
      const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, now: () => now });
      await backend.listReplicas('prod');
      limited = true;
      now += LIST_CACHE_MS + 1;
      expect((await backend.listReplicas('prod')).map(m => m.id)).toEqual(['1']); // stale, but not "nothing is running"
      expect(calls).toHaveLength(2);
      now += 20_000; // inside the 30 s the API asked for: no call at all
      expect(await backend.listReplicas('prod')).toHaveLength(1);
      expect(calls).toHaveLength(2);
      now += 11_000; // past retry_after: asks again (limited again → backs off again)
      await backend.listReplicas('prod');
      expect(calls).toHaveLength(3);
    });

    it('once the last good list is too old the list fails (blind, honestly) and keeps backing off', async () => {
      let now = 1_000;
      let limited = false;
      const { calls, fetchImpl } = fakeVast(() => (limited ? { status: 429, body: 'slow down' } : { body: { instances } }));
      const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, now: () => now });
      await backend.listReplicas('prod');
      limited = true;
      now += LIST_STALE_MAX_MS + 1;
      await expect(backend.listReplicas('prod')).rejects.toThrow(/HTTP 429/);
      const before = calls.length;
      await expect(backend.listReplicas('prod')).rejects.toThrow(/backing off/);
      expect(calls).toHaveLength(before);
    });

    it('a released instance is not served again from the cache', async () => {
      let now = 1_000;
      let limited = false;
      const { fetchImpl } = fakeVast(({ method }) => (method === 'DELETE' ? { body: {} } : limited ? { status: 429, body: 'x' } : { body: { instances } }));
      const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, now: () => now });
      const [m] = await backend.listReplicas('prod');
      await backend.releaseReplica(m);
      limited = true;
      now += LIST_CACHE_MS + 1;
      expect(await backend.listReplicas('prod')).toEqual([]);
    });
  });

  it('release deletes the instance (404 = already gone) and a boot-timeout host is avoided for an hour', async () => {
    let now = 0;
    const { calls, fetchImpl } = fakeVast(({ method, url }) => {
      if (method === 'POST') return { body: { offers: offers.filter(o => o.id === 2 || o.id === 3) } };
      if (method === 'PUT') return { body: { success: true, new_contract: Number(url.match(/asks\/(\d+)/)![1]) * 100 } };
      if (method === 'DELETE' && url.endsWith('/instances/404/')) return { status: 404, body: '' };
      return { body: { success: true } };
    });
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, now: () => now });
    const input = { spec: vastSpec(), replicaToken: TOKEN, cloudInit: '', namespace: 'prod' };
    const first = await backend.createReplica(input);
    expect(first.id).toBe('200'); // Paris
    await backend.releaseReplica(first, 'boot-timeout');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://console.vast.ai/api/v0/instances/200/' });
    expect(backend.avoidedHosts()).toEqual([102]);
    expect((await backend.createReplica(input)).id).toBe('300'); // Paris host skipped → Frankfurt
    now += BAD_HOST_MS + 1;
    expect((await backend.createReplica(input)).id).toBe('200'); // forgiven after an hour
    await expect(backend.releaseReplica({ ...first, id: '404' })).resolves.toBeUndefined();
  });
});

describe('VastDeploymentBackend RTT', () => {
  it('measures the mapped port of the nginx front through the injected probe', async () => {
    const seen: string[] = [];
    const backend = new VastDeploymentBackend('k', { fetch: fakeVast(() => ({ body: {} })).fetchImpl, rtt: async (h, p) => { seen.push(`${h}:${p}`); return 22; } });
    const m = { id: '1', deployment: 'x', ip: '1.2.3.4:40123', state: 'running', createdAt: 0, zone: '', machineType: '', pricePerHour: null };
    expect(await backend.measureRtt(m)).toBe(22);
    expect(seen).toEqual(['1.2.3.4:40123']);
    expect(await backend.measureRtt({ ...m, ip: null })).toBeNull();
  });

  it('a too-far host is avoided for 24 h, not 1 h', async () => {
    let now = 0;
    const { fetchImpl } = fakeVast(({ method, url }) => {
      if (method === 'POST') return { body: { offers: offers.filter(o => o.id === 2 || o.id === 3) } };
      if (method === 'PUT') return { body: { success: true, new_contract: Number(url.match(/asks\/(\d+)/)![1]) * 100 } };
      return { body: { success: true } };
    });
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, now: () => now });
    const input = { spec: vastSpec(), replicaToken: TOKEN, cloudInit: '', namespace: 'prod' };
    const first = await backend.createReplica(input);
    await backend.releaseReplica(first, 'too-far');
    now += BAD_HOST_MS + 1;
    expect((await backend.createReplica(input)).id).toBe('300'); // still avoided after an hour
    now = TOO_FAR_HOST_MS + 1;
    expect((await backend.createReplica(input)).id).toBe('200');
  });
});

describe('vastReplicaInit', () => {
  it('no systemctl; starts nginx itself, token-gated config proxying to spec.port, boot script in background, health loop', () => {
    const script = vastReplicaInit(vastSpec(), TOKEN);
    expect(script).not.toContain('systemctl');
    expect(script).toMatch(/nginx -t && \{ nginx -s reload 2>\/dev\/null \|\| nginx; \}/);
    const nginx = Buffer.from(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/srv\/aigw\/nginx.conf/.exec(script)![1], 'base64').toString();
    expect(nginx).toContain(`if ($http_x_aigw_token != "${TOKEN}") { return 401; }`);
    expect(nginx).toContain('listen 80 default_server;');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:8010;');
    expect(script).toContain('nohup bash /srv/aigw/boot.sh');
    expect(script).toContain(`curl -sf -o /dev/null http://127.0.0.1:8010/health && echo '{"ready":true}' > /srv/aigw/ready.json`);
    expect(script).not.toContain('docker');
  });

  it('defaults the app port to 8000 when the spec sets none', () => {
    const spec = buildSpec('speech', { provider: 'vast', image: 'ubuntu:24.04', bootScript: 'true', machineType: 'RTX 4090' }, { profiles });
    expect(spec.port).toBe(8000);
    expect(vastReplicaInit(spec, TOKEN)).toContain('http://127.0.0.1:8000/health');
  });

  const written = (script: string, path: string) =>
    Buffer.from(new RegExp(`echo '([A-Za-z0-9+/=]+)' \\| base64 -d > ${path}`).exec(script)?.[1] ?? '', 'base64').toString();
  const realtimeSpec = (extra: Partial<DeploymentSpec> = {}): DeploymentSpec => ({ ...vastSpec(), realtime: {}, ...extra });

  it('without realtime: no edge, no /__aigw/rt/ route', () => {
    const script = vastReplicaInit(vastSpec(), TOKEN);
    expect(script).not.toContain('aigw_edge');
    expect(script).not.toContain('edge.env');
    expect(written(script, '/srv/aigw/nginx.conf')).not.toContain('/__aigw/rt/');
  });

  it('with realtime: the edge runs as a process of the container, behind the same nginx front as on Scaleway', () => {
    const spec = realtimeSpec({ realtime: { maxSessions: 4, env: { EDGE_LLM_MODEL: "it's" } } });
    const script = vastReplicaInit(spec, TOKEN, { gatewayUrl: 'https://gw.example/' });
    expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
    expect(script).not.toContain('docker');
    expect(script).toContain(`[ -d ${VAST_EDGE_DIR}/aigw_edge ] && break`);
    expect(script).toContain(`PY=${VAST_EDGE_DIR}/venv/bin/python; [ -x $PY ] || PY=python3; $PY -m aigw_edge`);
    expect(script).toContain(`echo "export AIGW_REPLICA_ID='\${CONTAINER_ID:-\${VAST_CONTAINERLABEL#C.}}'" >> /srv/aigw/edge.env`);
    expect(script).toMatch(/chmod 600 \/srv\/aigw\/edge\.env/);
    expect(script.indexOf('nohup bash /srv/aigw/boot.sh')).toBeLessThan(script.indexOf('-m aigw_edge'));
    expect(script.indexOf('-m aigw_edge')).toBeLessThan(script.indexOf('ready.json'));
    expect(written(script, '/srv/aigw/nginx.conf')).toBe(nginxConfig(TOKEN, 80, 8010, RT_EDGE_PORT));
    const env = written(script, '/srv/aigw/edge.env');
    expect(env).toContain("export EDGE_LLM_MODEL='it'\"'\"'s'\n");
    expect(env).toContain("export RT_MAX_SESSIONS='4'\n");
    expect(env).toContain("export EDGE_UPSTREAM='http://127.0.0.1:8010'\n");
    expect(env).toContain(`export AIGW_REPLICA_TOKEN='${TOKEN}'\n`);
    expect(env).toContain("export GATEWAY_URL='https://gw.example'\n");
    const sourced = spawnSync('bash', ['-c', 'set -a; . /dev/stdin; printf %s "$EDGE_LLM_MODEL"'], { input: env });
    expect(sourced.stdout.toString()).toBe("it's");
  });

  it('the edge env on Vast names nothing the Scaleway sidecar is not given, and only the replica token is a secret', () => {
    const spec = realtimeSpec();
    const vast = vastEdgeEnv(spec, TOKEN, { gatewayUrl: 'https://gw.example' });
    const scaleway = edgeEnv(spec, TOKEN, { gatewayUrl: 'https://gw.example' });
    expect(Object.keys(vast).filter(k => !(k in scaleway))).toEqual([]);
    expect(Object.entries(vast).filter(([, v]) => v.includes(TOKEN)).map(([k]) => k)).toEqual(['AIGW_REPLICA_TOKEN']);
    expect(JSON.stringify(vast)).not.toContain('hf');
  });

  it('a realistic realtime spec stays under the 32 KB Vast accepts as env', () => {
    const spec = realtimeSpec({
      bootScript: '#!/bin/bash\n' + 'x'.repeat(3_400),
      env: { HF_TOKEN: 'hf_' + 'a'.repeat(34), STT_BATCH: '8', LLM_PARALLEL: '16', TTS_STAGE0_MB: '9600', RT_MAX_SESSIONS: '4' },
    });
    const init = Buffer.from(vastReplicaInit(spec, TOKEN, { gatewayUrl: 'https://gw.example' })).toString('base64');
    const bytes = Object.entries({ ...spec.env, AIGW_INIT_B64: init, '-p 80:80': '1' }).reduce((n, [k, v]) => n + k.length + v.length + 2, 0);
    expect(bytes).toBeLessThan(VAST_ENV_MAX_BYTES / 2);
  });
});
