import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { FileDeploymentStore, MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentRecord } from '../../../src/deployments/types';
import { FakeCloud } from './_fake-cloud';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20 });
});

async function controllerWith(store: MemoryDeploymentStore) {
  const controller = new DeploymentController({
    backend: new FakeCloud(), store, probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 60_000, maxTotalReplicas: 2,
  });
  await controller.init();
  return controller;
}

const record = (updatedAt: number) => ({ spec: { name: 'tts' }, createdAt: 1, updatedAt, lastRequestAt: null, replicaToken: 't' }) as unknown as DeploymentRecord;

describe('controller.stop() and the state file', () => {
  it('waits for the write in progress and the pending ones before resolving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aigw-stop-'));
    dirs.push(dir);
    const store = FileDeploymentStore.inDir(dir);
    const controller = await controllerWith(store);
    for (let i = 1; i <= 20; i++) void store.saveDeployment(record(i)).catch(() => {});
    await controller.stop();
    const saved = JSON.parse(readFileSync(join(dir, 'deployments.json'), 'utf8'));
    expect(saved.deployments.tts.updatedAt).toBe(20);
  });

  it('gives up after its deadline when a write never lands', async () => {
    class StuckStore extends MemoryDeploymentStore {
      settled() { return new Promise<void>(() => {}); }
    }
    const controller = await controllerWith(new StuckStore());
    const started = Date.now();
    await controller.stop(50);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
