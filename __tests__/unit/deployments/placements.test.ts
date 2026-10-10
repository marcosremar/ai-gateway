/**
 * Alternative placements (`spec.placements`): a replica goes to the next zone / machine type when the provider is out
 * of stock, so a GPU shortage in one zone does not leave the deployment without a replica (2026-10-06: Scaleway L4
 * and L40S `out_of_stock` in fr-par-2 while pl-waw-2 still had L4).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { isOutOfStock, placementsOf, quotaMachineType } from '../../../src/deployments/placements';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec, SpecError } from '../../../src/deployments/spec';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { CreateReplicaInput, ReplicaMachine } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
const QUOTA_BODY = '{"type":"quotas_exceeded","message":"Quota exceeded for this resource.","resource":"cp_servers_type_L40S_1_48G","quota":2,"current":2}';
const overQuota = () => Object.assign(new Error(`scaleway HTTP 403: ${QUOTA_BODY}`), { status: 403, body: QUOTA_BODY });
const outOfStock = () => Object.assign(new Error('scaleway HTTP 412: {"type":"out_of_stock","message":"out of stock"}'), { status: 412 });

/** A cloud whose zone/type pairs in `empty` answer 412 out_of_stock; `prices` overrides the catalog per pair. */
class StockCloud extends FakeCloud {
  empty = new Set<string>();
  quotaTypes = new Set<string>();
  prices = new Map<string, number | null>();
  attempts: string[] = [];
  override async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    const where = `${input.spec.zone}/${input.spec.machineType}`;
    this.attempts.push(where);
    if (this.empty.has(where)) throw outOfStock();
    if (this.quotaTypes.has(input.spec.machineType)) throw overQuota();
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

  it('the speech-stack profile: L40S fr-par-2 then pl-waw-2, then an H100 in both, never an L4 nor fr-par-1', () => {
    const spec = buildSpec('parle-speech', { profile: 'speech-stack' }, { profiles });
    expect(placementsOf(spec).filter(p => p.provider === 'scaleway').map(p => `${p.zone}/${p.machineType} ≤ €${p.maxEurPerHour}`)).toEqual([
      'fr-par-2/L40S-1-48G ≤ €2', 'pl-waw-2/L40S-1-48G ≤ €2', 'fr-par-2/H100-1-80G ≤ €3', 'pl-waw-2/H100-1-80G ≤ €3',
    ]);
  });

  it('a Scaleway placement may carry its own price cap; maxReplicas stays for another provider', () => {
    const base = { image: 'img:1', port: 8000, healthPath: '/health', machineType: 'L40S-1-48G', zone: 'fr-par-2', maxEurPerHour: 1.6 };
    const spec = buildSpec('s', { ...base, placements: [{ machineType: 'H100-1-80G', maxEurPerHour: 3 }] }, { profiles });
    expect(placementsOf(spec).map(p => p.maxEurPerHour)).toEqual([1.6, 3]);
    expect(() => buildSpec('s', { ...base, placements: [{ zone: 'pl-waw-2', maxReplicas: 1 }] }, { profiles }))
      .toThrow(/maxReplicas belongs to a placement on another provider/);
  });

  it('recognises out-of-stock answers and nothing else', () => {
    expect(isOutOfStock(outOfStock())).toBe(true);
    expect(isOutOfStock(new Error('GPU shortage in zone'))).toBe(true);
    expect(isOutOfStock(Object.assign(new Error('scaleway HTTP 403: quota'), { status: 403 }))).toBe(false);
    expect(isOutOfStock(new Error('image not found'))).toBe(false);
  });

  it('reads the machine type of a quota refusal from the provider body, else the type being created', () => {
    expect(quotaMachineType(overQuota(), 'L4-1-24G')).toBe('L40S-1-48G');
    expect(quotaMachineType(new Error('scaleway HTTP 403: quota exceeded'), 'L4-1-24G')).toBe('L4-1-24G');
    expect(quotaMachineType(outOfStock(), 'L4-1-24G')).toBeNull();
    expect(quotaMachineType(new Error('image not found'), 'L4-1-24G')).toBeNull();
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

  it('a quota refusal skips the other zones of that machine type and tries the next type in the same walk', async () => {
    const cloud = new StockCloud();
    cloud.quotaTypes.add('L40S-1-48G');
    const controller = await controllerOn(cloud);
    await controller.put('s', { ...SPEC, machineType: 'L40S-1-48G', placements: [{ zone: 'fr-par-1' }, { machineType: 'L4-1-24G' }] });
    await until(() => cloud.machines.size === 1);
    expect(cloud.attempts).toEqual(['fr-par-2/L40S-1-48G', 'fr-par-2/L4-1-24G']);
    expect(controller.get('s')?.lastPlacement).toMatch(/L4-1-24G@fr-par-2.*skipped: quota reached for L40S-1-48G on scaleway/);
  });

  it('a quota refusal with no other machine type listed backs off and says which type is over quota', async () => {
    const cloud = new StockCloud();
    cloud.quotaTypes.add('L40S-1-48G');
    const controller = await controllerOn(cloud);
    await controller.put('s', { ...SPEC, machineType: 'L40S-1-48G', placements: [{ zone: 'fr-par-1' }] });
    await until(() => (controller.get('s')?.autoscale.blockedBy ?? '').includes('quota'));
    expect(controller.get('s')?.lastError).toContain('quota reached for L40S-1-48G on scaleway');
    expect(controller.get('s')?.autoscale.blockedBy).toMatch(/create back-off \(create: quota reached for L40S-1-48G on scaleway/);
    expect(cloud.attempts).toEqual(['fr-par-2/L40S-1-48G']);
    await new Promise(r => setTimeout(r, 120));
    expect(cloud.attempts.length).toBe(1);
  });

  it('a quota refusal on every listed type is tried once per type, then reported (not a create per zone)', async () => {
    const cloud = new StockCloud();
    cloud.failCreate = 'scaleway HTTP 403: quota exceeded';
    const controller = await controllerOn(cloud);
    await controller.put('s', SPEC);
    await until(() => (controller.get('s')?.lastError ?? '').includes('quota'));
    expect(cloud.machines.size).toBe(0);
    expect(cloud.attempts).toEqual(['fr-par-2/L4-1-24G', 'fr-par-2/L40S-1-48G']);
  });

  it('an error that is neither stock nor quota stops at the primary (it would fail everywhere) and reports it', async () => {
    const cloud = new StockCloud();
    cloud.failCreate = 'scaleway HTTP 401: denied';
    const controller = await controllerOn(cloud);
    await controller.put('s', SPEC);
    await until(() => (controller.get('s')?.lastError ?? '').includes('401'));
    expect(cloud.attempts).toEqual(['fr-par-2/L4-1-24G']);
    expect(cloud.machines.size).toBe(0);
  });

  it('a PUT that changes the spec clears the create back-off; an identical PUT does not', async () => {
    const cloud = new StockCloud();
    cloud.quotaTypes.add('L40S-1-48G');
    const controller = await controllerOn(cloud);
    const stuck = { ...SPEC, machineType: 'L40S-1-48G', placements: [] };
    await controller.put('s', stuck);
    await until(() => (controller.get('s')?.lastError ?? '').includes('quota'));
    await controller.put('s', stuck);
    await new Promise(r => setTimeout(r, 120));
    expect(cloud.attempts).toEqual(['fr-par-2/L40S-1-48G']);
    await controller.put('s', { machineType: 'L4-1-24G' });
    await until(() => cloud.machines.size === 1);
    expect(cloud.attempts).toEqual(['fr-par-2/L40S-1-48G', 'fr-par-2/L4-1-24G']);
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
