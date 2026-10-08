/**
 * Scaleway pieces used by long-lived hosts (Qwen TTS L4, own LiveKit VPS, cloud-play): extra user_data keys,
 * reserved routed IPs, security groups, single-server reads, tag listing, background volume cleanup, and
 * writes that fail loudly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScalewayClient } from '../../src/cpu-providers/scaleway-client';

const creds = { apiKey: 'scw-secret-xxxxxxxxxxxxxxxxxx' };
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

type Call = { url: string; method: string; body: unknown };
const calls = (): Call[] => mockFetch.mock.calls.map(([url, init]) => ({
  url: String(url), method: (init as RequestInit | undefined)?.method ?? 'GET', body: (init as RequestInit | undefined)?.body,
}));

function json(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) } as Response;
}

const SERVER = {
  id: 'srv-1', name: 'parle-qwen-tts', state: 'stopped', commercial_type: 'L4-1-24G', creation_date: '2026-09-29T10:00:00Z',
  tags: ['parle-tts'], volumes: { 0: { id: 'vol-1' } },
  public_ips: [{ id: 'ip6', address: '2001:db8::1', family: 'inet6' }, { id: 'ip4', address: '51.15.1.2', family: 'inet' }],
};

/** Route by URL + method so call order inside the client does not matter. */
function route(handlers: Array<[RegExp, string, (body: unknown) => Response]>) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const hit = handlers.find(([re, m]) => re.test(String(url)) && m === method);
    if (!hit) throw new Error(`unexpected ${method} ${url}`);
    return hit[2](init?.body);
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  process.env.SCALEWAY_VOLUME_RETRY_MS = '0';
});

describe('ScalewayClient for hosts', () => {
  it('writes extra user_data keys before cloud-init and power-on, passing #cloud-config through untouched', async () => {
    route([
      [/\/servers$/, 'POST', () => json({ server: { ...SERVER, state: 'stopped' } })],
      [/\/user_data\/voice-a$/, 'PATCH', () => json({})],
      [/\/user_data\/cloud-init$/, 'PATCH', () => json({})],
      [/\/action$/, 'POST', () => json({})],
      [/\/servers\/srv-1$/, 'GET', () => json({ server: { ...SERVER, state: 'starting' } })],
    ]);
    const client = new ScalewayClient();
    const made = await client.createInstance({
      region: 'fr-par-2', commercialType: 'L4-1-24G', projectId: 'proj-1', label: 'parle-qwen-tts', tags: ['parle-tts'],
      userDataFiles: { 'voice-a': new Uint8Array([1, 2, 3]) }, cloudInit: '#cloud-config\nruncmd: []', volumeGb: 80,
    }, creds);
    const order = calls().map(c => `${c.method} ${c.url.replace(/^.*\/zones\/fr-par-2/, '')}`);
    expect(order.indexOf('PATCH /servers/srv-1/user_data/voice-a')).toBeLessThan(order.indexOf('PATCH /servers/srv-1/user_data/cloud-init'));
    expect(order.indexOf('PATCH /servers/srv-1/user_data/cloud-init')).toBeLessThan(order.indexOf('POST /servers/srv-1/action'));
    expect(calls().find(c => c.url.endsWith('/user_data/cloud-init'))?.body).toBe('#cloud-config\nruncmd: []');
    const create = JSON.parse(String(calls().find(c => c.url.endsWith('/servers') && c.method === 'POST')?.body));
    expect(create).toMatchObject({ name: 'parle-qwen-tts', commercial_type: 'L4-1-24G', project: 'proj-1', dynamic_ip_required: true });
    expect(made.ipAddress).toBe('51.15.1.2'); // IPv4, not the first (IPv6) entry
    expect(made.providerMeta).toMatchObject({ createdAt: '2026-09-29T10:00:00Z', volumeIds: ['vol-1'] });
  });

  it('attaches reserved IPs and a security group instead of a dynamic IP', async () => {
    route([
      [/marketplace\/v2\/local-images/, 'GET', () => json({ local_images: [
        { id: 'img-bs', compatible_commercial_types: ['PLAY2-MICRO'], type: 'instance_local' },
        { id: 'img-sbs', compatible_commercial_types: ['PLAY2-MICRO'], type: 'instance_sbs' },
      ] })],
      [/\/servers$/, 'POST', () => json({ server: { ...SERVER, commercial_type: 'PLAY2-MICRO' } })],
      [/\/user_data\/cloud-init$/, 'PATCH', () => json({})],
      [/\/action$/, 'POST', () => json({})],
      [/\/servers\/srv-1$/, 'GET', () => json({ server: { ...SERVER, state: 'starting' } })],
    ]);
    await new ScalewayClient().createInstance({
      region: 'fr-par-1', commercialType: 'PLAY2-MICRO', projectId: 'proj-1', volumeGb: 50,
      publicIpIds: ['ip-reserved'], securityGroupId: 'sg-1', cloudInit: '#cloud-config\n',
    }, creds);
    const create = JSON.parse(String(calls().find(c => c.url.endsWith('/servers') && c.method === 'POST')?.body));
    expect(create).toMatchObject({ image: 'img-sbs', public_ips: ['ip-reserved'], security_group: 'sg-1', dynamic_ip_required: false });
  });

  it('a failed user_data write aborts the create and cleans up instead of booting without its script', async () => {
    route([
      [/\/servers$/, 'POST', () => json({ server: SERVER })],
      [/\/user_data\/cloud-init$/, 'PATCH', () => json({ message: 'not found' }, 404)],
      [/\/servers\/srv-1$/, 'GET', () => json({ server: SERVER })],
      [/\/action$/, 'POST', () => json({})],
      [/\/servers\/srv-1$/, 'DELETE', () => json({}, 204)],
      [/block\/v1alpha1\/zones\/fr-par-2\/volumes\/vol-1$/, 'DELETE', () => json({}, 204)],
    ]);
    await expect(new ScalewayClient().createInstance({
      region: 'fr-par-2', commercialType: 'L4-1-24G', projectId: 'proj-1', cloudInit: '#!/bin/bash\necho',
    }, creds)).rejects.toThrow(/404/);
    expect(calls().some(c => c.url.endsWith('/action') && String(c.body).includes('poweron'))).toBe(false);
    expect(calls().some(c => c.url.endsWith('/volumes/vol-1') && c.method === 'DELETE')).toBe(true);
  });

  it('getInstance returns the raw state and null on 404', async () => {
    route([[/\/servers\/srv-1$/, 'GET', () => json({ server: { ...SERVER, state: 'stopping' } })]]);
    const client = new ScalewayClient();
    const one = await client.getInstance('fr-par-2:srv-1', creds);
    expect(one?.status).toBe('stopped');
    expect(one?.providerMeta).toMatchObject({ state: 'stopping', tags: ['parle-tts'], publicIpIds: ['ip6', 'ip4'] });
    route([[/\/servers\/gone$/, 'GET', () => json({ message: 'not found' }, 404)]]);
    expect(await client.getInstance('fr-par-2:gone', creds)).toBeNull();
  });

  it('listInstancesByTag scopes by project and zone, and a failed zone throws instead of reading as empty', async () => {
    route([[/fr-par-2\/servers\?project=proj-1&tags=parle-tts/, 'GET', () => json({ servers: [SERVER] })]]);
    const client = new ScalewayClient();
    const list = await client.listInstancesByTag('parle-tts', creds, { zones: ['fr-par-2'], projectId: 'proj-1' });
    expect(list.map(i => i.instanceId)).toEqual(['fr-par-2:srv-1']);
    route([[/servers\?/, 'GET', () => json({ message: 'boom' }, 500)]]);
    await expect(client.listInstancesByTag('parle-tts', creds, { zones: ['fr-par-2'] })).rejects.toThrow(/500/);
  });

  it('releaseInstance without awaiting volumes returns once the server is gone', async () => {
    let volumeDeletes = 0;
    route([
      [/\/servers\/srv-1$/, 'GET', () => json({ server: SERVER })],
      [/\/action$/, 'POST', () => json({})],
      [/volumes\/vol-1$/, 'DELETE', () => { volumeDeletes++; return json({ message: 'in use' }, 412); }],
    ]);
    await new ScalewayClient().releaseInstance('fr-par-2:srv-1', creds, { awaitVolumes: false });
    expect(calls().some(c => c.url.endsWith('/action') && String(c.body).includes('terminate'))).toBe(true);
    await new Promise(r => setTimeout(r, 5));
    expect(volumeDeletes).toBeGreaterThan(0);
  });

  it('regression: a transient 503 on the pre-release GET does not leak the volume (server found by list, not created here)', async () => {
    let gets = 0;
    const deleted: string[] = [];
    route([
      [/\/servers\/srv-1$/, 'GET', () => (++gets === 1 ? json({ message: 'unavailable' }, 503) : json({ server: SERVER }))],
      [/\/action$/, 'POST', () => json({})],
      [/volumes\/vol-1$/, 'DELETE', () => { deleted.push('vol-1'); return json({}, 204); }],
    ]);
    await new ScalewayClient().releaseInstance('fr-par-2:srv-1', creds, { awaitVolumes: true });
    expect(deleted).toEqual(['vol-1']);
  });

  it('regression: the caller-known volume ids are deleted even when the server GET keeps failing', async () => {
    const deleted: string[] = [];
    route([
      [/\/servers\/srv-1$/, 'GET', () => json({ message: 'unavailable' }, 503)],
      [/\/action$/, 'POST', () => json({})],
      [/volumes\/vol-9$/, 'DELETE', () => { deleted.push('vol-9'); return json({}, 204); }],
    ]);
    await new ScalewayClient().releaseInstance('fr-par-2:srv-1', creds, { awaitVolumes: true, volumeIds: ['vol-9'] });
    expect(deleted).toEqual(['vol-9']);
  });

  it('lists GPU offers per zone with price, GPU memory and stock; a failing zone is skipped, all failing throws', async () => {
    const GiB = 1024 ** 3;
    route([
      [/fr-par-2\/products\/servers\?/, 'GET', () => json({ servers: {
        'L4-1-24G': { hourly_price: 0.7875, gpu: 1, gpu_info: { gpu_name: 'L4', gpu_memory: 24 * GiB } },
        'L40S-1-48G': { hourly_price: 1.4, gpu: 1, gpu_info: { gpu_name: 'L40S', gpu_memory: 48 * GiB } },
        'DEV1-S': { hourly_price: 0.0088, gpu: 0 },
      } })],
      [/fr-par-2\/products\/servers\/availability/, 'GET', () => json({ servers: { 'L4-1-24G': { availability: 'shortage' }, 'L40S-1-48G': { availability: 'available' } } })],
      [/pl-waw-2\/products\/servers\?/, 'GET', () => json({ servers: { 'L4-1-24G': { hourly_price: 0.75, gpu: 1, gpu_info: { gpu_name: 'L4', gpu_memory: 24 * GiB } } } })],
      [/pl-waw-2\/products\/servers\/availability/, 'GET', () => json({ message: 'down' }, 503)],
      [/nl-ams-1\/products\/servers\?/, 'GET', () => json({ message: 'down' }, 503)],
    ]);
    const client = new ScalewayClient();
    expect(await client.listGpuOffers(['fr-par-2', 'pl-waw-2', 'nl-ams-1'], creds)).toEqual([
      { zone: 'fr-par-2', commercialType: 'L4-1-24G', hourlyPrice: 0.7875, gpuCount: 1, gpuName: 'L4', gpuMemoryGb: 24, availability: 'shortage' },
      { zone: 'fr-par-2', commercialType: 'L40S-1-48G', hourlyPrice: 1.4, gpuCount: 1, gpuName: 'L40S', gpuMemoryGb: 48, availability: 'available' },
      { zone: 'pl-waw-2', commercialType: 'L4-1-24G', hourlyPrice: 0.75, gpuCount: 1, gpuName: 'L4', gpuMemoryGb: 24, availability: null },
    ]);
    await expect(client.listGpuOffers(['nl-ams-1'], creds)).rejects.toThrow(/unavailable in all 1 zone/);
  });

  it('finds the same marketplace image in another zone by label, compatible with the type', async () => {
    route([
      [/local-images\/img-par$/, 'GET', () => json({ local_image: { id: 'img-par', label: 'ubuntu_noble_gpu_os_12' } })],
      [/local-images\?image_label=ubuntu_noble_gpu_os_12&zone=pl-waw-2/, 'GET', () => json({ local_images: [
        { id: 'img-waw-other', compatible_commercial_types: ['H100-1-80G'], type: 'instance_sbs' },
        { id: 'img-waw-l4', compatible_commercial_types: ['L4-1-24G'], type: 'instance_sbs' },
      ] })],
    ]);
    const client = new ScalewayClient();
    expect(await client.imageLike('img-par', 'pl-waw-2', 'L4-1-24G', creds)).toBe('img-waw-l4');
    expect(await client.imageLike('img-par', 'pl-waw-2', 'RENDER-S', creds)).toBeNull();
  });

  it('reserves routed IPs and builds a drop-by-default security group with one rule per port', async () => {
    route([
      [/\/ips$/, 'POST', () => json({ ip: { id: 'ip-1', address: '51.15.9.9' } })],
      [/\/security_groups$/, 'POST', () => json({ security_group: { id: 'sg-1' } })],
      [/\/security_groups\/sg-1\/rules$/, 'POST', () => json({ rule: {} })],
      [/\/ips\/ip-1$/, 'DELETE', () => json({ message: 'denied' }, 403)],
    ]);
    const client = new ScalewayClient();
    expect(await client.reserveRoutedIp('fr-par-1', creds, { projectId: 'proj-1', tags: ['lk'] })).toEqual({ id: 'ip-1', address: '51.15.9.9' });
    expect(JSON.parse(String(calls()[0].body))).toEqual({ project: 'proj-1', type: 'routed_ipv4', tags: ['lk'] });
    const id = await client.createSecurityGroup('fr-par-1', creds, {
      projectId: 'proj-1', name: 'lk', rules: [{ protocol: 'TCP', port: 443 }, { protocol: 'UDP', port: 7882 }],
    });
    expect(id).toBe('sg-1');
    expect(JSON.parse(String(calls()[1].body))).toMatchObject({ stateful: true, inbound_default_policy: 'drop', outbound_default_policy: 'accept' });
    expect(calls().filter(c => c.url.endsWith('/rules')).map(c => JSON.parse(String(c.body)).dest_port_from)).toEqual([443, 7882]);
    await expect(client.deleteIp('fr-par-1', 'ip-1', creds)).rejects.toThrow(/403/);
  });

  it('getHourlyPrice reads the zone catalog and pages until the type shows up', async () => {
    const page1 = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`T-${i}`, { hourly_price: 0.01 }]));
    route([
      [/products\/servers\?per_page=100&page=1$/, 'GET', () => json({ servers: page1 })],
      [/products\/servers\?per_page=100&page=2$/, 'GET', () => json({ servers: { 'L4-1-24G': { hourly_price: 0.7875 } } })],
    ]);
    const client = new ScalewayClient();
    expect(await client.getHourlyPrice('fr-par-2', 'L4-1-24G', creds)).toBe(0.7875);
    expect(await client.getHourlyPrice('fr-par-2', 'NOPE', creds)).toBeNull();
  });

  it('cloudInitFor renders the boot script from the created server id (default hostname needs it)', async () => {
    route([
      [/\/servers$/, 'POST', () => json({ server: SERVER })],
      [/\/user_data\/cloud-init$/, 'PATCH', () => json({})],
      [/\/action$/, 'POST', () => json({})],
      [/\/servers\/srv-1$/, 'GET', () => json({ server: { ...SERVER, state: 'starting' } })],
    ]);
    await new ScalewayClient().createInstance({
      region: 'fr-par-1', commercialType: 'POP2-HC-8C-16G', projectId: 'proj-1', volumeGb: 50, imageId: 'img',
      cloudInit: '#cloud-config\nignored: true', cloudInitFor: ({ serverId, ip }) => `#cloud-config\nhost: ${serverId}.pub.instances.scw.cloud\nip: ${ip}`,
    }, creds);
    expect(calls().find(c => c.url.endsWith('/user_data/cloud-init'))?.body).toBe('#cloud-config\nhost: srv-1.pub.instances.scw.cloud\nip: 51.15.1.2');
  });
});
