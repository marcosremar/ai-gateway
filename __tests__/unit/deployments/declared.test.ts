/**
 * Declared deployments: registered by the gateway itself (idempotent PUT through the controller), pending with the
 * reason while the registry credential / image is missing, generated SPEECH_TOKEN persisted in the store, and never a
 * machine created by the reconcile.
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
import { buildSpec } from '../../../src/deployments/spec';
import { FakeCloud, until } from './_fake-cloud';

const GHCR = 'ghp_fake_read_token_0123456789';
const speech = DECLARED_DEPLOYMENTS.find(d => d.name === 'parle-speech')!;

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
  it('is the one-GPU speech image: port 80, /health, L40S, minReplicas 0, 45 min boot, ≥ 100 GB, upstream auth trusted', () => {
    expect(speech.spec).toMatchObject({
      port: 80, healthPath: '/health', machineType: 'L40S-1-48G', zone: 'fr-par-2', minReplicas: 0, bootTimeoutMinutes: 45,
      env: { TRUST_UPSTREAM_AUTH: '1' },
    });
    expect(speech.spec.volumeGb as number).toBeGreaterThanOrEqual(100);
    expect(speech.registryAuth).toEqual({ server: 'ghcr.io', username: 'marcosremar', passwordEnv: 'GHCR_READ_TOKEN' });
    expect(speech.generatedSecrets).toEqual(['SPEECH_TOKEN']);
    expect(JSON.stringify(speech)).not.toMatch(/ghp_|password"\s*:/);
    expect(speech.image?.default).toMatch(/^ghcr\.io\/marcosremar\/parle-speech:[0-9a-f]{40}$/);
  });

  // D3, live QA 2026-10-07: one placement only, `L40S-1-48G out of stock in fr-par-2` for 17 min, no 2nd replica.
  it('has a stock fallback: L40S fr-par-1, then L4 fr-par-2, then L4 pl-waw-2, every one under its € cap', () => {
    const spec = buildSpec('parle-speech', { ...speech.spec, image: 'x/y:1' }, { profiles: new Map() });
    expect(placementsOf(spec).map(p => `${p.zone}/${p.machineType}`)).toEqual([
      'fr-par-2/L40S-1-48G', 'fr-par-1/L40S-1-48G', 'fr-par-2/L4-1-24G', 'pl-waw-2/L4-1-24G',
    ]);
    expect(spec.maxEurPerHour).toBeGreaterThanOrEqual(1.47); // the L40S's price: below it the primary is never created
    expect(spec.maxEurPerHour).toBeLessThan(2);
    for (const p of placementsOf(spec)) expect(spec.envByMachineType?.[p.machineType]?.LLM_PARALLEL).toMatch(/^\d+$/);
  });

  it('out of stock in fr-par-2: the replica lands on the next placement', async () => {
    const cloud = new FakeCloud();
    cloud.failCreateFor = (s) => (s.machineType === 'L40S-1-48G' ? `scaleway HTTP 412: {"type":"out_of_stock"} ${s.zone}` : null);
    const { c } = await controller(new MemoryDeploymentStore(), cloud);
    await new DeclaredDeploymentReconciler({ target: c, env: { GHCR_READ_TOKEN: GHCR } }).reconcile();
    c.start();
    c.wake('parle-speech');
    await until(() => cloud.created.length === 1, 3000);
    expect(cloud.created[0].spec).toMatchObject({ zone: 'fr-par-2', machineType: 'L4-1-24G' });
    expect(c.get('parle-speech')!.lastPlacement).toMatch(/L40S-1-48G out of stock in fr-par-2; L40S-1-48G out of stock in fr-par-1/);
  });

  it('SPEECH_IMAGE takes a tag of the repository or a full reference', () => {
    expect(declaredImage(speech, { SPEECH_IMAGE: 'abc123' })).toBe('ghcr.io/marcosremar/parle-speech:abc123');
    expect(declaredImage(speech, { SPEECH_IMAGE: 'ghcr.io/other/img:1' })).toBe('ghcr.io/other/img:1');
    expect(declaredImage(speech, {})).toBe(speech.image?.default);
    const noDefault: DeclaredDeployment = { ...speech, image: { env: 'SPEECH_IMAGE' } };
    expect(declaredBody(noDefault, { GHCR_READ_TOKEN: GHCR }, null)).toEqual({ pending: expect.stringMatching(/SPEECH_IMAGE is not set/) });
  });
});

describe('DeclaredDeploymentReconciler', () => {
  it('without the registry credential: pending with the reason, nothing registered, no machine', async () => {
    const { c, cloud } = await controller();
    const put = vi.spyOn(c, 'put');
    const r = new DeclaredDeploymentReconciler({ target: c, env: {} });
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
    const r = new DeclaredDeploymentReconciler({ target: c, env: { GHCR_READ_TOKEN: GHCR }, onChange });
    expect((await r.reconcile())[0].state).toBe('applied');
    expect(onChange).toHaveBeenCalledWith(['parle-speech']);
    const spec = c.specOf('parle-speech')!;
    expect(spec.registryAuth).toEqual({ server: 'ghcr.io', username: 'marcosremar', password: GHCR });
    expect(spec.env.TRUST_UPSTREAM_AUTH).toBe('1');
    expect(spec.env.SPEECH_TOKEN).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(spec.image).toBe(speech.image?.default);
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
    const r = new DeclaredDeploymentReconciler({ target: c, env });
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
    const r = new DeclaredDeploymentReconciler({ target: c, env });
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
    await new DeclaredDeploymentReconciler({ target: first.c, env: { GHCR_READ_TOKEN: GHCR } }).reconcile();
    const token = first.c.specOf('parle-speech')!.env.SPEECH_TOKEN;

    const second = await controller(FileDeploymentStore.inDir(dir));
    const put = vi.spyOn(second.c, 'put');
    expect((await new DeclaredDeploymentReconciler({ target: second.c, env: { GHCR_READ_TOKEN: GHCR } }).reconcile())[0].state).toBe('in_sync');
    expect(put).not.toHaveBeenCalled();
    expect(second.c.specOf('parle-speech')!.env.SPEECH_TOKEN).toBe(token);
  });

  it('deployments off on this gateway: disabled, with the reason', async () => {
    const r = new DeclaredDeploymentReconciler({ target: null, env: { GHCR_READ_TOKEN: GHCR } });
    const [status] = await r.reconcile();
    expect(status).toMatchObject({ state: 'disabled' });
    expect(status.reason).toMatch(/SCW_SECRET_KEY/);
  });

  it('GET /v1/deployments lists the declared status and never the token or the registry password', async () => {
    const { c } = await controller();
    const r = new DeclaredDeploymentReconciler({ target: c, env: { GHCR_READ_TOKEN: GHCR } });
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
