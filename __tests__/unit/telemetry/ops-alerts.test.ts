import { afterEach, describe, expect, it } from 'vitest';
import { createOpsAlerts, OPS_ALERT_DEDUP_MS, type OpsAlert } from '../../../src/telemetry/ops-alerts';
import type { ChainReport } from '../../../src/config/stage-chains';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { _resetExternalLoad, reportExternalLoad } from '../../../src/realtime/external-load';
import { FakeCloud, until } from '../deployments/_fake-cloud';

const flush = () => new Promise(r => setTimeout(r, 0));

function rig() {
  let t = Date.parse('2026-10-12T16:00:00Z');
  const sent: OpsAlert[] = [];
  const alerts = createOpsAlerts(a => { sent.push(a); }, () => t);
  return { alerts, sent, advance: (ms: number) => { t += ms; } };
}

describe('ops alerts (O3): what reaches ALERT_WEBHOOK_URL', () => {
  it('a failed create, out of stock and no Vast credit are told apart; the same alert is sent once per 30 min', async () => {
    const { alerts, sent, advance } = rig();
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: L40S-1-48G out of stock in fr-par-2; out_of_stock' });
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: vast HTTP 400: insufficient_credit' });
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: image not found' });
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: image not found' });
    alerts.fromDeploymentLog('deployments: replica ready', { deployment: 'parle-speech', id: 'r1' });
    await flush();
    expect(sent.map(a => a.event)).toEqual(['deployment.out_of_stock', 'provider.insufficient_credit', 'deployment.create_failed']);
    expect(sent[2].data).toMatchObject({ deployment: 'parle-speech', error: 'create: image not found', at: '2026-10-12T16:00:00.000Z' });
    advance(OPS_ALERT_DEDUP_MS);
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: image not found' });
    await flush();
    expect(sent).toHaveLength(4);
  });

  it('a replica released or gone with sessions on it alerts; an empty scale-down does not', async () => {
    const { alerts, sent } = rig();
    alerts.fromDeploymentLog('deployments: releasing replica', { deployment: 'parle-speech', id: 'r1', reason: 'scale-down', busy: 0 });
    alerts.fromDeploymentLog('deployments: releasing replica', { deployment: 'parle-speech', id: 'r2', reason: 'boot-timeout', busy: 3 });
    alerts.fromDeploymentLog('deployments: replica gone', { deployment: 'parle-speech', id: 'r3', busy: 4 });
    await flush();
    expect(sent.map(a => [a.event, a.data.id, a.data.reason])).toEqual([
      ['replica.lost_with_sessions', 'r2', 'boot-timeout'], ['replica.lost_with_sessions', 'r3', 'gone'],
    ]);
  });

  it('a reserve link that dies (no key) or a stage with no link alerts once when it happens, again only after it came back', async () => {
    const { alerts, sent } = rig();
    const chain = (reserve: ChainReport['links'][number]['state'], serving: string | null): Record<string, Record<string, ChainReport>> => ({
      stt: { 'parle-stt': { serving, onFallback: false, links: [{ target: 'deployment:parle-speech', state: 'cold' }, { target: 'groq:whisper', state: reserve, reason: 'GROQ_API_KEY missing' }] } },
    });
    alerts.fromChains(chain('ready', 'groq:whisper'));
    alerts.fromChains(chain('no_key', null));
    alerts.fromChains(chain('no_key', null));
    await flush();
    expect(sent.map(a => a.event)).toEqual(['stage.no_link', 'stage.reserve_down']);
    expect(sent[1].data).toMatchObject({ stage: 'stt', model: 'parle-stt', target: 'groq:whisper', state: 'no_key' });
    alerts.fromChains(chain('ready', 'groq:whisper'));
    alerts.fromChains(chain('no_key', null));
    await flush();
    expect(sent).toHaveLength(2);
  });

  it('a webhook that throws does not break the caller', async () => {
    const alerts = createOpsAlerts(() => { throw new Error('down'); });
    expect(() => alerts.fromDeploymentLog('deployments: create failed', { deployment: 'x', error: 'boom' })).not.toThrow();
    await flush();
  });
});

describe('the controller says when a replica with sessions disappears', () => {
  const controllers: DeploymentController[] = [];
  afterEach(() => { for (const c of controllers.splice(0)) c.stop(); _resetExternalLoad(); });

  it('a replica the provider no longer lists while learners are seated logs `replica gone` with the load', async () => {
    const clock = { t: Date.now() };
    const cloud = new FakeCloud(() => clock.t);
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const c = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
      now: () => clock.t, log: (msg, data) => logs.push([msg, data]),
    });
    controllers.push(c);
    await c.init();
    await c.put('speech', { profile: 'cpu-echo', minReplicas: 1, maxEurPerHour: 2 });
    c.start();
    await until(() => c.get('speech')!.status === 'ready', 3000);
    const id = c.get('speech')!.replicas[0].id;
    clock.t += 3 * 60_000;
    reportExternalLoad('speech', id, 3, 4, clock.t);
    cloud.machines.delete(id);
    await until(() => logs.some(([m]) => m === 'deployments: replica gone'), 3000);
    expect(logs.find(([m]) => m === 'deployments: replica gone')![1]).toMatchObject({ deployment: 'speech', id, busy: expect.any(Number) });
  });
});
