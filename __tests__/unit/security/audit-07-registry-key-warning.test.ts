import { describe, expect, it } from 'vitest';
import { privateImageWarning } from '../../../src/deployments';
import { ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { buildSpec } from '../../../src/deployments/spec';

const MASTER = 'scw-master-0000-1111-2222-333344445555';
const spec = (name: string, image: string) => buildSpec(name, { image, port: 8000, machineType: 'DEV1-S', gpu: false }, { profiles: new Map() });
const speech = spec('parle-speech', 'rg.fr-par.scw.cloud/aigw/speech-stack:1');
const publicImage = spec('kokoro', 'ghcr.io/x/kokoro:1');

describe('SCW_REGISTRY_SECRET_KEY missing: loud at boot and in /health?details=1', () => {
  it('names the variable and every Scaleway deployment on a private registry image', () => {
    const warning = privateImageWarning([speech, publicImage], new ScalewayDeploymentBackend(MASTER, { client: {} as never }));
    expect(warning).toMatch(/^SCW_REGISTRY_SECRET_KEY is missing/);
    expect(warning).toContain('parle-speech cannot create a Scaleway replica');
    expect(warning).not.toContain('kokoro');
    expect(warning).not.toContain(MASTER);
  });

  it('the API secret reused as the registry key counts as missing', () => {
    expect(privateImageWarning([speech], new ScalewayDeploymentBackend(MASTER, { registrySecret: MASTER, client: {} as never }))).toContain('parle-speech');
  });

  it('silent with a distinct read-only key, with only public images, or without Scaleway', () => {
    expect(privateImageWarning([speech], new ScalewayDeploymentBackend(MASTER, { registrySecret: 'read-only-key', client: {} as never }))).toBeNull();
    expect(privateImageWarning([publicImage], new ScalewayDeploymentBackend(MASTER, { client: {} as never }))).toBeNull();
    expect(privateImageWarning([speech], undefined)).toBeNull();
  });
});
