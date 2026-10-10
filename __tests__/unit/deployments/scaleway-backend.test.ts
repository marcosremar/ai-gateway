import { describe, expect, it, vi, afterEach } from 'vitest';
import type { IncomingMessage } from 'http';
import { ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { buildSpec } from '../../../src/deployments/spec';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { RateLimiter } from '../../../src/gateway/proxy/middleware/rate-limit';

const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));

function fakeClient() {
  return {
    createInstance: vi.fn(async (spec: Record<string, unknown>) => ({
      instanceId: `${spec.region}:srv-1`, instanceName: 'x', endpoint: '', ipAddress: '51.0.0.1', status: 'starting',
      providerMeta: { provider: 'scaleway', zone: spec.region, commercialType: spec.commercialType, pricePerHr: 0.7875,
        tags: ['babelcast', 'gpu', ...(spec.tags as string[])], createdAt: '2026-10-04T10:00:00Z' },
    })),
    listInstancesByTag: vi.fn(async () => [
      { instanceId: 'fr-par-2:a', ipAddress: '51.0.0.2', status: 'running',
        providerMeta: { zone: 'fr-par-2', commercialType: 'L4-1-24G', state: 'stopped in place', tags: ['aigw-deploy', 'aigw-ns-prod', 'aigw-dep-tts'] } },
      { instanceId: 'fr-par-2:b', status: 'running', providerMeta: { zone: 'fr-par-2', tags: ['aigw-ns-prod'] } }, // no dep tag
    ]),
    releaseInstance: vi.fn(async () => {}),
    getHourlyPrice: vi.fn(async () => 0.7875),
    imageLike: vi.fn(async () => 'img-in-ams'),
    defaultProjectId: vi.fn(async () => 'default-proj'),
    listSecurityGroups: vi.fn(async (): Promise<Array<{ id: string; name: string }>> => []),
    createSecurityGroup: vi.fn(async () => 'sg-gw-only'),
  };
}

describe('ScalewayDeploymentBackend', () => {
  it('logs in to its own registry with the read-only registry key, and to nothing else', () => {
    const backend = new ScalewayDeploymentBackend('the-secret', { client: fakeClient() as never, registrySecret: 'read-only' });
    expect(backend.registryAuthFor('rg.fr-par.scw.cloud/aigw/speech-stack:1'))
      .toEqual({ server: 'rg.fr-par.scw.cloud', username: 'nologin', password: 'read-only' });
    expect(backend.registryAuthFor('rg.nl-ams.scw.cloud/x/y')?.server).toBe('rg.nl-ams.scw.cloud');
    expect(backend.registryAuthFor('ghcr.io/rg.fr-par.scw.cloud/x')).toBeNull();
    expect(backend.registryAuthFor('vllm/vllm-omni:v0.28.0')).toBeNull();
  });


  it('creates a tagged machine with the GPU OS image, the volume and the cloud-init', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never, projectId: 'proj' });
    const spec = buildSpec('tts', { profile: 'qwen3-tts' }, { profiles });
    const machine = await backend.createReplica({ spec, replicaToken: 't'.repeat(32), cloudInit: '#!/bin/bash\necho hi', namespace: 'prod' });
    const [instanceSpec, creds] = client.createInstance.mock.calls[0] as unknown as [Record<string, unknown>, { apiKey: string }];
    expect(instanceSpec).toMatchObject({
      region: 'fr-par-2', commercialType: 'L4-1-24G', imageId: '3307b9e4-3cfa-49b5-896e-ce914e4ef4aa', volumeGb: 80,
      tags: ['aigw-deploy', 'aigw-ns-prod', 'aigw-dep-tts', 'aigw-tls'], cloudInit: '#!/bin/bash\necho hi', projectId: 'proj',
    });
    expect(creds.apiKey).toBe('secret');
    expect(machine).toMatchObject({ id: 'fr-par-2:srv-1', deployment: 'tts', ip: '51.0.0.1', pricePerHour: 0.7875 });
  });

  it('finds the matching GPU OS image in another zone', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never });
    const spec = buildSpec('tts', { profile: 'qwen3-tts', zone: 'nl-ams-2' }, { profiles });
    await backend.createReplica({ spec, replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'prod' });
    expect((client.createInstance.mock.calls[0] as unknown as [Record<string, unknown>])[0].imageId).toBe('img-in-ams');
  });

  it('CPU deployments let the client pick Ubuntu (no image, no volume)', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never });
    await backend.createReplica({ spec: buildSpec('e', { profile: 'cpu-echo' }, { profiles }), replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'n' });
    const call = (client.createInstance.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call.imageId).toBeUndefined();
    expect(call.volumeGb).toBeUndefined();
  });

  // Regression (QA 06/10/2026): a replica without `exposure` was created with no security group, so Scaleway attached
  // the project's "Default security group" (inbound ACCEPT) and SSH 22 was reachable from the internet.
  it('puts every gateway-only replica behind a drop-by-default firewall that opens only nginx :80', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never, projectId: 'proj' });
    const spec = buildSpec('tts', { profile: 'qwen3-tts' }, { profiles });
    await backend.createReplica({ spec, replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'prod' });
    await backend.createReplica({ spec, replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'prod' });
    const calls = client.createInstance.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls.map(c => c[0].securityGroupId)).toEqual(['sg-gw-only', 'sg-gw-only']);
    expect(calls[0][0].publicIpIds).toBeUndefined();
    // Created once per zone and namespace, with only TCP 80 open (createSecurityGroup makes inbound DROP the default).
    expect(client.createSecurityGroup).toHaveBeenCalledTimes(1);
    expect(client.createSecurityGroup.mock.calls[0]).toEqual(['fr-par-2', expect.anything(), expect.objectContaining({
      projectId: 'proj', name: 'aigw-prod-gateway-only', rules: [{ protocol: 'TCP', port: 80 }],
    })]);
  });

  it('reuses the gateway-only firewall a previous process created, and resolves the default project without SCW_PROJECT_ID', async () => {
    const client = fakeClient();
    client.listSecurityGroups.mockResolvedValue([{ id: 'other', name: 'aigw-prod-gateway-only-x' }, { id: 'sg-old', name: 'aigw-prod-gateway-only' }]);
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never });
    await backend.createReplica({ spec: buildSpec('e', { profile: 'cpu-echo' }, { profiles }), replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'prod' });
    expect(client.createSecurityGroup).not.toHaveBeenCalled();
    expect(client.listSecurityGroups.mock.calls[0][2]).toEqual({ projectId: 'default-proj', name: 'aigw-prod-gateway-only' });
    expect((client.createInstance.mock.calls[0] as unknown as [Record<string, unknown>])[0].securityGroupId).toBe('sg-old');
  });

  it('refuses to create a machine when its firewall cannot be made (fail closed), and retries the lookup next time', async () => {
    const client = fakeClient();
    client.createSecurityGroup.mockRejectedValueOnce(new Error('scaleway HTTP 500'));
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never, projectId: 'proj' });
    const spec = buildSpec('tts', { profile: 'qwen3-tts' }, { profiles });
    await expect(backend.createReplica({ spec, replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'prod' })).rejects.toThrow('HTTP 500');
    expect(client.createInstance).not.toHaveBeenCalled();
    await backend.createReplica({ spec, replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'prod' });
    expect((client.createInstance.mock.calls[0] as unknown as [Record<string, unknown>])[0].securityGroupId).toBe('sg-gw-only');
  });

  it('an exposed replica keeps its own deployment firewall and reserved IP', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never, projectId: 'proj' });
    const spec = buildSpec('tts', { profile: 'qwen3-tts' }, { profiles });
    await backend.createReplica({ spec, replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'prod',
      network: { zone: 'fr-par-2', ipId: 'ip-1', ip: '51.0.0.9', groupId: 'sg-exposed' } });
    const call = (client.createInstance.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call).toMatchObject({ securityGroupId: 'sg-exposed', publicIpIds: ['ip-1'] });
    expect(client.listSecurityGroups).not.toHaveBeenCalled();
  });

  it('lists by namespace tag, maps the raw state and skips machines without a deployment tag', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never });
    const list = await backend.listReplicas('prod');
    expect(client.listInstancesByTag.mock.calls[0][0]).toBe('aigw-ns-prod');
    expect(list).toEqual([expect.objectContaining({ id: 'fr-par-2:a', deployment: 'tts', state: 'stopped in place', ip: '51.0.0.2' })]);
  });
});

describe('ScalewayDeploymentBackend list prices', () => {
  it('fills the catalog price of a listed replica (adopted after a restart it showed null), looked up once', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never });
    const [first] = await backend.listReplicas('prod');
    await backend.listReplicas('prod');
    expect(first.pricePerHour).toBe(0.7875);
    expect(client.getHourlyPrice).toHaveBeenCalledTimes(1);
  });

  it('a failed price lookup leaves null instead of failing the list', async () => {
    const client = fakeClient();
    client.getHourlyPrice.mockRejectedValue(new Error('products api down'));
    const [m] = await new ScalewayDeploymentBackend('secret', { client: client as never }).listReplicas('prod');
    expect(m.pricePerHour).toBeNull();
  });
});

describe('RateLimiter.clientIp behind a platform proxy', () => {
  const req = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: '10.0.0.1' } }) as unknown as IncomingMessage;
  afterEach(() => { delete process.env.TRUST_PROXY; });

  it('uses the socket peer unless TRUST_PROXY=1', () => {
    expect(RateLimiter.clientIp(req({ 'x-real-ip': '1.1.1.1' }))).toBe('10.0.0.1');
  });

  it('with TRUST_PROXY=1 takes X-Real-IP, else the last X-Forwarded-For hop (not the spoofable first)', () => {
    process.env.TRUST_PROXY = '1';
    expect(RateLimiter.clientIp(req({ 'x-real-ip': '1.1.1.1' }))).toBe('1.1.1.1');
    expect(RateLimiter.clientIp(req({ 'x-forwarded-for': '6.6.6.6, 2.2.2.2' }))).toBe('2.2.2.2');
    expect(RateLimiter.clientId(req({ 'x-forwarded-for': '3.3.3.3' }))).toBe('ip:3.3.3.3');
  });
});

describe('releaseNetwork', () => {
  it('a retry after the IP is gone (404) still deletes the firewall', async () => {
    const deleted: string[] = [];
    const client = {
      deleteIp: async () => { throw Object.assign(new Error('scaleway HTTP 404: not found'), { status: 404 }); },
      deleteSecurityGroup: async (_z: string, id: string) => { deleted.push(id); },
    };
    const backend = new ScalewayDeploymentBackend('k', { projectId: 'p', client: client as never });
    await backend.releaseNetwork({ zone: 'fr-par-1', ipId: 'ip-1', ip: '1.2.3.4', groupId: 'sg-1' });
    expect(deleted).toEqual(['sg-1']);
  });

  it('a real failure still throws (the controller retries)', async () => {
    const client = {
      deleteIp: async () => { throw Object.assign(new Error('scaleway HTTP 500'), { status: 500 }); },
      deleteSecurityGroup: async () => {},
    };
    const backend = new ScalewayDeploymentBackend('k', { projectId: 'p', client: client as never });
    await expect(backend.releaseNetwork({ zone: 'fr-par-1', ipId: 'ip-1', ip: '1.2.3.4', groupId: 'sg-1' })).rejects.toThrow(/500/);
  });
});
