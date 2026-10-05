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
  };
}

describe('ScalewayDeploymentBackend', () => {
  it('logs in to its own registry with the API secret, and to nothing else', () => {
    const backend = new ScalewayDeploymentBackend('the-secret', { client: fakeClient() as never });
    expect(backend.registryAuthFor('rg.fr-par.scw.cloud/aigw/speech-stack:1'))
      .toEqual({ server: 'rg.fr-par.scw.cloud', username: 'nologin', password: 'the-secret' });
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
      tags: ['aigw-deploy', 'aigw-ns-prod', 'aigw-dep-tts'], cloudInit: '#!/bin/bash\necho hi', projectId: 'proj',
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

  it('a pinned image follows a replica moved to another zone (image ids are per zone)', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never });
    const pinned = '11111111-2222-3333-4444-555555555555';
    const spec = buildSpec('tts', { profile: 'qwen3-tts', osImageId: pinned }, { profiles });
    await backend.createReplica({ spec, replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'p', baseZone: 'fr-par-2' });
    await backend.createReplica({ spec: { ...spec, zone: 'pl-waw-2' }, replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'p', baseZone: 'fr-par-2' });
    const images = client.createInstance.mock.calls.map(c => (c as unknown as [Record<string, unknown>])[0].imageId);
    expect(images).toEqual([pinned, 'img-in-ams']);
    expect(client.imageLike).toHaveBeenCalledWith(pinned, 'pl-waw-2', 'L4-1-24G', expect.anything());
  });

  it('reads the stock of a GPU type from the catalog', async () => {
    const client = { ...fakeClient(), listGpuOffers: vi.fn(async () => [{ zone: 'fr-par-2', commercialType: 'L4-1-24G', availability: 'shortage' }]) };
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never });
    expect(await backend.availability('fr-par-2', 'L4-1-24G')).toBe('shortage');
    expect(await backend.availability('fr-par-2', 'H100-1-80G')).toBeNull();
  });

  it('CPU deployments let the client pick Ubuntu (no image, no volume)', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never });
    await backend.createReplica({ spec: buildSpec('e', { profile: 'cpu-echo' }, { profiles }), replicaToken: 't'.repeat(32), cloudInit: 'x', namespace: 'n' });
    const call = (client.createInstance.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call.imageId).toBeUndefined();
    expect(call.volumeGb).toBeUndefined();
  });

  it('lists by namespace tag, maps the raw state and skips machines without a deployment tag', async () => {
    const client = fakeClient();
    const backend = new ScalewayDeploymentBackend('secret', { client: client as never });
    const list = await backend.listReplicas('prod');
    expect(client.listInstancesByTag.mock.calls[0][0]).toBe('aigw-ns-prod');
    expect(list).toEqual([expect.objectContaining({ id: 'fr-par-2:a', deployment: 'tts', state: 'stopped in place', ip: '51.0.0.2' })]);
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
