/**
 * Stage-aware replica readiness (HttpReplicaProbe + healthBodyReady) and per-machine-type env profiles
 * (spec.envByMachineType → replicaCloudInit merge, nginx WebSocket upgrade).
 */

import { describe, expect, it } from 'vitest';
import { healthBodyReady, HttpReplicaProbe } from '../../../src/deployments/http';
import { nginxConfig, replicaCloudInit } from '../../../src/deployments/cloud-init';
import { buildSpec, parsePartialSpec, SpecError } from '../../../src/deployments/spec';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import type { ReplicaMachine } from '../../../src/deployments/types';

const machine: ReplicaMachine = {
  id: 'm1', deployment: 'd', ip: '10.0.0.1', state: 'running', createdAt: 0,
  zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour: 0.5,
};

const spec = buildSpec('d', { image: 'img:1', port: 8000 }, { profiles: new Map() });

function fakeFetch(health: { status: number; body?: unknown }): typeof fetch {
  return (async (url: string) => {
    if (url.endsWith('/__aigw/ready')) return new Response('{"ready":true}', { status: 200 });
    if (health.body === undefined) return new Response('ok', { status: health.status });
    return new Response(JSON.stringify(health.body), { status: health.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('healthBodyReady', () => {
  it('treats a plain 200 (no JSON, or JSON without readiness fields) as ready', () => {
    expect(healthBodyReady(null)).toBe(true);
    expect(healthBodyReady('ok')).toBe(true);
    expect(healthBodyReady({ uptime: 12 })).toBe(true);
  });

  it('treats ok/ready false as not ready even on HTTP 200', () => {
    expect(healthBodyReady({ ok: false })).toBe(false);
    expect(healthBodyReady({ ready: false, detail: 'warming' })).toBe(false);
    expect(healthBodyReady({ ok: true })).toBe(true);
  });

  it('flags a pipeline stage that is still loading or failed', () => {
    expect(healthBodyReady({ stt: 'downloading', llm: 'loaded', tts: 'loaded' })).toBe(false);
    expect(healthBodyReady({ stt: 'loaded', llm: 'loaded', tts: 'failed' })).toBe(false);
    expect(healthBodyReady({ stt: 'loaded', llm: 'loaded', tts: 'loaded' })).toBe(true);
    expect(healthBodyReady({ stt: { status: 'warming' } })).toBe(false);
    expect(healthBodyReady({ llm: { ready: false } })).toBe(false);
    // Speech-stack shape: stage stats objects without a status are not a readiness verdict.
    expect(healthBodyReady({ ok: true, stt: { batches: 3, clips: 8 } })).toBe(true);
  });
});

describe('HttpReplicaProbe', () => {
  const token = 't'.repeat(24);

  it('is not ready when health reports a stage still loading, despite HTTP 200', async () => {
    const probe = new HttpReplicaProbe(1000, fakeFetch({ status: 200, body: { ok: false, stt: 'loading', detail: 'warm' } }));
    expect(await probe.ready(machine, spec, token)).toBe(false);
  });

  it('is ready when every reported stage is loaded', async () => {
    const probe = new HttpReplicaProbe(1000, fakeFetch({ status: 200, body: { ok: true, stt: { batches: 1 }, detail: 'warm' } }));
    expect(await probe.ready(machine, spec, token)).toBe(true);
  });

  it('keeps the status-code contract for apps without a JSON health body', async () => {
    const probe = new HttpReplicaProbe(1000, fakeFetch({ status: 200 }));
    expect(await probe.ready(machine, spec, token)).toBe(true);
    const down = new HttpReplicaProbe(1000, fakeFetch({ status: 503 }));
    expect(await down.ready(machine, spec, token)).toBe(false);
  });
});

describe('envByMachineType', () => {
  it('parses a per-machine env map and rejects bad shapes', () => {
    const parsed = parsePartialSpec({ envByMachineType: { 'L40S-1-48G': { STT_BATCH: '8' } } });
    expect(parsed.envByMachineType?.['L40S-1-48G']).toEqual({ STT_BATCH: '8' });
    expect(() => parsePartialSpec({ envByMachineType: ['x'] })).toThrow(SpecError);
    expect(() => parsePartialSpec({ envByMachineType: { 'L4-1-24G': { BAD: ['a'] } } })).toThrow(SpecError);
  });

  it('merges the machine-tuned env under the explicit env in the replica cloud-init', () => {
    const tuned = buildSpec('s', {
      image: 'img:1', port: 8000, machineType: 'L40S-1-48G',
      env: { STT_BATCH: '6' },
      envByMachineType: { 'L40S-1-48G': { STT_BATCH: '8', LLM_PARALLEL: '16' }, 'L4-1-24G': { STT_BATCH: '4' } },
    }, { profiles: new Map() });
    const init = replicaCloudInit(tuned, 'x'.repeat(24));
    const envFile = /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/srv\/aigw\/app\.env/.exec(init)![1]!;
    const env = Buffer.from(envFile, 'base64').toString();
    expect(env).toContain('LLM_PARALLEL=16');   // tuned value for this machine type applied
    expect(env).toContain('STT_BATCH=6');       // explicit env wins over the tuned 8
    expect(env).not.toContain('STT_BATCH=4');   // other machine types stay out
    expect(env).not.toContain('STT_BATCH=8');
  });

  it('the speech-stack profile carries the measured per-GPU settings and a real cold-start budget', () => {
    const profile = BUILTIN_PROFILES.find(p => p.name === 'speech-stack');
    expect(profile).toBeDefined();
    expect(profile!.spec.envByMachineType?.['L40S-1-48G']).toMatchObject({ STT_BATCH: '8', LLM_PARALLEL: '16' });
    expect(profile!.spec.envByMachineType?.['L4-1-24G']?.STT_BATCH).toBe('4');
    expect(profile!.spec.coldStartWaitSeconds).toBeGreaterThanOrEqual(540); // measured cold start is 8–9 min
    expect(profile!.spec.idleAction).toBe('stop');
    const spec = buildSpec('s2s', { profile: 'speech-stack' }, { profiles: new Map([['speech-stack', profile!]]) });
    const init = replicaCloudInit(spec, 'x'.repeat(24));
    const envFile = /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/srv\/aigw\/app\.env/.exec(init)![1]!;
    expect(Buffer.from(envFile, 'base64').toString()).toContain('STT_BATCH=4'); // default machineType is the L4
  });
});

describe('replica nginx', () => {
  it('passes WebSocket upgrades through the token-gated front', () => {
    const conf = nginxConfig('x'.repeat(24));
    expect(conf).toContain('proxy_set_header Upgrade $http_upgrade');
    expect(conf).toContain('proxy_set_header Connection $aigw_conn');
    expect(conf).toContain('map $http_upgrade $aigw_conn');
  });
});
