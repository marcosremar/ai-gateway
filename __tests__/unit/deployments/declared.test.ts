/**
 * Declared deployments: registered by the gateway itself (idempotent PUT through the controller), pending with the
 * reason while the registry credential / image is missing, generated SPEECH_TOKEN persisted in the store, and never a
 * machine created by the reconcile. `parle-speech` needs no credential and only patches what it declares over the
 * stored spec; the credential and generated-secret cases run on a private-registry declaration.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DeploymentController } from '../../../src/deployments/controller';
import {
  DECLARED_DEPLOYMENTS, DeclaredDeploymentReconciler, declaredBody, declaredImage, type DeclaredDeployment,
} from '../../../src/deployments/declared';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { FileDeploymentStore, MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentStore } from '../../../src/deployments/types';
import { placementsOf } from '../../../src/deployments/placements';
import { vastUnfit } from '../../../src/deployments/placement-walk';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { vastRefusal } from '../../../src/deployments/spec';
import { FakeCloud, until } from './_fake-cloud';
import parkedShadow from '../../../src/deployments/parked/parle-bridge-shadow.json';
import parkedShadowTest from '../../../src/deployments/parked/parle-bridge-shadow-test.json';

const GHCR = 'ghp_fake_read_token_0123456789';
const speech = DECLARED_DEPLOYMENTS.find(d => d.name === 'parle-speech')!;
const profile = BUILTIN_PROFILES.find(p => p.name === 'speech-stack')!.spec;

const privateApp: DeclaredDeployment = {
  name: 'parle-speech',
  image: { env: 'SPEECH_IMAGE', repository: 'ghcr.io/marcosremar/parle-speech', default: 'ghcr.io/marcosremar/parle-speech:9a87056a' },
  registryAuth: { server: 'ghcr.io', username: 'marcosremar', passwordEnv: 'GHCR_READ_TOKEN' },
  generatedSecrets: ['SPEECH_TOKEN'],
  spec: {
    port: 80, healthPath: '/health', machineType: 'L40S-1-48G', zone: 'fr-par-2', gpu: true, volumeGb: 100, minReplicas: 0,
    maxReplicas: 2, bootTimeoutMinutes: 45, maxEurPerHour: 1.5, env: { TRUST_UPSTREAM_AUTH: '1' },
  },
};
const declarations = [privateApp];

const PRODUCTION = {
  image: 'rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107', port: 8000, healthPath: '/health', machineType: 'L40S-1-48G',
  zone: 'fr-par-2', minReplicas: 0, maxReplicas: 2, minActiveReplicas: 1, targetInflightPerReplica: 8, idleMinutes: 1,
  bootTimeoutMinutes: 45, scaleDownDelaySeconds: 0, coldStartWaitSeconds: 840, maxEurPerHour: 1.6, maxHours: 12, volumeGb: 120,
  gpu: true,
  env: { STT_BATCH: '6', LLM_PARALLEL: '12', TTS_STAGE0_MB: '9000', TTS_PARALLEL: '3' },
  envByMachineType: {
    'L4-1-24G': { STT_BATCH: '3', LLM_PARALLEL: '6', TTS_STAGE0_MB: '7000' },
    'L40S-1-48G': { STT_BATCH: '7', LLM_PARALLEL: '14', TTS_STAGE0_MB: '11000' },
  },
  files: { 'voices.json': Buffer.from('{"rafa":"rafa.flac"}').toString('base64'), 'rafa.flac': Buffer.from('fLaC').toString('base64') },
};

const OUTSIDE_CLASS = Date.parse('2026-10-11T12:00:00Z');
const CLASS_WINDOW = { days: [1, 2, 3, 4], start: '16:40', end: '20:30', timeZone: 'Europe/Paris' };
const DECLARED_EXTRA = {
  entrypoint: 'bash', args: ['/opt/s2s/start.sh'], coldStartWaitSeconds: 240, minCuda: 13, maxRttExcessMs: 20, maxReplicas: 1, env: {},
  warmSchedule: [{ ...CLASS_WINDOW, minReplicas: 1 }],
};
/** The class ladder on Vast, EU hosts only: one RTX 3090, nothing pricier behind it (owner, 14/10/2026). */
const CANDIDATES = [{ provider: 'vast', machineType: 'RTX 3090', maxEurPerHour: 0.3 }];
const SIZED = ['RTX 3090', 'RTX 4090', 'L40S', 'RTX 5090', 'H100 SXM', 'H100 PCIE'];
const CAPS = { 'RTX 3090': 0.3, 'RTX 4090': 0.85, 'RTX 5090': 0.85, L40S: 0.85, 'H100 SXM': 2.5, 'H100 PCIE': 2.5 };
const DECLARED_ENV = speech.spec.envByMachineType as Record<string, Record<string, string>>;
const GHCR_IMAGE = 'ghcr.io/marcosremar/speech-stack:20261011-0200';
const ON_VAST = { provider: 'vast', machineType: 'RTX 3090', maxEurPerHour: 0.3, euOnly: true, placements: [], idleAction: 'delete' };

const controllers: DeploymentController[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function controller(store: DeploymentStore = new MemoryDeploymentStore(), cloud = new FakeCloud()) {
  const c = new DeploymentController({
    backend: cloud, store, probe: new HttpReplicaProbe(500), namespace: 'test', reconcileMs: 50, now: () => OUTSIDE_CLASS,
  });
  await c.init();
  controllers.push(c);
  return { c, cloud };
}

describe('declared parle-speech spec', () => {
  it('is the public ghcr copy on one Vast RTX 3090 on an EU host, no Scaleway place (owner, 14/10/2026)', () => {
    expect(speech.image).toEqual({ default: GHCR_IMAGE });
    expect(speech.profile).toBe('speech-stack');
    expect(speech.registryAuth).toBeUndefined();
    expect(speech.generatedSecrets).toBeUndefined();
    expect(speech.spec).toEqual({
      ...DECLARED_EXTRA, ...ON_VAST, reserveQuota: null, candidates: CANDIDATES,
      realtime: {}, scaling: { ...profile.scaling, budget: { eurPerMonth: 450 } },
      envByMachineType: DECLARED_ENV, maxEurPerHourByMachineType: CAPS,
    });
    expect(Object.keys(DECLARED_ENV)).toEqual(SIZED);
    expect(DECLARED_ENV['RTX 5090']).toEqual(profile.envByMachineType!['RTX 5090']);
    expect(DECLARED_ENV.L40S).toMatchObject({ STT_BATCH: '8', LLM_PARALLEL: '16', TTS_STAGE0_MB: '12000', RT_MAX_SESSIONS: '4', LLM_SLOT_CTX: '4096' });
    for (const h100 of ['H100 SXM', 'H100 PCIE']) {
      expect(DECLARED_ENV[h100]).toMatchObject({ STT_BATCH: '16', LLM_PARALLEL: '32', LLM_SLOT_CTX: '4096', TTS_STAGE0_MB: '20000', RT_MAX_SESSIONS: '8' });
    }
    expect(DECLARED_ENV['RTX 4090']).toMatchObject({ STT_BATCH: '4', LLM_PARALLEL: '8', TTS_STAGE0_MB: '7400', RT_MAX_SESSIONS: '2' });
    expect(DECLARED_ENV['RTX 3090']).toEqual(DECLARED_ENV['RTX 4090']);
    expect(JSON.stringify(speech)).not.toMatch(/GHCR_READ_TOKEN|ghp_|password"\s*:/);
  });

  it('SPEECH_IMAGE takes a tag of the repository or a full reference; parle-speech has no env image any more', () => {
    expect(declaredImage(privateApp, { SPEECH_IMAGE: '20261101-0900' })).toBe('ghcr.io/marcosremar/parle-speech:20261101-0900');
    expect(declaredImage(privateApp, { SPEECH_IMAGE: 'ghcr.io/other/img:1' })).toBe('ghcr.io/other/img:1');
    expect(declaredImage(speech, { SPEECH_IMAGE: 'rg.fr-par.scw.cloud/aigw/speech-stack:1' })).toBe(GHCR_IMAGE);
    const noDefault: DeclaredDeployment = { ...speech, image: { env: 'SPEECH_IMAGE' } };
    expect(declaredBody(noDefault, {}, null)).toEqual({ pending: expect.stringMatching(/SPEECH_IMAGE is not set/) });
  });

  it('parle-speech sends an empty env: the per-card env decides (a stored explicit env won over it on every card)', () => {
    const resolved = declaredBody(speech, {}, null) as { body: Record<string, unknown> };
    expect(resolved.body.env).toEqual({});
    expect(resolved.body).not.toHaveProperty('registryAuth');
  });

  it('over the production spec: Vast RTX 3090 on an EU host, the ghcr image, no Scaleway place, the declared env; then in sync without another PUT', async () => {
    const { c, cloud } = await controller();
    await c.put('parle-speech', { ...PRODUCTION, placements: [{ zone: 'fr-par-1' }, { machineType: 'L4-1-24G' }], reserveQuota: { quota: 2, windows: [{ ...CLASS_WINDOW, minReplicas: 2 }] } });
    const before = c.specOf('parle-speech')!;
    const put = vi.spyOn(c, 'put');
    const r = new DeclaredDeploymentReconciler({ target: c, env: {} });
    expect((await r.reconcile())[0]).toMatchObject({ state: 'applied', reason: null, image: GHCR_IMAGE });
    const { reserveQuota: _dropped, ...kept } = before;
    expect(c.specOf('parle-speech')).toEqual({
      ...kept, ...DECLARED_EXTRA, ...ON_VAST, candidates: CANDIDATES,
      image: GHCR_IMAGE,
      scaling: { mode: 'fast', budget: { eurPerMonth: 450 } },
      realtime: {},
      envByMachineType: { ...PRODUCTION.envByMachineType, ...DECLARED_ENV }, maxEurPerHourByMachineType: CAPS,
    });
    expect(placementsOf(c.specOf('parle-speech')!).map(p => p.provider)).toEqual(['vast']);
    expect(c.specOf('parle-speech')!.registryAuth).toBeUndefined();
    expect((await r.reconcile())[0].state).toBe('in_sync');
    expect(put.mock.calls.filter(([name]) => name === 'parle-speech')).toHaveLength(1);
    expect(cloud.created).toHaveLength(0);
  });

  it('a scaling budget the operator set stays; the declared mode is put back', async () => {
    const { c } = await controller();
    await c.put('parle-speech', { ...PRODUCTION, scaling: { mode: 'economy', budget: { eurPerHour: 3 } } });
    const r = new DeclaredDeploymentReconciler({ target: c, env: {} });
    await r.reconcile();
    expect(c.specOf('parle-speech')!.scaling).toEqual({ mode: 'fast', budget: { eurPerHour: 3, eurPerMonth: 450 } });
    expect((await r.reconcile())[0].state).toBe('in_sync');
  });

  it('SPEECH_IMAGE does not move it; the stored files and sizing stay, the explicit env is cleared', async () => {
    const { c } = await controller();
    await c.put('parle-speech', PRODUCTION);
    const r = new DeclaredDeploymentReconciler({ target: c, env: { SPEECH_IMAGE: 'rg.fr-par.scw.cloud/aigw/speech-stack:20261101-0900' } });
    expect((await r.reconcile())[0]).toMatchObject({ state: 'applied', image: GHCR_IMAGE });
    const spec = c.specOf('parle-speech')!;
    expect(spec.image).toBe(GHCR_IMAGE);
    expect(spec).toMatchObject({ env: {}, files: PRODUCTION.files, volumeGb: 120, maxHours: 12, idleMinutes: 1 });
  });

  it('fresh gateway: created from the speech-stack profile on Vast with the ghcr image, realtime on, no machine; then in sync', async () => {
    const { c, cloud } = await controller();
    c.start();
    const r = new DeclaredDeploymentReconciler({ target: c, env: {} });
    expect((await r.reconcile())[0]).toMatchObject({ state: 'applied', reason: null });
    const spec = c.specOf('parle-speech')!;
    expect(spec).toMatchObject({
      ...ON_VAST, image: GHCR_IMAGE, port: profile.port, healthPath: '/health', minReplicas: 0, volumeGb: profile.volumeGb, realtime: {}, env: {},
      envByMachineType: profile.envByMachineType,
    });
    expect(placementsOf(spec).map(p => `${p.provider} ${p.machineType}`)).toEqual(['vast RTX 3090']);
    expect(spec.reserveQuota).toBeUndefined();
    expect(spec.registryAuth).toBeUndefined();
    expect(c.get('parle-speech')?.status).toBe('scaled-to-zero');
    const put = vi.spyOn(c, 'put');
    expect((await r.reconcile())[0].state).toBe('in_sync');
    expect(put).not.toHaveBeenCalled();
    expect(cloud.created).toHaveLength(0);
  });

  it('woken with Scaleway GPUs off: the replica is a Vast RTX 3090 under €0.30/h, with the stored files by signed link', async () => {
    const scaleway = Object.assign(new FakeCloud(), { gpuOff: null as string | null });
    const vast = Object.assign(new FakeCloud(() => OUTSIDE_CLASS, 'vast'), { marketPriced: true });
    const c = new DeploymentController({
      backends: { scaleway, vast }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(500), namespace: 'test', reconcileMs: 50,
      now: () => OUTSIDE_CLASS, publicUrl: 'https://gw.example',
    });
    await c.init();
    controllers.push(c);
    await c.put('parle-speech', PRODUCTION);
    scaleway.gpuOff = 'Scaleway desativada (dono, 14/10/2026)';
    await new DeclaredDeploymentReconciler({ target: c, env: {} }).reconcile();
    c.start();
    c.wake('parle-speech');
    const speechReplicas = () => vast.created.filter(x => x.spec.name === 'parle-speech');
    await until(() => speechReplicas().length === 1, 3000);
    expect(scaleway.created).toHaveLength(0);
    expect(speechReplicas()[0].spec).toMatchObject({ provider: 'vast', machineType: 'RTX 3090', maxEurPerHour: 0.3, euOnly: true, image: GHCR_IMAGE, entrypoint: 'bash' });
    expect(speechReplicas()[0].spec.files).toBeUndefined();
    expect(Object.keys(speechReplicas()[0].spec.fileUrls ?? {})).toEqual(Object.keys(PRODUCTION.files));
    expect(vastUnfit(speechReplicas()[0].spec)).toBeNull();
  });

  it('no RTX 3090 in the EU under the cap: no machine at all, never a 4090, a 5090 or Scaleway; the cloud fallback answers', async () => {
    const scaleway = new FakeCloud();
    const vast = Object.assign(new FakeCloud(() => OUTSIDE_CLASS, 'vast'), { marketPriced: true });
    vast.failCreateFor = (s) => (s.machineType === 'RTX 3090' ? 'out_of_stock: no vast offer for RTX 3090 under €0.30/h near FR' : null);
    const c = new DeploymentController({
      backends: { scaleway, vast }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(500), namespace: 'test', reconcileMs: 50,
      now: () => OUTSIDE_CLASS, publicUrl: 'https://gw.example',
    });
    await c.init();
    controllers.push(c);
    await c.put('parle-speech', PRODUCTION);
    await new DeclaredDeploymentReconciler({ target: c, env: {} }).reconcile();
    c.start();
    c.wake('parle-speech');
    await until(() => /out_of_stock/.test(c.get('parle-speech')!.lastError ?? ''), 3000);
    expect(vast.created).toHaveLength(0);
    expect(scaleway.created).toHaveLength(0);
    expect(c.get('parle-speech')!.lastPlacement).toMatch(/^no replica placed; skipped: vast RTX 3090: out_of_stock/);
    expect(c.get('parle-speech')!.lastPlacement).not.toMatch(/4090|5090|L40S/);
  });

  it('coldStartWaitSeconds 840 is put back to the gateway maximum of 240: no warning', async () => {
    const { c } = await controller();
    await c.put('parle-speech', PRODUCTION);
    expect(c.get('parle-speech')!.warnings.join(' ')).toMatch(/coldStartWaitSeconds 840/);
    await new DeclaredDeploymentReconciler({ target: c, env: {} }).reconcile();
    expect(c.get('parle-speech')!.warnings.join(' ')).not.toMatch(/coldStartWaitSeconds/);
  });
});

describe('declarations owned by another registrant (parle-livekit)', () => {
  const GPU = {
    image: 'vllm/vllm-omni:v0.28.0', port: 8091, healthPath: '/health', machineType: 'L4-1-24G', zone: 'fr-par-2', gpu: true,
    minReplicas: 0, maxReplicas: 2, minActiveReplicas: 2, idleMinutes: 15, bootTimeoutMinutes: 45, maxEurPerHour: 1,
    scaling: { mode: 'balanced' }, bootScript: 'echo tts',
  };

  it('every parle deployment has a monthly ceiling; parle-speech is 1 warm Mon-Thu 16:40-20:30 Paris', () => {
    const budget = (name: string) => (DECLARED_DEPLOYMENTS.find(d => d.name === name)!.spec.scaling as { budget: { eurPerMonth: number } }).budget.eurPerMonth;
    expect(['parle-speech', 'parle-livekit'].map(budget)).toEqual([450, 60]);
    expect((speech.spec.warmSchedule as unknown[])[0]).toMatchObject({ ...CLASS_WINDOW, minReplicas: 1 });
  });

  it('every declared GPU ladder is one RTX 3090, one replica at most (owner, 14/10/2026)', () => {
    for (const d of DECLARED_DEPLOYMENTS.filter(x => x.spec.machineType)) {
      const ladder = [d.spec.machineType, ...((d.spec.candidates ?? []) as Array<{ machineType: string }>).map(c => c.machineType)];
      expect(new Set(ladder), d.name).toEqual(new Set(['RTX 3090']));
      expect(d.spec.maxReplicas, d.name).toBe(1);
    }
  });

  it('no declared GPU names Scaleway, and every parle GPU rents only EU hosts (owner, 14/10/2026)', async () => {
    const own = DECLARED_DEPLOYMENTS.filter(d => d.profile);
    const { c } = await controller();
    await new DeclaredDeploymentReconciler({ target: c, env: {}, declarations: own }).reconcile();
    for (const d of own) {
      const spec = c.specOf(d.name)!;
      expect([...new Set([...placementsOf(spec), ...(spec.candidates ?? [])].map(p => p.provider ?? spec.provider))], d.name).toEqual(['vast']);
      expect(spec.euOnly ?? false, d.name).toBe(d.app === 'parle');
    }
    for (const d of DECLARED_DEPLOYMENTS.filter(x => !x.profile)) {
      expect(Object.keys(d.spec).filter(k => ['provider', 'machineType', 'zone', 'placements', 'candidates'].includes(k)), d.name).toEqual([]);
    }
  });

  it('with Scaleway GPUs off, a Scaleway GPU registration is refused with the reason; a pause still goes through', async () => {
    const off = 'Scaleway desativada (dono, 14/10/2026)';
    const { c } = await controller(new MemoryDeploymentStore(), Object.assign(new FakeCloud(), { gpuOff: off }));
    await expect(c.put('some-tts', GPU, { app: 'parle' })).rejects.toThrow(
      "Scaleway desativada (dono, 14/10/2026): 'some-tts' asks for scaleway L4-1-24G; GPUs run on vast only (provider \"vast\")",
    );
    await expect(c.put('some-tts', { ...GPU, candidates: [{ zone: 'nl-ams-1', machineType: 'L4-1-24G', maxEurPerHour: 1 }] })).rejects.toThrow(/^Scaleway desativada [^]*$/);
    await expect(c.put('parle-livekit', { ...GPU, machineType: 'POP2-HC-48C-96G', gpu: false, bootScript: 'echo lk' })).resolves.toBeTruthy();
    await expect(c.put('some-tts', { ...GPU, paused: true })).resolves.toBeTruthy();
    await expect(c.put('some-tts', { paused: false })).rejects.toThrow(off);
  });

  it('not registered yet: pending, nothing created; registered by its owner: the declared fields are put back, then in sync', async () => {
    const { c, cloud } = await controller();
    const owned: DeclaredDeployment = { name: 'owned-tts', app: 'parle', spec: { paused: true, euOnly: true, scaling: { budget: { eurPerMonth: 150 } } } };
    const r = new DeclaredDeploymentReconciler({ target: c, env: {}, declarations: [owned] });
    const first = await r.reconcile();
    expect(first.map(s => s.state)).toEqual(['pending']);
    expect(first[0].reason).toMatch(/registered by its owner/);
    expect(c.specOf('owned-tts')).toBeNull();
    await c.put('owned-tts', GPU, { app: 'parle' });
    expect((await r.reconcile())[0]).toMatchObject({ state: 'applied', image: null });
    expect(c.specOf('owned-tts')).toMatchObject({
      image: GPU.image, bootScript: 'echo tts', paused: true, euOnly: true, scaling: { mode: 'balanced', budget: { eurPerMonth: 150 } },
    });
    expect(c.get('owned-tts')!.status).toBe('paused');
    await c.put('owned-tts', { ...GPU, paused: false }, { app: 'parle' });
    expect((await r.reconcile())[0].state).toBe('applied');
    expect(c.specOf('owned-tts')).toMatchObject({ paused: true, scaling: { mode: 'balanced', budget: { eurPerMonth: 150 } } });
    expect((await r.reconcile())[0].state).toBe('in_sync');
    expect(cloud.created).toHaveLength(0);
  });
});

describe('declared babelcast-speech / babelcast-tts (report 2026-10-12, T5): only the owning app', () => {
  const BABELCAST = {
    image: 'rg.fr-par.scw.cloud/aigw/babelcast-speech:1', port: 8000, healthPath: '/health', machineType: 'L4-1-24G', zone: 'fr-par-2',
    gpu: true, minReplicas: 0, maxReplicas: 1, scaling: { mode: 'fast' },
  };
  const babelcast = DECLARED_DEPLOYMENTS.filter(d => d.app === 'babelcast' && !d.profile);

  it('registered with no app: the app becomes babelcast, the spec is untouched, no machine; then in sync', async () => {
    const { c, cloud } = await controller();
    expect(babelcast.map(d => [d.name, d.spec])).toEqual([['babelcast-speech', {}], ['babelcast-tts', {}]]);
    for (const d of babelcast) await c.put(d.name, BABELCAST);
    const before = babelcast.map(d => c.specOf(d.name));
    const log = vi.fn();
    const r = new DeclaredDeploymentReconciler({ target: c, env: {}, declarations: babelcast, log });
    expect((await r.reconcile()).map(s => s.state)).toEqual(['applied', 'applied']);
    expect(babelcast.map(d => c.get(d.name)!.app)).toEqual(['babelcast', 'babelcast']);
    expect(babelcast.map(d => c.specOf(d.name))).toEqual(before);
    expect(log).toHaveBeenCalledWith('declared deployment registered', { name: 'babelcast-speech', image: null, created: false, app: 'babelcast' });
    expect((await r.reconcile()).map(s => s.state)).toEqual(['in_sync', 'in_sync']);
    expect(cloud.created).toHaveLength(0);
  });

  it('never takes a deployment that belongs to another app, never creates one', async () => {
    const { c, cloud } = await controller();
    await c.put('babelcast-speech', BABELCAST, { app: 'other' });
    const r = new DeclaredDeploymentReconciler({ target: c, env: {}, declarations: babelcast });
    expect((await r.reconcile()).map(s => s.state)).toEqual(['applied', 'pending']);
    expect(c.get('babelcast-speech')!.app).toBe('other');
    expect(c.specOf('babelcast-tts')).toBeNull();
    expect(cloud.created).toHaveLength(0);
  });
});

describe('DeclaredDeploymentReconciler', () => {
  it('without the registry credential: pending with the reason, nothing registered, no machine', async () => {
    const { c, cloud } = await controller();
    const put = vi.spyOn(c, 'put');
    const r = new DeclaredDeploymentReconciler({ target: c, env: {}, declarations });
    const [status] = await r.reconcile();
    expect(status).toMatchObject({ name: 'parle-speech', state: 'pending' });
    expect(status.reason).toMatch(/GHCR_READ_TOKEN is not set/);
    expect(put).not.toHaveBeenCalled();
    expect(c.get('parle-speech')).toBeNull();
    expect(cloud.created).toHaveLength(0);
  });

  it('with the credential: registers once (scaled to zero, no machine), then stays in sync without another PUT', async () => {
    const { c, cloud } = await controller();
    c.start();
    const put = vi.spyOn(c, 'put');
    const onChange = vi.fn();
    const r = new DeclaredDeploymentReconciler({ target: c, env: { GHCR_READ_TOKEN: GHCR }, onChange, declarations });
    expect((await r.reconcile())[0].state).toBe('applied');
    expect(onChange).toHaveBeenCalledWith(['parle-speech']);
    const spec = c.specOf('parle-speech')!;
    expect(spec.registryAuth).toEqual({ server: 'ghcr.io', username: 'marcosremar', password: GHCR });
    expect(spec.env.TRUST_UPSTREAM_AUTH).toBe('1');
    expect(spec.env.SPEECH_TOKEN).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(spec.image).toBe(privateApp.image?.default);
    expect(c.get('parle-speech')?.status).toBe('scaled-to-zero');

    const token = spec.env.SPEECH_TOKEN;
    expect((await r.reconcile())[0].state).toBe('in_sync');
    expect((await r.reconcile())[0].state).toBe('in_sync');
    expect(put).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(c.specOf('parle-speech')!.env.SPEECH_TOKEN).toBe(token);
    await new Promise(res => setTimeout(res, 150)); // a few controller reconciles
    expect(cloud.created).toHaveLength(0);
  });

  it('a new image or a rotated credential updates the spec; the token stays', async () => {
    const { c } = await controller();
    const env: Record<string, string> = { GHCR_READ_TOKEN: GHCR };
    const r = new DeclaredDeploymentReconciler({ target: c, env, declarations });
    await r.reconcile();
    const token = c.specOf('parle-speech')!.env.SPEECH_TOKEN;
    env.SPEECH_IMAGE = 'deadbeef';
    env.GHCR_READ_TOKEN = 'ghp_rotated_token_987654321';
    expect((await r.reconcile())[0]).toMatchObject({ state: 'applied', image: 'ghcr.io/marcosremar/parle-speech:deadbeef' });
    const spec = c.specOf('parle-speech')!;
    expect(spec.image).toBe('ghcr.io/marcosremar/parle-speech:deadbeef');
    expect(spec.registryAuth?.password).toBe('ghp_rotated_token_987654321');
    expect(spec.env.SPEECH_TOKEN).toBe(token);
  });

  it('a credential that disappears keeps the registered spec and reports pending', async () => {
    const { c } = await controller();
    const env: Record<string, string | undefined> = { GHCR_READ_TOKEN: GHCR };
    const r = new DeclaredDeploymentReconciler({ target: c, env, declarations });
    await r.reconcile();
    delete env.GHCR_READ_TOKEN;
    const [status] = await r.reconcile();
    expect(status.state).toBe('pending');
    expect(status.reason).toMatch(/keeping the registered spec/);
    expect(c.specOf('parle-speech')!.registryAuth?.password).toBe(GHCR);
  });

  it('the generated SPEECH_TOKEN survives a gateway restart (persisted in the deployment store)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'declared-'));
    dirs.push(dir);
    const first = await controller(FileDeploymentStore.inDir(dir));
    await new DeclaredDeploymentReconciler({ target: first.c, env: { GHCR_READ_TOKEN: GHCR }, declarations }).reconcile();
    const token = first.c.specOf('parle-speech')!.env.SPEECH_TOKEN;

    const second = await controller(FileDeploymentStore.inDir(dir));
    const put = vi.spyOn(second.c, 'put');
    expect((await new DeclaredDeploymentReconciler({ target: second.c, env: { GHCR_READ_TOKEN: GHCR }, declarations }).reconcile())[0].state).toBe('in_sync');
    expect(put).not.toHaveBeenCalled();
    expect(second.c.specOf('parle-speech')!.env.SPEECH_TOKEN).toBe(token);
  });

  it('deployments off on this gateway: disabled, with the reason', async () => {
    const r = new DeclaredDeploymentReconciler({ target: null, env: { GHCR_READ_TOKEN: GHCR }, declarations });
    const [status] = await r.reconcile();
    expect(status).toMatchObject({ state: 'disabled' });
    expect(status.reason).toMatch(/SCW_SECRET_KEY/);
  });

  it('GET /v1/deployments lists the declared status and never the token or the registry password', async () => {
    const { c } = await controller();
    const r = new DeclaredDeploymentReconciler({ target: c, env: { GHCR_READ_TOKEN: GHCR }, declarations });
    await r.reconcile();
    const token = c.specOf('parle-speech')!.env.SPEECH_TOKEN;
    const handler = createDeploymentRoutes({ controller: c, declaredStatus: () => r.status() });
    const body = await new Promise<string>((resolve) => {
      const res = {
        headersSent: false, writeHead: () => res, end: (data: string) => resolve(data), on: () => res,
      } as never;
      handler({ headers: {}, url: '/v1/deployments' } as never, res, '/v1/deployments', 'GET');
    });
    const parsed = JSON.parse(body);
    expect(parsed.declared[0]).toMatchObject({ name: 'parle-speech', state: 'applied' });
    expect(parsed.deployments[0].spec).toMatchObject({ envKeys: ['TRUST_UPSTREAM_AUTH', 'SPEECH_TOKEN'], privateRegistry: true });
    expect(body).not.toContain(token);
    expect(body).not.toContain(GHCR);
  });
});

describe('declared parle-speech-test: the test copy of parle-speech on the same Vast GPU (owner, 14/10/2026)', () => {
  it('registers on one Vast RTX 3090 on an EU host, the same image, no warm schedule, deleted after 10 min idle, owned by parle; nothing created', async () => {
    const { c, cloud } = await controller();
    await c.put('parle-speech', PRODUCTION);
    const status = await new DeclaredDeploymentReconciler({ target: c, env: {} }).reconcile();
    expect(status.find(s => s.name === 'parle-speech-test')).toMatchObject({ state: 'applied' });
    const spec = c.specOf('parle-speech-test')!;
    expect(spec).toMatchObject({
      ...ON_VAST, testFor: 'parle-speech', maxReplicas: 1, minReplicas: 0, idleMinutes: 10, idleAction: 'delete', minCuda: 13, candidates: CANDIDATES,
    });
    expect(spec.envByMachineType).toMatchObject(DECLARED_ENV);
    expect(spec.image).toBe(c.specOf('parle-speech')!.image);
    expect(placementsOf(spec).map(p => `${p.provider} ${p.machineType}`)).toEqual(['vast RTX 3090']);
    expect(spec.warmSchedule).toBeUndefined();
    expect(c.get('parle-speech-test')!.app).toBe('parle');
    expect(c.get('parle-speech')!.app).toBe('parle');
    expect(cloud.created).toHaveLength(0);
    const put = vi.spyOn(c, 'put');
    const again = await new DeclaredDeploymentReconciler({ target: c, env: {} }).reconcile();
    expect(again.filter(s => s.name === 'parle-speech' || s.name === 'parle-speech-test').map(s => s.state)).toEqual(['in_sync', 'in_sync']);
    expect(put.mock.calls.filter(([name]) => name === 'parle-speech-test')).toHaveLength(0);
  });
});

describe('parle-speech-test follows the voices of parle-speech', () => {
  it('a catalog re-registered on parle-speech reaches the test copy at the next reconcile (it was copied once only)', async () => {
    const { c } = await controller();
    await c.put('parle-speech', PRODUCTION);
    const r = new DeclaredDeploymentReconciler({ target: c, env: {} });
    await r.reconcile();
    expect(c.specOf('parle-speech-test')!.files).toEqual(PRODUCTION.files);
    const files = { ...PRODUCTION.files, 'voices.json': Buffer.from('{"lia":"Entre as crianças e as flores."}').toString('base64') };
    await c.put('parle-speech', { files });
    await r.reconcile();
    expect(c.specOf('parle-speech-test')!.files).toEqual(files);
  });
});

describe('parle-bridge-shadow parked (owner, 12/10/2026): no custom-model GPU until the owner turns it back on', () => {
  const HF = 'hf_fake_read_token_0123456789';
  const IN_CLASS = Date.parse('2026-10-12T17:00:00Z');
  const isShadow = (name: string) => name.startsWith('parle-bridge-shadow');

  it('is not declared, and its parked specs hold no warm window', () => {
    expect(DECLARED_DEPLOYMENTS.filter(d => isShadow(d.name))).toEqual([]);
    for (const parked of [parkedShadow, parkedShadowTest]) {
      expect(parked.spec).not.toHaveProperty('warmSchedule');
      expect(parked.spec.minReplicas).toBe(0);
    }
  });

  it('inside the class window, even with the HF token set, nothing of the shadow is registered, warmed or started', async () => {
    const cloud = new FakeCloud();
    const c = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(500), namespace: 'test', reconcileMs: 50,
      now: () => IN_CLASS,
    });
    await c.init();
    controllers.push(c);
    const status = await new DeclaredDeploymentReconciler({ target: c, env: { HF_BRIDGE_READ_TOKEN: HF } }).reconcile();
    await new Promise(r => setTimeout(r, 300));
    expect(status.filter(s => isShadow(s.name))).toEqual([]);
    expect(c.specOf('parle-bridge-shadow')).toBeNull();
    expect(c.specOf('parle-bridge-shadow-test')).toBeNull();
    expect(cloud.created.filter(x => isShadow(x.spec.name))).toEqual([]);
  });
});
