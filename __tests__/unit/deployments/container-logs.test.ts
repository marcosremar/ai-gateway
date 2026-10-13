import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import {
  CONTAINER_LOG_BYTES, CONTAINER_LOG_LINES, CONTAINER_LOG_TTL_MS, ContainerLogCache, capLog,
} from '../../../src/deployments/container-logs';
import { VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import type { ReplicaMachine } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const MIN = 60_000;
const T0 = Date.parse('2026-10-13T10:00:00Z');
const GATEWAY_SECRET = 'vast-api-key-0123456789abcdef';
const HF_SECRET = 'hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const machine = (id = '31544017', deployment = 'g') => ({ id, deployment, provider: 'vast' }) as ReplicaMachine;
const VAST_SPEC = { provider: 'vast', image: 'vllm/vllm-openai:v0.6.0', bootScript: 'python3 -m http.server 8010', port: 8010, machineType: 'RTX 3090', maxEurPerHour: 0.2 } as const;

interface Seen { url: string; method: string; auth: string | null; body: string | null }

function fakeVast(answers: Array<{ status: number; body: string }>, resultUrl: unknown = 'https://s3.vast.example/logs/31544017.txt') {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization'), body: init?.body ? String(init.body) : null });
    if (url.includes('/instances/request_logs/')) return new Response(JSON.stringify({ success: true, result_url: resultUrl, msg: 'requested' }));
    const next = answers.shift() ?? { status: 404, body: '' };
    return new Response(next.body, { status: next.status });
  };
  return { seen, backend: new VastDeploymentBackend(GATEWAY_SECRET, { fetch: fetchImpl, now: () => T0 }) };
}

describe('Vast container logs through the deployments Vast client', () => {
  it('asks request_logs for the tail with the key, then reads result_url without it once uploaded', async () => {
    const { seen, backend } = fakeVast([{ status: 404, body: '' }, { status: 200, body: 'line one\nline two\n' }]);
    expect(await backend.containerLogs(machine(), 200)).toBe('line one\nline two\n');
    expect(seen[0]).toMatchObject({ method: 'PUT', url: 'https://console.vast.ai/api/v0/instances/request_logs/31544017/', auth: `Bearer ${GATEWAY_SECRET}` });
    expect(JSON.parse(seen[0]!.body!)).toEqual({ tail: '200' });
    expect(seen.slice(1).map(s => [s.method, s.url, s.auth])).toEqual([
      ['GET', 'https://s3.vast.example/logs/31544017.txt', null], ['GET', 'https://s3.vast.example/logs/31544017.txt', null],
    ]);
  });

  it('fails without a usable result_url', async () => {
    await expect(fakeVast([], null).backend.containerLogs(machine(), 200)).rejects.toThrow(/no result_url/);
    await expect(fakeVast([], 'http://plain.example/x').backend.containerLogs(machine(), 200)).rejects.toThrow(/no result_url/);
  });
});

describe('capLog', () => {
  it('redacts secrets, bearer tokens and provider keys before anything is kept', () => {
    const lines = capLog(`env HF_TOKEN=${HF_SECRET}\nAuthorization: Bearer abc.def.ghi\nkey sk-or-v1-0123456789abcdef0123\nplain\n`, [HF_SECRET]);
    expect(lines).toEqual(['env HF_TOKEN=[segredo]', 'Authorization: Bearer [segredo]', 'key [segredo]', 'plain']);
  });

  it('drops colour codes, keeps the last state of a carriage-return progress line and skips blank lines', () => {
    expect(capLog('\u001b[32mINFO\u001b[0m ready\n\n 10%\r 50%\r100% done\n', [])).toEqual(['INFO ready', '100% done']);
  });

  it('keeps only the last lines and at most the byte cap', () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const lines = capLog(many, []);
    expect(lines).toHaveLength(CONTAINER_LOG_LINES);
    expect(lines.at(-1)).toBe('line 499');
    const wide = Array.from({ length: 150 }, (_, i) => `${i} ${'x'.repeat(1000)}`).join('\n');
    const kept = capLog(wide, []);
    expect(Buffer.byteLength(kept.join('\n'))).toBeLessThanOrEqual(CONTAINER_LOG_BYTES);
    expect(kept.at(-1)!.startsWith('149 ')).toBe(true);
  });
});

describe('ContainerLogCache', () => {
  it('reads Vast once per replica within the TTL, again after it, and shares a read in flight', async () => {
    const clock = { now: T0 };
    const cache = new ContainerLogCache(() => clock.now);
    let calls = 0;
    const fetchText = async () => { calls++; return `boot ${calls} ${HF_SECRET}`; };
    const [a, b] = await Promise.all([cache.read(machine(), fetchText, [HF_SECRET]), cache.read(machine(), fetchText, [HF_SECRET])]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.lines).toEqual(['boot 1 [segredo]']);
    clock.now += CONTAINER_LOG_TTL_MS - 1;
    expect((await cache.read(machine(), fetchText, [HF_SECRET])).lines).toEqual(['boot 1 [segredo]']);
    expect(calls).toBe(1);
    clock.now += 1;
    expect((await cache.read(machine(), fetchText, [HF_SECRET])).lines).toEqual(['boot 2 [segredo]']);
    expect(calls).toBe(2);
  });

  it('keeps a failed read for the TTL too, with its message redacted', async () => {
    const clock = { now: T0 };
    const cache = new ContainerLogCache(() => clock.now);
    let calls = 0;
    const failing = async (): Promise<string> => { calls++; throw new Error(`vast PUT: HTTP 429 key ${GATEWAY_SECRET}`); };
    const log = await cache.read(machine(), failing, [GATEWAY_SECRET]);
    expect(log).toMatchObject({ lines: [], error: 'vast PUT: HTTP 429 key [segredo]', replicaId: '31544017' });
    await cache.read(machine(), failing, [GATEWAY_SECRET]);
    expect(calls).toBe(1);
    expect(cache.latest('g')).toBe(log);
    expect(cache.latest('other')).toBeNull();
  });
});

describe('container logs in the deployments controller', () => {
  const controllers: DeploymentController[] = [];
  const clouds: FakeCloud[] = [];
  afterEach(async () => {
    for (const c of controllers.splice(0)) await c.stop();
    for (const c of clouds.splice(0)) await c.closeAll();
  });

  async function make(provider: 'scaleway' | 'vast' = 'scaleway') {
    const clock = { now: T0 };
    const cloud = new FakeCloud(() => clock.now, provider);
    cloud.bootMs = 10 * MIN;
    const events: string[] = [];
    const reads: string[] = [];
    Object.assign(cloud, {
      containerLogs: async (m: ReplicaMachine, tail: number) => {
        events.push(`logs:${m.id}`);
        reads.push(m.id);
        const token = c.tokenOf(m.deployment, m.id);
        return `tail ${tail}\nHF_TOKEN=${HF_SECRET}\nVAST=${GATEWAY_SECRET}\nnginx token ${token}\n`;
      },
    });
    const release = cloud.releaseReplica.bind(cloud);
    cloud.releaseReplica = async (m, reason) => { events.push(`release:${reason}`); return release(m, reason); };
    const c: DeploymentController = new DeploymentController({
      backends: { [provider]: cloud }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
      now: () => clock.now, secrets: () => [GATEWAY_SECRET],
    });
    await c.init();
    controllers.push(c);
    clouds.push(cloud);
    return { c, cloud, clock, events, reads };
  }

  it('reads the log of a stuck boot before releasing it, and keeps showing it once that replica is gone', async () => {
    const { c, cloud, clock, events } = await make('vast');
    await c.put('v', { ...VAST_SPEC, minReplicas: 1 });
    c.start();
    await until(() => c.get('v')!.boot.active.some(b => b.replicaId && b.phase === 'starting'));
    const stuck = c.get('v')!.boot.active.find(b => b.replicaId)!.replicaId!;
    cloud.failCreate = 'out_of_stock: no vast offer';
    clock.now += 16 * MIN;
    await until(() => events.includes('release:boot-stuck'));
    expect(events.indexOf(`logs:${stuck}`)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(`logs:${stuck}`)).toBeLessThan(events.indexOf('release:boot-stuck'));
    await until(() => c.get('v')!.replicas.length === 0);
    expect(await c.containerLog('v')).toMatchObject({ reason: 'no-replica', pending: false, log: { replicaId: stuck, lines: expect.arrayContaining(['tail 200']) } });
    expect(events.filter(e => e.startsWith('logs:'))).toHaveLength(1);
  });

  it('redacts the gateway secrets, the spec env and the replica token before storing', async () => {
    const { c } = await make();
    await c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1, env: { HF_TOKEN: HF_SECRET } });
    c.start();
    await until(() => c.get('g')!.replicas.length > 0);
    const view = (await c.containerLog('g'))!;
    expect(view).toMatchObject({ reason: null, pending: false });
    expect(view.log!.lines).toEqual(['tail 200', 'HF_TOKEN=[segredo]', 'VAST=[segredo]', 'nginx token [segredo]']);
    expect(JSON.stringify(view)).not.toContain(HF_SECRET);
    expect(JSON.stringify(view)).not.toContain(GATEWAY_SECRET);
  });

  it('opens twice within the TTL with one Vast read, and reads again after it', async () => {
    const { c, clock, reads } = await make();
    await c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    c.start();
    await until(() => c.get('g')!.replicas.length > 0);
    await c.containerLog('g');
    await c.containerLog('g');
    expect(reads).toHaveLength(1);
    clock.now += CONTAINER_LOG_TTL_MS;
    await c.containerLog('g');
    expect(reads).toHaveLength(2);
  });

  it('answers pending with what it has when Vast is slower than the page wait', async () => {
    const { c, cloud } = await make();
    await c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    c.start();
    await until(() => c.get('g')!.replicas.length > 0);
    let finish: (text: string) => void = () => {};
    Object.assign(cloud, { containerLogs: () => new Promise<string>((r) => { finish = r; }) });
    expect(await c.containerLog('g', 20)).toEqual({ reason: null, pending: true, log: null });
    finish('late line');
    await until(async () => (await c.containerLog('g', 20))!.log?.lines[0] === 'late line');
  });

  it('says why there is no log: a provider without one, or no Vast replica now', async () => {
    const scw = await make();
    await scw.c.put('g', { image: 'me/app:1', port: 8000 });
    Object.assign(scw.cloud, { containerLogs: undefined });
    expect(await scw.c.containerLog('g')).toEqual({ reason: 'unsupported', pending: false, log: null });
    expect(await scw.c.containerLog('missing')).toBeNull();
    const vast = await make('vast');
    await vast.c.put('v', VAST_SPEC);
    expect(await vast.c.containerLog('v')).toEqual({ reason: 'no-replica', pending: false, log: null });
    expect(vast.reads).toEqual([]);
  });
});
