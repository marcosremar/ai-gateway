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
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { FakeCloud, until } from './_fake-cloud';

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

const controllers: DeploymentController[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function controller(store: DeploymentStore = new MemoryDeploymentStore(), cloud = new FakeCloud()) {
  const c = new DeploymentController({ backend: cloud, store, probe: new HttpReplicaProbe(500), namespace: 'test', reconcileMs: 50 });
  await c.init();
  controllers.push(c);
  return { c, cloud };
}

describe('declared parle-speech spec', () => {
  it('is the speech-stack image in the gateway registry: no credential, no generated secret, no env or sizing of its own', () => {
    expect(speech.image).toEqual({
      env: 'SPEECH_IMAGE', repository: 'rg.fr-par.scw.cloud/aigw/speech-stack', default: PRODUCTION.image,
    });
    expect(speech.profile).toBe('speech-stack');
    expect(speech.registryAuth).toBeUndefined();
    expect(speech.generatedSecrets).toBeUndefined();
    expect(speech.spec).toEqual({
      realtime: {}, envByMachineType: { 'L4-1-24G': { RT_MAX_SESSIONS: '8' }, 'L40S-1-48G': { RT_MAX_SESSIONS: '16' } },
    });
    expect(JSON.stringify(speech)).not.toMatch(/GHCR_READ_TOKEN|ghp_|password"\s*:/);
  });

  it('SPEECH_IMAGE takes a tag of the repository or a full reference', () => {
    expect(declaredImage(speech, { SPEECH_IMAGE: '20261101-0900' })).toBe('rg.fr-par.scw.cloud/aigw/speech-stack:20261101-0900');
    expect(declaredImage(speech, { SPEECH_IMAGE: 'ghcr.io/other/img:1' })).toBe('ghcr.io/other/img:1');
    expect(declaredImage(speech, {})).toBe(speech.image?.default);
    const noDefault: DeclaredDeployment = { ...speech, image: { env: 'SPEECH_IMAGE' } };
    expect(declaredBody(noDefault, {}, null)).toEqual({ pending: expect.stringMatching(/SPEECH_IMAGE is not set/) });
  });

  it('a declaration without env or generated secrets sends no env', () => {
    const resolved = declaredBody(speech, {}, null) as { body: Record<string, unknown> };
    expect(resolved.body).not.toHaveProperty('env');
    expect(resolved.body).not.toHaveProperty('registryAuth');
  });

  it('over the production spec: only realtime and RT_MAX_SESSIONS are added, then in sync without another PUT', async () => {
    const { c, cloud } = await controller();
    await c.put('parle-speech', PRODUCTION);
    const before = c.specOf('parle-speech')!;
    const put = vi.spyOn(c, 'put');
    const r = new DeclaredDeploymentReconciler({ target: c, env: {} });
    expect((await r.reconcile())[0]).toMatchObject({ state: 'applied', reason: null, image: PRODUCTION.image });
    expect(c.specOf('parle-speech')).toEqual({
      ...before,
      realtime: {},
      envByMachineType: {
        'L4-1-24G': { ...PRODUCTION.envByMachineType['L4-1-24G'], RT_MAX_SESSIONS: '8' },
        'L40S-1-48G': { ...PRODUCTION.envByMachineType['L40S-1-48G'], RT_MAX_SESSIONS: '16' },
      },
    });
    expect(c.specOf('parle-speech')!.registryAuth).toBeUndefined();
    expect((await r.reconcile())[0].state).toBe('in_sync');
    expect(put).toHaveBeenCalledTimes(1);
    expect(cloud.created).toHaveLength(0);
  });

  it('SPEECH_IMAGE moves the image of the production spec and nothing else', async () => {
    const { c } = await controller();
    await c.put('parle-speech', PRODUCTION);
    const r = new DeclaredDeploymentReconciler({ target: c, env: { SPEECH_IMAGE: '20261101-0900' } });
    expect((await r.reconcile())[0]).toMatchObject({ state: 'applied', image: 'rg.fr-par.scw.cloud/aigw/speech-stack:20261101-0900' });
    const spec = c.specOf('parle-speech')!;
    expect(spec.image).toBe('rg.fr-par.scw.cloud/aigw/speech-stack:20261101-0900');
    expect(spec).toMatchObject({ env: PRODUCTION.env, files: PRODUCTION.files, volumeGb: 120, maxHours: 12, idleMinutes: 1 });
  });

  it('fresh gateway: created from the speech-stack profile with the declared image, realtime on, no machine; then in sync', async () => {
    const { c, cloud } = await controller();
    c.start();
    const r = new DeclaredDeploymentReconciler({ target: c, env: {} });
    expect((await r.reconcile())[0]).toMatchObject({ state: 'applied', reason: null });
    const spec = c.specOf('parle-speech')!;
    expect(spec).toMatchObject({
      image: PRODUCTION.image, port: profile.port, healthPath: '/health', machineType: 'L40S-1-48G', zone: 'fr-par-2',
      minReplicas: 0, volumeGb: profile.volumeGb, maxEurPerHour: profile.maxEurPerHour, realtime: {}, env: {},
      envByMachineType: profile.envByMachineType,
    });
    expect(placementsOf(spec).map(p => `${p.zone}/${p.machineType}`).slice(0, 3)).toEqual([
      'fr-par-2/L40S-1-48G', 'fr-par-1/L40S-1-48G', 'fr-par-2/L4-1-24G',
    ]);
    expect(spec.registryAuth).toBeUndefined();
    expect(c.get('parle-speech')?.status).toBe('scaled-to-zero');
    const put = vi.spyOn(c, 'put');
    expect((await r.reconcile())[0].state).toBe('in_sync');
    expect(put).not.toHaveBeenCalled();
    expect(cloud.created).toHaveLength(0);
  });

  // D3, live QA 2026-10-07: one placement only, `L40S-1-48G out of stock in fr-par-2` for 17 min, no 2nd replica.
  it('out of stock in fr-par-2: the replica lands on the next placement', async () => {
    const cloud = new FakeCloud();
    cloud.failCreateFor = (s) => (s.machineType === 'L40S-1-48G' ? `scaleway HTTP 412: {"type":"out_of_stock"} ${s.zone}` : null);
    const { c } = await controller(new MemoryDeploymentStore(), cloud);
    await new DeclaredDeploymentReconciler({ target: c, env: {} }).reconcile();
    c.start();
    c.wake('parle-speech');
    await until(() => cloud.created.length === 1, 3000);
    expect(cloud.created[0].spec).toMatchObject({ zone: 'fr-par-2', machineType: 'L4-1-24G' });
    expect(c.get('parle-speech')!.lastPlacement).toMatch(/L40S-1-48G out of stock in fr-par-2; L40S-1-48G out of stock in fr-par-1/);
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
