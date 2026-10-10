import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { bootFile } from '../../../src/deployments/boot-files';
import { vastReplicaInit } from '../../../src/deployments/cloud-init';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { placementsOf } from '../../../src/deployments/placements';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { DEFAULT_SCALING_MODE } from '../../../src/deployments/scaling-spec';
import { buildSpec } from '../../../src/deployments/spec';
import { reapIfGatewayDown } from '../../../src/deployments/reaper';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentSpec, DeploymentStore } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
const QUOTA = (type: string) => `scaleway HTTP 403: {"type":"quotas_exceeded","resource":"cp_servers_type_${type.replace(/-/g, '_')}","quota":2,"current":2}`;
const VAST = { provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.85, maxReplicas: 1 };
const SPEC = {
  image: 'vllm/vllm-omni:v0.28.0', entrypoint: 'vllm', args: ['serve', 'm'], port: 8091, machineType: 'L40S-1-48G', maxEurPerHour: 2,
  minReplicas: 1, maxReplicas: 2, placements: [{ zone: 'fr-par-1' }, { machineType: 'L4-1-24G' }, VAST],
};
const ladder = (spec: DeploymentSpec) => placementsOf(spec).map(s => (s.provider === 'vast'
  ? `vast ${s.machineType} ≤ €${s.maxEurPerHour}` : `${s.machineType}@${s.zone}`));

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

async function make(opts: {
  vast?: boolean; store?: DeploymentStore; log?: (msg: string, data?: Record<string, unknown>) => void; publicUrl?: string; now?: () => number;
  maxEurPerHour?: number;
} = {}) {
  const scaleway = new FakeCloud(opts.now);
  const vast = new FakeCloud(opts.now ?? Date.now, 'vast');
  vast.marketPriced = true;
  const quota = new Set<string>();
  const attempts: string[] = [];
  scaleway.failCreateFor = (s) => {
    attempts.push(`${s.machineType}@${s.zone}`);
    return quota.has(s.machineType) ? QUOTA(s.machineType) : null;
  };
  const controller = new DeploymentController({
    backends: opts.vast === false ? { scaleway } : { scaleway, vast }, store: opts.store ?? new MemoryDeploymentStore(),
    probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, defaultScalingMode: DEFAULT_SCALING_MODE,
    ...(opts.log ? { log: opts.log } : {}), ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}), ...(opts.now ? { now: opts.now } : {}),
    ...(opts.maxEurPerHour ? { maxEurPerHour: opts.maxEurPerHour } : {}),
  });
  await controller.init();
  controller.start();
  controllers.push(controller);
  clouds.push(scaleway, vast);
  return { controller, scaleway, vast, quota, attempts };
}

describe('placements on another provider: spec', () => {
  it('a vast placement declares its machine type, price cap and replica limit', () => {
    expect(ladder(buildSpec('s', SPEC, { profiles }))).toEqual(['L40S-1-48G@fr-par-2', 'L40S-1-48G@fr-par-1', 'L4-1-24G@fr-par-2', 'vast RTX 5090 ≤ €0.85']);
    for (const missing of ['machineType', 'maxEurPerHour', 'maxReplicas']) {
      const { [missing as keyof typeof VAST]: _dropped, ...entry } = VAST;
      expect(() => buildSpec('s', { ...SPEC, placements: [{ zone: 'fr-par-1', ...entry }] }, { profiles })).toThrow(/needs machineType, maxEurPerHour and maxReplicas/);
    }
    expect(() => buildSpec('s', { ...SPEC, placements: [{ zone: 'fr-par-1', maxReplicas: 1 }] }, { profiles })).toThrow(/another provider/);
    expect(() => buildSpec('s', { ...SPEC, machineType: 'DEV1-S', placements: [VAST] }, { profiles })).toThrow(/GPU deployments/);
  });

  it('what vast cannot take does not refuse the spec: files, a parked idle', () => {
    const spec = buildSpec('s', { ...SPEC, files: { a: 'YQ==' }, idleAction: 'stop' }, { profiles });
    expect(spec.placements).toContainEqual(VAST);
  });

  it('the voice profiles: Scaleway first, vast last, no L4 under the speech stack, mode fast', () => {
    const speech = buildSpec('parle-speech', { profile: 'speech-stack' }, { profiles });
    expect(ladder(speech)).toEqual([
      'L40S-1-48G@fr-par-2', 'L40S-1-48G@pl-waw-2', 'H100-1-80G@fr-par-2', 'H100-1-80G@pl-waw-2', 'vast RTX 5090 ≤ €0.85',
    ]);
    expect(speech.placements?.at(-1)).toMatchObject({ maxReplicas: 1 });
    for (const name of ['qwen3-tts', 'qwen3-tts-clone']) {
      const tts = buildSpec('tts', { profile: name }, { profiles });
      expect(ladder(tts)).toEqual(['L4-1-24G@fr-par-2', 'L4-1-24G@fr-par-1', 'vast RTX 5090 ≤ €0.85']);
      expect(tts).toMatchObject({ scaling: { mode: 'fast' }, minCuda: 13, maxRttExcessMs: 20 });
      expect(tts.placements?.at(-1)).toMatchObject({ maxReplicas: 2 });
    }
    expect(speech).toMatchObject({ scaling: { mode: 'fast' }, minCuda: 13, maxRttExcessMs: 20 });
    const stt = buildSpec('stt', { profile: 'whisper-stt' }, { profiles });
    expect(stt.scaling).toEqual({ mode: 'balanced' });
    expect(placementsOf(stt).every(s => s.provider === 'scaleway')).toBe(true);
  });

  it('a placement may pull its own image; the speech stack pulls the public copy on vast and passes the env start.sh needs', () => {
    const own = buildSpec('s', { ...SPEC, placements: [{ zone: 'fr-par-1' }, { ...VAST, image: 'ghcr.io/me/app:1' }] }, { profiles });
    expect(placementsOf(own).map(s => s.image)).toEqual([SPEC.image, SPEC.image, 'ghcr.io/me/app:1']);
    expect(() => buildSpec('s', { ...SPEC, placements: [{ ...VAST, image: 'not an image' }] }, { profiles })).toThrow(/placements\[0\]\.image/);
    const speech = buildSpec('parle-speech', { profile: 'speech-stack' }, { profiles });
    expect(placementsOf(speech).map(s => s.image)).toEqual([
      ...Array(4).fill('rg.fr-par.scw.cloud/aigw/speech-stack:20261009-0213'), 'ghcr.io/marcosremar/speech-stack:20261009-0213',
    ]);
    const init = vastReplicaInit(placementsOf(speech).at(-1)!, 'x'.repeat(32));
    const appEnv = Buffer.from(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/srv\/aigw\/app\.env/.exec(init)![1], 'base64').toString('utf8');
    expect(appEnv).toContain('TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-Base\n');
    expect(appEnv).toContain('LLM_FILE=Qwen3.5-9B-Q4_K_M.gguf\n');
    expect(speech.envByMachineType!['L40S-1-48G'].LLM_SLOT_CTX).toBe('4096');
    expect(speech.envByMachineType!['L4-1-24G'].LLM_SLOT_CTX).toBeUndefined();
    expect(speech.envByMachineType!['H100-1-80G'].LLM_SLOT_CTX).toBe('2048');
  });

  it('an image with a start command runs on vast without a boot script', () => {
    const spec = buildSpec('tts', { profile: 'qwen3-tts' }, { profiles });
    const init = vastReplicaInit(placementsOf(spec).at(-1)!, 'x'.repeat(32));
    const boot = /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/srv\/aigw\/boot\.sh/.exec(init)![1];
    expect(Buffer.from(boot, 'base64').toString('utf8')).toContain("exec 'vllm' 'serve' 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice' '--omni'");
    expect(init).toContain('http://127.0.0.1:8091/health');
  });
});

describe('placements on another provider: the walk', () => {
  it('a Scaleway quota refusal goes to the next Scaleway type, then to vast at the placement cap', async () => {
    const { controller, vast, quota, attempts } = await make();
    quota.add('L40S-1-48G').add('L4-1-24G');
    await controller.put('s', { ...SPEC, maxReplicas: 1 });
    await until(() => vast.created.length === 1);
    expect(attempts).toEqual(['L40S-1-48G@fr-par-2', 'L4-1-24G@fr-par-2']);
    expect(vast.created[0].spec).toMatchObject({ provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.85 });
    expect(controller.get('s')!.lastPlacement).toMatch(/^vast RTX 5090 \(≤ €0\.85\/h\); skipped: quota reached for L40S-1-48G on scaleway.*quota reached for L4-1-24G on scaleway/);
  });

  it('a vast market above the placement cap rents nothing', async () => {
    const { controller, vast, quota } = await make();
    quota.add('L40S-1-48G').add('L4-1-24G');
    vast.failCreateFor = s => (s.maxEurPerHour < 0.9 ? `out_of_stock: no vast offer for ${s.machineType} under €${s.maxEurPerHour}/h near FR` : null);
    await controller.put('s', { ...SPEC, maxReplicas: 1 });
    await until(() => /no vast offer/.test(controller.get('s')!.lastError ?? ''));
    expect(controller.get('s')!.lastError).toContain('no vast offer for RTX 5090 under €0.85/h');
    expect(vast.created).toHaveLength(0);
  });

  it('vast takes its declared number of replicas and no more; when Scaleway is back the next replica is created there and the vast one stays', async () => {
    const { controller, scaleway, vast, quota } = await make();
    quota.add('L40S-1-48G').add('L4-1-24G');
    await controller.put('s', { ...SPEC, minReplicas: 2 });
    await until(() => controller.get('s')!.replicas.filter(r => r.phase === 'ready').length === 1);
    await controller.put('s', { ...SPEC, minReplicas: 2, idleMinutes: 16 });
    await until(() => /vast RTX 5090: its 1 fallback replica is in use \(placement maxReplicas\)/.test(controller.get('s')!.lastError ?? ''));
    expect(vast.created).toHaveLength(1);
    quota.clear();
    await controller.put('s', { ...SPEC, minReplicas: 2, idleMinutes: 17 });
    await until(() => scaleway.created.length === 1);
    expect(scaleway.created[0].spec).toMatchObject({ provider: 'scaleway', machineType: 'L40S-1-48G', zone: 'fr-par-2' });
    await until(() => controller.get('s')!.replicas.filter(r => r.phase === 'ready').length === 2);
    expect(vast.released).toEqual([]);
    expect(vast.created).toHaveLength(1);
  });

  it('a spec vast cannot run skips the vast placement with the reason, in the walk and in the view', async () => {
    const { controller, scaleway, vast, quota } = await make();
    quota.add('L40S-1-48G').add('L4-1-24G');
    await controller.put('files', { ...SPEC, maxReplicas: 1, files: { a: 'YQ==' } });
    await until(() => /files are not supported on vast/.test(controller.get('files')!.lastError ?? ''));
    expect(controller.get('files')!.warnings).toEqual(['the vast RTX 5090 fallback placement is skipped: files are not supported on vast (no user_data service)']);
    scaleway.registryAuthFor = image => (image.startsWith('rg.fr-par.scw.cloud/') ? { username: 'nologin', password: 'k' } : null);
    await controller.put('private', { ...SPEC, maxReplicas: 1, image: 'rg.fr-par.scw.cloud/aigw/speech-stack:1' });
    await until(() => /is private/.test(controller.get('private')!.lastError ?? ''));
    await controller.put('pull', { ...SPEC, maxReplicas: 1, image: 'rg.fr-par.scw.cloud/aigw/speech-stack:1', registryAuth: { username: 'pull', password: 'p' } });
    await until(() => vast.created.length === 1);
    expect(vast.created[0].spec).toMatchObject({ name: 'pull', registryAuth: { username: 'pull' } });
    expect(controller.get('pull')!.warnings).toEqual([]);
    await controller.put('copy', {
      ...SPEC, maxReplicas: 1, image: 'rg.fr-par.scw.cloud/aigw/speech-stack:1', placements: [{ ...VAST, image: 'ghcr.io/me/speech-stack:1' }],
    });
    await until(() => vast.created.length === 2);
    expect(vast.created[1].spec).toMatchObject({ name: 'copy', image: 'ghcr.io/me/speech-stack:1' });
    expect(vast.created[1].spec.registryAuth).toBeUndefined();
    expect(controller.get('copy')!.warnings).toEqual([]);
  });

  it('a gateway without a vast key walks the Scaleway placements and says the fallback is off', async () => {
    const { controller, quota, attempts } = await make({ vast: false });
    quota.add('L40S-1-48G').add('L4-1-24G');
    await controller.put('s', { ...SPEC, maxReplicas: 1 });
    await until(() => /provider not configured/.test(controller.get('s')!.lastError ?? ''));
    expect(attempts.slice(0, 2)).toEqual(['L40S-1-48G@fr-par-2', 'L4-1-24G@fr-par-2']);
    expect(controller.get('s')!.warnings).toEqual(['the vast RTX 5090 fallback placement is skipped: VAST_API_KEY is not set']);
  });
});

describe('default scaling mode', () => {
  const plain = { image: 'me/app:1', port: 8000 };

  it('a deployment without a scaling block runs under balanced, shown in the view and the capacity', async () => {
    const { controller } = await make();
    expect((await controller.put('a', plain)).view.spec.scaling).toEqual({ mode: 'balanced' });
    expect(controller.capacity('a')!.mode).toBe('balanced');
    expect((await controller.put('a', { scaling: { mode: 'economy' } })).view.spec.scaling).toEqual({ mode: 'economy' });
    expect((await controller.put('a', { paused: true })).view.spec.scaling).toEqual({ mode: 'economy' });
    expect((await controller.put('a', { scaling: null })).view.spec.scaling).toEqual({ mode: 'balanced' });
  });

  it('a stored deployment without the block gets the mode at start, and the log names it', async () => {
    const store = new MemoryDeploymentStore();
    const spec = buildSpec('old', plain, { profiles });
    await store.saveDeployment({ spec, replicaToken: 'x'.repeat(32), createdAt: 0, updatedAt: 0, lastRequestAt: null });
    const logs: Array<Record<string, unknown> | undefined> = [];
    const { controller } = await make({ store, log: (msg, data) => { if (/default mode/.test(msg)) logs.push(data); } });
    expect(controller.get('old')!.spec.scaling).toEqual({ mode: 'balanced' });
    expect(logs).toEqual([{ mode: 'balanced', deployments: ['old'] }]);
  });

  it('a controller built without a default keeps a spec as sent', async () => {
    const controller = new DeploymentController({ backend: new FakeCloud(), store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000) });
    await controller.init();
    expect((await controller.put('a', plain)).view.spec.scaling).toBeUndefined();
    expect(controller.capacity('a')!.mode).toBeNull();
  });
});

describe('files on a vast placement', () => {
  it('with a public URL the gateway serves them through signed links and the placement is used; the links open the stored bytes', async () => {
    const { controller, vast, quota } = await make({ publicUrl: 'https://gw.example' });
    quota.add('L40S-1-48G').add('L4-1-24G');
    const voice = Buffer.from('reference voice');
    await controller.put('voices', { ...SPEC, maxReplicas: 1, files: { 'lia.wav': voice.toString('base64') } });
    await until(() => vast.created.length === 1);
    const { spec, files } = vast.created[0];
    expect(files).toBeUndefined();
    expect(spec.files).toBeUndefined();
    const link = spec.fileUrls!['lia.wav'];
    expect(link.sha256).toBe(createHash('sha256').update(voice).digest('hex'));
    expect(link.url).toMatch(/^https:\/\/gw\.example\/v1\/boot-files\?d=voices&k=lia\.wav&exp=\d+&sig=[\w-]{43}$/);
    expect(bootFile(controller, new URL(link.url).searchParams, Date.now())).toEqual(voice);
    expect(vastReplicaInit(spec, 'x'.repeat(32))).toContain(`/srv/aigw/files/lia.wav ${link.sha256}`);
    const view = controller.get('voices')!;
    expect(view.warnings).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('sig=');
  });
});

describe('inbound UDP of a replica', () => {
  const rtc = (requireWebrtc: boolean) => ({ ...SPEC, placements: [], provider: 'vast', machineType: 'RTX 5090', bootScript: 'serve', realtime: { maxSessions: 4, requireWebrtc } });

  it('is recorded on the replica and on its host; a blocked replica keeps serving a deployment that can use WS', async () => {
    const { controller, vast } = await make();
    const notes: unknown[] = [];
    vast.noteHost = (m, note) => { notes.push([m.id, note]); };
    await controller.put('s', rtc(false));
    await until(() => controller.get('s')!.status === 'ready');
    const { id } = controller.get('s')!.replicas[0];
    expect(controller.get('s')!.replicas[0].udp).toBeNull();
    await controller.noteUdp('s', id, 'blocked', { path: 'ws', active: 0 });
    expect(controller.get('s')!.replicas[0]).toMatchObject({ id, udp: 'blocked', phase: 'ready' });
    expect(vast.released).toEqual([]);
    expect(notes).toEqual([[id, { bootMs: expect.any(Number) }], [id, { udp: 'blocked' }]]);
    await controller.noteUdp('s', 'no-such-replica', 'ok', { active: 0 });
    await controller.noteUdp('nothing', id, 'ok', { active: 0 });
  });

  it('realtime.requireWebrtc: blocked UDP is a failed boot of that host (released as udp-blocked, replaced), unless a relay works or learners are seated', async () => {
    const { controller, vast } = await make();
    await controller.put('s', rtc(true));
    await until(() => controller.get('s')!.status === 'ready');
    const first = controller.get('s')!.replicas[0].id;
    await controller.noteUdp('s', first, 'blocked', { path: 'relay', active: 0 });
    await controller.noteUdp('s', first, 'blocked', { path: 'ws', active: 2 });
    expect(vast.released).toEqual([]);
    await controller.noteUdp('s', first, 'blocked', { path: 'ws', active: 0 });
    expect(vast.released).toEqual([first]);
    expect(vast.releaseReasons).toEqual(['udp-blocked']);
    await until(() => controller.get('s')!.status === 'ready');
    const view = controller.get('s')!;
    expect(view.replicas.map(r => r.id)).not.toContain(first);
    expect(view.lastPlacement).toMatch(/inbound UDP blocked and realtime\.requireWebrtc: released \(udp-blocked\)/);
    await controller.noteUdp('s', view.replicas[0].id, 'ok', { path: 'direct', active: 0 });
    await controller.noteUdp('s', view.replicas[0].id, 'blocked', { path: 'ws', active: 0 });
    expect(controller.get('s')!.replicas[0]).toMatchObject({ udp: 'blocked', phase: 'ready' });
    expect(vast.released).toEqual([first]);
    expect(() => buildSpec('s', { ...rtc(true), realtime: { requireWebrtc: 'yes' } }, { profiles })).toThrow(/requireWebrtc must be a boolean/);
  });
});

describe('warm schedule over a vast placement (a class at a known time)', () => {
  const at = (iso: string) => Date.parse(iso);
  const CLASS = {
    ...SPEC, minReplicas: 0, maxReplicas: 4, idleMinutes: 1,
    placements: [{ ...VAST, maxReplicas: 3 }],
    warmSchedule: [{ days: [1, 2, 3, 4], start: '17:40', end: '20:15', timeZone: 'Europe/Paris', minReplicas: 4 }],
  };

  it('before the class the floor starts the Scaleway replica the quota allows and the rest on vast, within the placement limit and the hourly ceiling; after it they go', async () => {
    const clock = { offset: at('2026-10-12T15:00:00Z') - Date.now() };
    const now = () => Date.now() + clock.offset;
    const { controller, scaleway, vast } = await make({ now, maxEurPerHour: 1.8 });
    scaleway.failCreateFor = s => (scaleway.created.length >= 1 ? QUOTA(s.machineType) : null);
    await controller.put('class', CLASS);
    await controller.reconcile();
    expect(controller.get('class')).toMatchObject({ status: 'scaled-to-zero', autoscale: { warmFloor: 0 } });
    expect(vast.created).toHaveLength(0);

    clock.offset = at('2026-10-12T15:41:00Z') - Date.now();
    await until(() => controller.get('class')!.replicas.filter(r => r.phase === 'ready').length === 3, 8000);
    expect(controller.get('class')!.autoscale.warmFloor).toBe(4);
    expect(scaleway.created).toHaveLength(1);
    expect(vast.created.map(c => c.spec.maxEurPerHour)).toEqual([0.85, 0.85]);
    await until(() => /spend ceiling reached/.test(controller.get('class')!.lastError ?? ''));
    expect(controller.health()).toMatchObject({ running: 3, maxEurPerHour: 1.8 });

    const reaped = await reapIfGatewayDown({
      namespace: 'test', now: () => now() + 3_600_000, sleep: async () => {}, gatewayUp: async () => false, dryRun: true, backends: [scaleway, vast],
    });
    expect(reaped.seen).toBe(3);

    clock.offset = at('2026-10-12T20:30:00Z') - Date.now();
    await until(() => controller.get('class')!.replicas.length === 0, 8000);
    expect(vast.released).toHaveLength(2);
    expect(scaleway.released).toHaveLength(1);
    expect(controller.get('class')!.autoscale.warmFloor).toBe(0);
  });

  it('a Friday has no window: nothing is rented', async () => {
    const offset = at('2026-10-16T16:00:00Z') - Date.now();
    const { controller, scaleway, vast } = await make({ now: () => Date.now() + offset });
    await controller.put('class', CLASS);
    await controller.reconcile();
    await controller.reconcile();
    expect(controller.get('class')!.autoscale.warmFloor).toBe(0);
    expect(scaleway.created.length + vast.created.length).toBe(0);
  });
});


describe('a class-window quota reservation (#63) and the walk to vast (#64)', () => {
  const MONDAY_CLASS = Date.parse('2026-10-05T16:00:00Z');
  const CLASS = { days: [1, 2, 3, 4], start: '17:40', end: '20:15', timeZone: 'Europe/Paris', minReplicas: 2 };

  it('inside the window the reserved Scaleway type is skipped with the reason and the replica lands on vast', async () => {
    const { controller, scaleway, vast } = await make({ now: () => MONDAY_CLASS });
    await controller.put('tts', { ...SPEC, minReplicas: 0, placements: undefined, reserveQuota: { quota: 2, windows: [CLASS] } });
    await controller.put('bench', { ...SPEC, minReplicas: 0, placements: [VAST] });
    controller.wake('bench');
    await until(() => vast.created.some(c => c.spec.name === 'bench'), 3000);
    expect(scaleway.created.filter(c => c.spec.name === 'bench')).toEqual([]);
    expect(controller.get('bench')!.lastPlacement).toMatch(/^vast RTX 5090 \(≤ €0\.85\/h\); skipped: scaleway L40S-1-48G@fr-par-2: L40S-1-48G is reserved for deployment 'tts' until 2026-10-05T18:15:00\.000Z/);
  });

  it('without a vast placement the same deployment is refused for the window (409 reserved)', async () => {
    const { controller, scaleway, vast } = await make({ now: () => MONDAY_CLASS });
    await controller.put('tts', { ...SPEC, minReplicas: 0, placements: undefined, reserveQuota: { quota: 2, windows: [CLASS] } });
    await controller.put('bench', { ...SPEC, minReplicas: 0, placements: undefined });
    expect(() => controller.wake('bench')).toThrow(/is reserved for deployment 'tts'/);
    expect(scaleway.created.length + vast.created.length).toBe(0);
  });
});
