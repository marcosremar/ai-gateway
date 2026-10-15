import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { DECLARED_DEPLOYMENTS, DeclaredDeploymentReconciler } from '../../../src/deployments/declared';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { MAX_GPU_PER_APP } from '../../../src/deployments/spec';
import { FakeCloud, until } from './_fake-cloud';

const OUTSIDE_CLASS = Date.parse('2026-10-14T10:00:00Z');
const speech = DECLARED_DEPLOYMENTS.find(d => d.name === 'parle-speech')!;
const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

async function setup() {
  const vast = Object.assign(new FakeCloud(() => OUTSIDE_CLASS, 'vast'), { marketPriced: true, price: 0.28 });
  let most = 0;
  const create = vast.createReplica.bind(vast);
  vast.createReplica = async (input) => {
    most = Math.max(most, vast.machines.size + 1);
    return create(input);
  };
  const c = new DeploymentController({
    backends: { vast }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
    now: () => OUTSIDE_CLASS, maxGpuPerApp: MAX_GPU_PER_APP,
  });
  await c.init();
  controllers.push(c);
  clouds.push(vast);
  const reconciler = new DeclaredDeploymentReconciler({ target: c, env: {}, declarations: [speech] });
  await reconciler.reconcile();
  c.start();
  c.wake('parle-speech');
  await until(() => c.get('parle-speech')!.status === 'ready');
  return { c, vast, reconciler, most: () => most };
}

describe('GPU type of a deployment, chosen in the panel (owner, 14/10/2026)', () => {
  it('lists every type with a size profile and its own price cap; the RTX 3090 is the default', async () => {
    const { c, vast } = await setup();
    expect(vast.created[0]!.spec).toMatchObject({ machineType: 'RTX 3090', maxEurPerHour: 0.22 });
    expect(c.get('parle-speech')!.gpuType).toEqual({
      current: 'RTX 3090', default: 'RTX 3090', setBy: null, setAt: null,
      choices: [['RTX 3090', 0.22], ['RTX 4090', 0.85], ['RTX 5090', 0.85], ['L40S', 0.85], ['H100 SXM', 2.5], ['H100 PCIE', 2.5]]
        .map(([machineType, maxEurPerHour]) => ({ machineType, maxEurPerHour })),
    });
  });

  it('survives the declared reconcile and applies at the next boot, at its own cap and sizes; the running GPU stays', async () => {
    const { c, vast, reconciler, most } = await setup();
    const first = [...vast.machines.values()][0]!.machine;
    await c.setGpuType('parle-speech', 'H100 SXM', false, 'marcos');
    await reconciler.reconcile();
    await new Promise(r => setTimeout(r, 200));
    expect(vast.released).toEqual([]);
    expect(c.get('parle-speech')!.gpuType).toMatchObject({ current: 'H100 SXM', setBy: 'marcos', setAt: new Date(OUTSIDE_CLASS).toISOString() });
    expect(c.specOf('parle-speech')).toMatchObject({ machineType: 'RTX 3090', candidates: [{ provider: 'vast', machineType: 'RTX 3090', maxEurPerHour: 0.22 }] });
    await vast.releaseReplica(first, 'host gone');
    c.wake('parle-speech');
    await until(() => vast.created.length === 2);
    const next = vast.created[1]!.spec;
    expect(next).toMatchObject({ machineType: 'H100 SXM', maxEurPerHour: 2.5, candidates: [{ provider: 'vast', machineType: 'H100 SXM', maxEurPerHour: 2.5 }] });
    expect(next.envByMachineType!['H100 SXM']).toMatchObject({ STT_BATCH: '16', LLM_PARALLEL: '32', RT_MAX_SESSIONS: '8' });
    expect(most()).toBe(1);
  });

  it('«trocar agora» releases the running GPU first, then rents the new type: never two for the app', async () => {
    const { c, vast, most } = await setup();
    await c.setGpuType('parle-speech', 'RTX 5090', true, 'marcos');
    await until(() => vast.created.length === 2);
    expect(vast.releaseReasons).toEqual(['gpu-type']);
    expect(vast.created[1]!.spec).toMatchObject({ machineType: 'RTX 5090', maxEurPerHour: 0.85 });
    expect(most()).toBe(1);
  });

  it('the admin offer preview searches the chosen type at its own cap, or at a cap asked for the preview only', async () => {
    const { c, vast } = await setup();
    const seen: Array<{ machineType: string; maxEurPerHour: number }> = [];
    vast.previewOffers = async (spec) => { seen.push({ machineType: spec.machineType, maxEurPerHour: spec.maxEurPerHour }); return []; };
    await c.offers('parle-speech', 'H100 SXM');
    await c.offers('parle-speech', 'H100 SXM', 4);
    await c.offers('parle-speech');
    expect(seen).toEqual([
      { machineType: 'H100 SXM', maxEurPerHour: 2.5 }, { machineType: 'H100 SXM', maxEurPerHour: 4 }, { machineType: 'RTX 3090', maxEurPerHour: 0.22 },
    ]);
    expect(c.specOf('parle-speech')!.maxEurPerHour).toBe(0.22);
  });

  it('«voltar ao padrão» clears the choice; a type the deployment does not size is refused', async () => {
    const { c } = await setup();
    await c.setGpuType('parle-speech', 'H100 PCIE', false, 'marcos');
    await c.setGpuType('parle-speech', null, false, 'marcos');
    expect(c.get('parle-speech')!.gpuType).toMatchObject({ current: 'RTX 3090', setBy: null, setAt: null });
    await expect(c.setGpuType('parle-speech', 'A100', false, 'marcos')).rejects.toThrow(/A100 is not a GPU type of 'parle-speech'/);
  });
});
