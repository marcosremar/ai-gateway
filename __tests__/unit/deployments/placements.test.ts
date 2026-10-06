/**
 * Alternative placements (`spec.placements`): a replica goes to the next zone / machine type when the provider is out
 * of stock, so a GPU shortage in one zone does not leave the deployment without a replica (2026-10-06: Scaleway L4
 * and L40S `out_of_stock` in fr-par-2 while pl-waw-2 still had L4).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { isOutOfStock, placementsOf } from '../../../src/deployments/placements';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec, SpecError } from '../../../src/deployments/spec';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { CreateReplicaInput, ReplicaMachine } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
const outOfStock = () => Object.assign(new Error('scaleway HTTP 412: {"type":"out_of_stock","message":"out of stock"}'), { status: 412 });

/** A cloud whose zone/type pairs in `empty` answer 412 out_of_stock; `prices` overrides the catalog per pair. */
class StockCloud extends FakeCloud {
  empty = new Set<string>();
  prices = new Map<string, number | null>();
  attempts: string[] = [];
  override async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    const where = `${input.spec.zone}/${input.spec.machineType}`;
    this.attempts.push(where);
    if (this.empty.has(where)) throw outOfStock();
    return super.createReplica(input);
  }
  override async hourlyPrice(zone?: string, machineType?: string): Promise<number | null> {
    const key = `${zone}/${machineType}`;
    return this.prices.has(key) ? this.prices.get(key)! : this.price;
  }
}

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

async function controllerOn(cloud: StockCloud): Promise<DeploymentController> {
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
  });
  await controller.init();
  controller.start();
  controllers.push(controller);
  clouds.push(cloud);
  return controller;
}

const SPEC = {
  image: 'me/app:1', port: 8000, minReplicas: 1, maxReplicas: 1, maxEurPerHour: 2,
  placements: [{ machineType: 'L40S-1-48G' }, { zone: 'pl-waw-2' }],
};

describe('placements: spec', () => {
  it('validates entries and keeps the spec order, primary first', () => {
    const spec = buildSpec('s', SPEC, { profiles });
    expect(placementsOf(spec).map(s => `${s.zone}/${s.machineType}`)).toEqual([
      'fr-par-2/L4-1-24G', 'fr-par-2/L40S-1-48G', 'pl-waw-2/L4-1-24G',
    ]);
  });

  it('refuses an empty entry, an unknown field, a CPU type for a GPU spec and a zone change when exposed', () => {
    expect(() => buildSpec('s', { ...SPEC, placements: [{}] }, { profiles })).toThrow(SpecError);
    expect(() => buildSpec('s', { ...SPEC, placements: [{ region: 'x' }] }, { profiles })).toThrow(/unknown field/);
    expect(() => buildSpec('s', { ...SPEC, placements: [{ machineType: 'DEV1-S' }] }, { profiles })).toThrow(/GPU type/);
    expect(() => buildSpec('s', { ...SPEC, exposure: { ports: [{ protocol: 'tcp', port: 443 }] }, placements: [{ zone: 'pl-waw-2' }] }, { profiles }))
      .toThrow(/exposed deployment stays/);
  });

  it('drops a pinned OS image outside its own zone (Scaleway image ids are per zone)', () => {
    const spec = buildSpec('s', { ...SPEC, osImageId: '11111111-2222-3333-4444-555555555555' }, { profiles });
    const [primary, sameZone, otherZone] = placementsOf(spec);
    expect(primary.osImageId).toBe(spec.osImageId);
    expect(sameZone.osImageId).toBe(spec.osImageId);
    expect(otherZone.osImageId).toBeUndefined();
  });

  it('the speech-stack profile falls back beyond the L4 in fr-par-2', () => {
    const spec = buildSpec('parle-speech', { profile: 'speech-stack' }, { profiles });
    expect(placementsOf(spec).length).toBeGreaterThan(1);
  });

  it('recognises out-of-stock answers and nothing else', () => {
    expect(isOutOfStock(outOfStock())).toBe(true);
    expect(isOutOfStock(new Error('GPU shortage in zone'))).toBe(true);
    expect(isOutOfStock(Object.assign(new Error('scaleway HTTP 403: quota'), { status: 403 }))).toBe(false);
    expect(isOutOfStock(new Error('image not found'))).toBe(false);
  });
});

describe('placements: controller', () => {
  it('creates the replica in the next placement when the primary is out of stock', async () => {
    const cloud = new StockCloud();
    cloud.empty.add('fr-par-2/L4-1-24G');
    cloud.empty.add('fr-par-2/L40S-1-48G');
    const controller = await controllerOn(cloud);
    await controller.put('s', SPEC);
    await until(() => cloud.machines.size === 1);
    expect(cloud.attempts).toEqual(['fr-par-2/L4-1-24G', 'fr-par-2/L40S-1-48G', 'pl-waw-2/L4-1-24G']);
    expect([...cloud.machines.values()][0].machine.zone).toBe('pl-waw-2');
  });

  it('skips a placement above maxEurPerHour or not sold, without calling create there', async () => {
    const cloud = new StockCloud();
    cloud.empty.add('fr-par-2/L4-1-24G');
    cloud.prices.set('fr-par-2/L40S-1-48G', 9);
    const controller = await controllerOn(cloud);
    await controller.put('s', SPEC);
    await until(() => cloud.machines.size === 1);
    expect(cloud.attempts).toEqual(['fr-par-2/L4-1-24G', 'pl-waw-2/L4-1-24G']);
  });

  it('a non-stock error stops at the primary (it would fail everywhere) and reports it', async () => {
    const cloud = new StockCloud();
    cloud.failCreate = 'scaleway HTTP 403: quota exceeded';
    const controller = await controllerOn(cloud);
    await controller.put('s', SPEC);
    await until(() => (controller.get('s')?.lastError ?? '').includes('quota'));
    expect(cloud.machines.size).toBe(0);
  });

  it('everything out of stock: one error naming every placement, then backoff', async () => {
    const cloud = new StockCloud();
    for (const w of ['fr-par-2/L4-1-24G', 'fr-par-2/L40S-1-48G', 'pl-waw-2/L4-1-24G']) cloud.empty.add(w);
    const controller = await controllerOn(cloud);
    await controller.put('s', SPEC);
    await until(() => (controller.get('s')?.lastError ?? '').includes('pl-waw-2'));
    expect(controller.get('s')?.lastError).toMatch(/L4-1-24G out of stock in fr-par-2.*L40S-1-48G out of stock in fr-par-2.*out of stock in pl-waw-2/);
    const tries = cloud.attempts.length;
    await new Promise(r => setTimeout(r, 120));
    expect(cloud.attempts.length).toBe(tries);
  });
});
