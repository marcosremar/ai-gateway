import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_REFUSED_REPEAT_MS, CLASS_GPU_READY_MS, createOpsAlerts, GPU_OUTSIDE_WINDOW_MS, GPU_OUTSIDE_WINDOW_PARK_MS, OPS_ALERT_BOOT_QUIET_MS, OPS_ALERT_DEDUP_MS, type OpsAlert,
} from '../../../src/telemetry/ops-alerts';
import type { ChainReport } from '../../../src/config/stage-chains';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { _resetExternalLoad, reportExternalLoad } from '../../../src/realtime/external-load';
import { FakeCloud, until } from '../deployments/_fake-cloud';

const flush = () => new Promise(r => setTimeout(r, 0));

function rig(bootQuietMs = 0, start = '2026-10-12T16:00:00Z') {
  let t = Date.parse(start);
  const sent: OpsAlert[] = [];
  const alerts = createOpsAlerts(a => { sent.push(a); }, () => t, OPS_ALERT_DEDUP_MS, bootQuietMs);
  return { alerts, sent, advance: (ms: number) => { t += ms; } };
}

describe('ops alerts (O3): what reaches ALERT_WEBHOOK_URL', () => {
  it('a failed create, out of stock and no Vast credit are told apart; the same alert is sent once per 30 min, the Vast credit once', async () => {
    const { alerts, sent, advance } = rig();
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: L40S-1-48G out of stock in fr-par-2; out_of_stock' });
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: vast HTTP 400: insufficient_credit' });
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: image not found' });
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: image not found' });
    alerts.fromDeploymentLog('deployments: replica ready', { deployment: 'parle-speech', id: 'r1' });
    await flush();
    expect(sent.map(a => a.event)).toEqual(['deployment.out_of_stock', 'provider.credit_exhausted', 'deployment.create_failed']);
    alerts.fromDeploymentLog('deployments: provider credit exhausted', { provider: 'vast', balanceUsd: 0.4, floorUsd: 1 });
    await flush();
    expect(sent).toHaveLength(3);
    expect(sent[2].data).toMatchObject({ deployment: 'parle-speech', error: 'create: image not found', at: '2026-10-12T16:00:00.000Z' });
    advance(OPS_ALERT_DEDUP_MS);
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'parle-speech', error: 'create: image not found' });
    alerts.fromDeploymentLog('deployments: provider credit exhausted', { provider: 'vast', balanceUsd: 0.4, floorUsd: 1 });
    await flush();
    expect(sent.slice(3).map(a => a.event)).toEqual(['deployment.create_failed']);
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

  it('a boot is quiet for the chains, and the stages down together become one alert per event', async () => {
    const { alerts, sent, advance } = rig(OPS_ALERT_BOOT_QUIET_MS);
    const down = (serving: string | null): ChainReport => ({ serving, onFallback: false, links: [{ target: 'deployment:parle-speech', state: 'cold' }] });
    const allDown = { stt: { 'parle-stt': down(null) }, llm: { 'parle-llm': down(null) }, tts: { 'parle-tts': down(null), 'parle-tts-clone': down(null) } };
    alerts.fromChains(allDown);
    advance(OPS_ALERT_BOOT_QUIET_MS - 1);
    alerts.fromChains(allDown);
    await flush();
    expect(sent).toEqual([]);
    advance(1);
    alerts.fromChains(allDown);
    alerts.fromChains(allDown);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: 'stage.no_link', data: { stage: 'stt, llm, tts', count: 4 } });
    expect(String(sent[0].data.items)).toContain('tts parle-tts-clone');
  });

  it('a chain that came back during the boot quiet is never told', async () => {
    const { alerts, sent, advance } = rig(OPS_ALERT_BOOT_QUIET_MS);
    const chain = (serving: string | null) => ({ stt: { 'parle-stt': { serving, onFallback: false, links: [{ target: 'groq:whisper', state: 'ready' as const }] } } });
    alerts.fromChains(chain(null));
    advance(OPS_ALERT_BOOT_QUIET_MS);
    alerts.fromChains(chain('groq:whisper'));
    await flush();
    expect(sent).toEqual([]);
  });

  it('a GPU with a class schedule that stays up 30 min outside its window alerts; inside the window it never does', async () => {
    const { alerts, sent, advance } = rig(0, '2026-10-12T20:00:00Z');
    const warmSchedule = [{ days: [1, 2, 3, 4], start: '17:30', end: '20:30', timeZone: 'Europe/Paris', minReplicas: 1 }];
    const view = (name: string, phase: 'ready' | 'halted', schedule = warmSchedule) => ({
      name, spec: { warmSchedule: schedule } as never, replicas: [{ phase, pricePerHour: 1.4 }] as never,
    });
    const views = () => [view('parle-speech', 'ready'), view('parle-qwen-tts', 'halted'), view('parle-speech-test', 'ready', [])];
    alerts.fromDeployments(views());
    advance(GPU_OUTSIDE_WINDOW_MS - 60_000);
    alerts.fromDeployments(views());
    await flush();
    expect(sent).toEqual([]);
    advance(60_000);
    alerts.fromDeployments(views());
    await flush();
    expect(sent).toEqual([expect.objectContaining({ event: 'gpu.outside_window', data: expect.objectContaining({ deployment: 'parle-speech', minutes: 30, eurPerHour: 1.4 }) })]);

    const inClass = rig(0, '2026-10-12T15:30:00Z');
    for (let i = 0; i < 4; i++) { inClass.alerts.fromDeployments(views()); inClass.advance(30 * 60_000); }
    await flush();
    expect(inClass.sent.filter(a => a.event === 'gpu.outside_window')).toEqual([]);
  });

  it('a GPU up 60 min outside its window, no class open, no explicit warm, is parked; again 60 min later if still up', () => {
    const { alerts, advance } = rig(0, '2026-10-12T20:00:00Z');
    const schedule = [{ days: [1, 2, 3, 4], start: '17:30', end: '20:30', timeZone: 'Europe/Paris', minReplicas: 1 }];
    const view = (name: string, extra: Record<string, unknown> = {}) => ({
      name, spec: { warmSchedule: schedule } as never, replicas: [{ phase: 'ready', pricePerHour: 0.79 }] as never, ...extra,
    });
    const views = () => [view('parle-qwen-tts'), view('parle-speech', { warm: { replicas: 1, until: '2026-10-12T23:00:00Z' } })];
    expect(alerts.fromDeployments(views())).toEqual([]);
    advance(GPU_OUTSIDE_WINDOW_PARK_MS - 60_000);
    expect(alerts.fromDeployments(views())).toEqual([]);
    advance(60_000);
    expect(alerts.fromDeployments(views())).toEqual(['parle-qwen-tts']);
    advance(60_000);
    expect(alerts.fromDeployments(views())).toEqual([]);
    advance(GPU_OUTSIDE_WINDOW_PARK_MS);
    expect(alerts.fromDeployments(views())).toEqual(['parle-qwen-tts']);
  });

  it('never parks inside a class window, nor while another deployment\'s class is open', () => {
    const inClass = rig(0, '2026-10-12T15:30:00Z');
    const schedule = [{ days: [1, 2, 3, 4], start: '17:30', end: '20:30', timeZone: 'Europe/Paris', minReplicas: 1 }];
    const v = [{ name: 'parle-qwen-tts', spec: { warmSchedule: schedule } as never, replicas: [{ phase: 'ready' }] as never }];
    for (let i = 0; i < 4; i++) { expect(inClass.alerts.fromDeployments(v)).toEqual([]); inClass.advance(30 * 60_000); }
    const other = rig(0, '2026-10-12T20:00:00Z');
    const late = [{ start: '21:00', end: '23:59', timeZone: 'Europe/Paris', minReplicas: 1 }];
    const both = [...v, { name: 'evening-class', spec: { warmSchedule: late } as never, replicas: [] as never }];
    for (let i = 0; i < 4; i++) { expect(other.alerts.fromDeployments(both)).toEqual([]); other.advance(30 * 60_000); }
  });

  it('a GPU parked before 30 min outside its window restarts the count', async () => {
    const { alerts, sent, advance } = rig(0, '2026-10-12T20:00:00Z');
    const view = (phase: 'ready' | 'halted') => [{
      name: 'parle-speech', spec: { warmSchedule: [{ days: [1, 2, 3, 4], start: '17:30', end: '20:30', minReplicas: 1 }] } as never,
      replicas: [{ phase, pricePerHour: 1.4 }] as never,
    }];
    alerts.fromDeployments(view('ready'));
    advance(20 * 60_000);
    alerts.fromDeployments(view('halted'));
    advance(20 * 60_000);
    alerts.fromDeployments(view('ready'));
    await flush();
    expect(sent).toEqual([]);
  });

  it('turns slower than 3 s at p95 alert once there are enough of them', async () => {
    const { alerts, sent } = rig();
    const report = (count: number, p95Ms: number) => ({ windowSeconds: 900, stages: {}, events: { 'turn.first_audio': { count, p50Ms: 1200, p95Ms } } });
    alerts.fromLatency(null);
    alerts.fromLatency(report(5, 9000));
    alerts.fromLatency(report(40, 2900));
    await flush();
    expect(sent).toEqual([]);
    alerts.fromLatency(report(40, 3400));
    alerts.fromLatency(report(41, 3500));
    await flush();
    expect(sent).toEqual([expect.objectContaining({ event: 'turn.slow', data: expect.objectContaining({ stage: 'turn.first_audio', p95Ms: 3400, turns: 40 }) })]);
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

describe('a provider account refusal (incident 13/10/2026)', () => {
  const REFUSED = {
    deployment: 'speech-stack', provider: 'scaleway', place: 'scaleway L4-1-24G@fr-par-2', reason: 'permissão negada (IAM)', fix: 'corrija a chave', status: 403, next: 'vast',
    error: 'scaleway HTTP 403: {"type":"permissions_denied"}',
  };

  it('is urgent, says it will not fix itself, repeats every hour while it lasts, and shows on the overview and the GPU page', async () => {
    const { createIncidents } = await import('../../../src/telemetry/incidents');
    const { opsAlertMail } = await import('../../../src/telemetry/alert-email');
    const { demoSnapshot } = await import('../../__fixtures__/admin-snapshot');
    const { renderGpuDetail, renderStatus } = await import('../../../src/admin-page/pages');
    let t = Date.parse('2026-10-13T15:40:00Z');
    const incidents = createIncidents({ now: () => t });
    const sent: OpsAlert[] = [];
    const alerts = createOpsAlerts(a => { sent.push(a); }, () => t, OPS_ALERT_DEDUP_MS, 0, incidents);
    for (let minute = 0; minute <= 125; minute += 5) {
      alerts.fromDeploymentLog('deployments: provider account refused', minute === 30 ? { ...REFUSED, deployment: 'parle-qwen-tts', next: null } : REFUSED);
      t += 5 * 60_000;
    }
    await flush();
    expect(sent.map(a => [a.event, a.key])).toEqual(Array(3).fill(['provider.account_refused', 'scaleway']));
    expect(ACCOUNT_REFUSED_REPEAT_MS).toBe(60 * 60_000);
    const mail = opsAlertMail(sent[0]!)!;
    expect(mail).toMatchObject({
      level: 'urgent', subject: 'a Scaleway recusou criar servidor: permissão negada (IAM) — não se resolve sozinho: corrija a chave; usando a Vast',
    });
    expect(mail.body).toContain('Isto não se resolve sozinho');
    expect(incidents.list().filter(i => !i.endedAt).map(i => i.event)).toEqual(['provider.account_refused']);

    const s = { ...demoSnapshot(t), incidents: incidents.list() };
    const opts = { now: t, csrf: 'c', actor: 'marcos', message: null, app: null };
    expect(renderStatus('n', s, opts)).toContain('Provedor recusou a conta (permissão ou chave): não se resolve sozinho');
    expect(renderGpuDetail('n', s, 'speech-stack', opts)).toContain('Provedor recusou a conta');
    expect(renderGpuDetail('n', s, 'babelcast-3090', opts)).not.toContain('Provedor recusou a conta');
  });

  it('a 403 in the janitor sweep, every 5 min for 15 h, is one urgent alert per hour, never a silent log', async () => {
    const { opsAlertMail } = await import('../../../src/telemetry/alert-email');
    const { alerts, sent, advance } = rig();
    for (let minute = 0; minute < 15 * 60; minute += 5) {
      alerts.fromDeploymentLog('janitor: sweep failed', { error: 'scaleway GET https://api.scaleway.com/block/v1alpha1/zones/fr-par-2/volumes: HTTP 403' });
      advance(5 * 60_000);
    }
    alerts.fromDeploymentLog('janitor: sweep failed', { error: 'scaleway GET https://api.scaleway.com/instance/v1/zones/fr-par-2/servers: HTTP 503' });
    await flush();
    expect(sent).toHaveLength(15);
    expect(new Set(sent.map(a => `${a.event}|${a.key}`))).toEqual(new Set(['provider.account_refused|scaleway']));
    expect(opsAlertMail(sent[0]!)).toMatchObject({
      level: 'urgent', subject: 'a Scaleway recusou a limpeza do gateway (janitor): permissão negada (IAM) — não se resolve sozinho: corrija a chave',
    });
  });

  it('a create that failed on a 401/403 is the urgent account alert, not «o gateway tenta de novo sozinho»', async () => {
    const { alerts, sent } = rig();
    alerts.fromDeploymentLog('deployments: create failed', {
      deployment: 'parle-qwen-tts', error: 'create: scaleway HTTP 403: {"type":"permissions_denied","resource":"compute_servers","action":"create"}',
    });
    await flush();
    expect(sent.map(a => [a.event, a.key, a.data.headline])).toEqual([[
      'provider.account_refused', 'scaleway', 'a Scaleway recusou criar servidor para parle-qwen-tts: permissão negada (IAM) — não se resolve sozinho: corrija a chave',
    ]]);
  });

  it('a refusal for lack of credit is the credit alert', async () => {
    const { alerts, sent } = rig();
    alerts.fromDeploymentLog('deployments: provider account refused', { ...REFUSED, provider: 'vast', reason: 'sem crédito', fix: 'recarregue a conta', status: null, next: 'scaleway' });
    await flush();
    expect(sent.map(a => [a.event, a.key, a.data.headline])).toEqual([
      ['provider.credit_exhausted', 'vast', 'a Vast recusou criar servidor: sem crédito — não se resolve sozinho: recarregue a conta; usando a Scaleway'],
    ]);
  });
});

describe('class GPU not ready 20 min after the warm window opens (incident 13/10/2026, item D)', () => {
  const CLASS = [{ days: [1, 2, 3, 4], start: '17:30', end: '20:30', timeZone: 'Europe/Paris', minReplicas: 1 }];
  const gpu = (name: string, provider: 'vast' | 'scaleway', phase: string | null, lastError: string | null) => ({
    name, spec: { provider, warmSchedule: CLASS } as never, lastError, lastPlacement: null,
    replicas: phase ? [{ id: `${name}-1`, phase, provider, pricePerHour: 0.5, ageSeconds: 60 } as never] : [],
  });

  it('names the deployment, its provider and the last error; quiet before 20 min and once a replica is ready', async () => {
    const { createIncidents } = await import('../../../src/telemetry/incidents');
    const { opsAlertMail } = await import('../../../src/telemetry/alert-email');
    let t = Date.parse('2026-10-14T15:30:00Z');
    const incidents = createIncidents({ now: () => t });
    const sent: OpsAlert[] = [];
    const alerts = createOpsAlerts(a => { sent.push(a); }, () => t, OPS_ALERT_DEDUP_MS, 0, incidents);
    const speechError = 'create: no replica placed; skipped: vast RTX 5090: out_of_stock: no vast offer for RTX 5090 under €0.85/h near FR';
    const qwenError = 'create: no replica placed; skipped: scaleway L4-1-24G@fr-par-2: Scaleway desativada (dono, 14/10/2026)';
    const views = [gpu('parle-speech', 'vast', 'booting', speechError), gpu('parle-qwen-tts', 'scaleway', null, qwenError)];

    t += CLASS_GPU_READY_MS - 60_000;
    alerts.fromDeployments(views);
    await flush();
    expect(sent).toEqual([]);

    t += 60_000;
    alerts.fromDeployments(views);
    await flush();
    expect(sent.map(a => [a.event, a.key])).toEqual([['class.gpu_not_ready', 'parle-speech'], ['class.gpu_not_ready', 'parle-qwen-tts']]);
    expect(sent[0]!.data).toMatchObject({ gpuProvider: 'vast', error: speechError, replicas: 1 });
    expect(opsAlertMail(sent[0]!)).toMatchObject({
      level: 'urgent', subject: `aula: parle-speech sem GPU pronta 20 min depois de abrir a janela (Vast): ${speechError}`,
    });
    expect(opsAlertMail(sent[1]!)!.subject).toContain('(Scaleway): create: no replica placed; skipped: scaleway L4-1-24G@fr-par-2: Scaleway desativada');

    t += 5 * 60_000;
    alerts.fromDeployments([gpu('parle-speech', 'vast', 'ready', null), views[1]!]);
    await flush();
    expect(sent).toHaveLength(2);
    expect(incidents.list().filter(i => !i.endedAt).map(i => i.key)).toEqual(['parle-qwen-tts']);

    t = Date.parse('2026-10-16T15:55:00Z');
    alerts.fromDeployments(views);
    await flush();
    expect(sent).toHaveLength(2);
  });
});
