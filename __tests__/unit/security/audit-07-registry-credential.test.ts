import { describe, expect, it, vi } from 'vitest';
import { replicaCloudInit } from '../../../src/deployments/cloud-init';
import { ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { buildSpec } from '../../../src/deployments/spec';

const MASTER = 'scw-master-0000-1111-2222-333344445555';
const READONLY = 'scw-registry-read-only-aaaa-bbbb-cccc';
const IMAGE = 'rg.fr-par.scw.cloud/aigw/speech-stack:1';

function client() {
  return {
    createInstance: vi.fn(async (spec: Record<string, unknown>) => ({
      instanceId: `${spec.region}:srv-1`, status: 'starting',
      providerMeta: { zone: spec.region, commercialType: spec.commercialType, tags: spec.tags as string[] },
    })),
    listSecurityGroups: vi.fn(async () => []),
    createSecurityGroup: vi.fn(async () => 'sg'),
    defaultProjectId: vi.fn(async () => 'proj'),
  };
}

const spec = () => buildSpec('speech', { image: IMAGE, port: 8000, machineType: 'DEV1-S', gpu: false }, { profiles: new Map() });

describe('audit 2026-10-09 #7: the Scaleway API secret never goes to a replica', () => {
  it('the registry login uses SCW_REGISTRY_SECRET_KEY (read-only), never the API secret', () => {
    const backend = new ScalewayDeploymentBackend(MASTER, { registrySecret: READONLY, client: client() as never });
    expect(backend.registryAuthFor(IMAGE)).toEqual({ server: 'rg.fr-par.scw.cloud', username: 'nologin', password: READONLY });
    const init = replicaCloudInit({ ...spec(), registryAuth: backend.registryAuthFor(IMAGE)! }, 'x'.repeat(32));
    expect(init).not.toContain(MASTER);
    expect(init).toMatch(/set \+x\n[^\n]*docker login[^\n]*\nset -x/);
    expect(init).toMatch(/docker pull[^\n]*\n[^\n]*docker logout 'rg\.fr-par\.scw\.cloud'/);
  });

  it('without a distinct registry credential there is no login at all (the master key is never a fallback)', () => {
    expect(new ScalewayDeploymentBackend(MASTER, { client: client() as never }).registryAuthFor(IMAGE)).toBeNull();
    expect(new ScalewayDeploymentBackend(MASTER, { registrySecret: MASTER, client: client() as never }).registryAuthFor(IMAGE)).toBeNull();
  });

  it('a private registry image with no registry credential is refused with a clear error, before any machine exists', async () => {
    const c = client();
    const backend = new ScalewayDeploymentBackend(MASTER, { client: c as never, projectId: 'proj' });
    await expect(backend.createReplica({ spec: spec(), replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'n' }))
      .rejects.toThrow(/SCW_REGISTRY_SECRET_KEY/);
    expect(c.createInstance).not.toHaveBeenCalled();
  });

  it('a user_data that carries the API secret (from any field) is refused before it leaves the gateway', async () => {
    const c = client();
    const backend = new ScalewayDeploymentBackend(MASTER, { registrySecret: READONLY, client: c as never, projectId: 'proj' });
    const leaky = { ...spec(), image: 'ghcr.io/x/y:1', env: { SOME_KEY: MASTER } };
    await expect(backend.createReplica({ spec: leaky, replicaToken: 't'.repeat(32), cloudInit: replicaCloudInit(leaky, 'x'.repeat(32)), namespace: 'n' }))
      .rejects.toThrow(/Scaleway API secret/);
    await expect(backend.createReplica({
      spec: { ...spec(), image: 'ghcr.io/x/y:1' }, replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'n', files: { a: new TextEncoder().encode(MASTER) },
    })).rejects.toThrow(/Scaleway API secret/);
    expect(c.createInstance).not.toHaveBeenCalled();
  });
});
