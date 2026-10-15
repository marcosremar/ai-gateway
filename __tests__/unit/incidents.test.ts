import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createIncidents, INCIDENTS_KEPT, type Incident } from '../../src/telemetry/incidents';
import { createOpsAlerts, OPS_ALERT_DEDUP_MS, type OpsAlert } from '../../src/telemetry/ops-alerts';
import { incidentResolvedMail, opsIncidentMail } from '../../src/telemetry/alert-email';
import { scopeToApp } from '../../src/admin-page';
import { PAGES, renderStatus } from '../../src/admin-page/pages';
import type { DeploymentView } from '../../src/deployments/types';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const T0 = Date.parse('2026-10-13T16:00:00Z');
const MIN = 60_000;
const flush = () => new Promise(r => setTimeout(r, 0));

function rig(quietMs = 30 * MIN, path: string | null = null) {
  const clock = { t: T0 };
  const resolved: Incident[] = [];
  const incidents = createIncidents({ path, now: () => clock.t, quietMs, onResolve: i => resolved.push({ ...i }) });
  return { clock, incidents, resolved, advance: (ms: number) => { clock.t += ms; } };
}
const alert = (event: string, key: string, data: Record<string, unknown> = { deployment: key }) => ({ event, key, data });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('incidents: grouping and closing', () => {
  it('groups alerts of the same cause and target into one incident; a heartbeat keeps it open without adding an alert', () => {
    const { incidents, advance } = rig();
    incidents.seen(alert('gpu.idle', 'babel-live'), true);
    advance(15_000);
    incidents.seen(alert('gpu.idle', 'babel-live'), false);
    advance(30 * MIN);
    incidents.seen(alert('gpu.idle', 'babel-live', { deployment: 'babel-live', minutes: 48 }), true);
    incidents.seen(alert('gpu.idle', 'speech-stack'), true);
    incidents.seen(alert('gpu.outside_window', 'babel-live'), true);
    const list = incidents.list();
    expect(list.map(i => [i.event, i.key, i.alertCount])).toEqual([['gpu.outside_window', 'babel-live', 1], ['gpu.idle', 'speech-stack', 1], ['gpu.idle', 'babel-live', 2]]);
    expect(list[2]!.alerts[0]!.summary).toBe('deployment: babel-live, minutes: 48');
    expect(list[2]!.lastSeenAt).toBe(new Date(T0 + 30 * MIN + 15_000).toISOString());
  });

  it('closes when the checker says the condition is gone, keeps a grouped incident open while any part is still active', () => {
    const { incidents, resolved } = rig();
    incidents.seen(alert('gpu.idle', 'babel-live'), true);
    incidents.seen(alert('stage.reserve_down', 'stage.reserve_down|stt|parle-stt|groq:w,stage.reserve_down|tts|parle-tts|or:k'), true);
    incidents.clear('gpu.idle', new Set(['babel-live']));
    incidents.clear('stage.reserve_down', new Set(['stage.reserve_down|tts|parle-tts|or:k']));
    expect(resolved).toEqual([]);
    incidents.clear('gpu.idle', new Set());
    incidents.clear('stage.reserve_down', new Set());
    expect(resolved.map(i => [i.event, i.resolution])).toEqual([['gpu.idle', 'cleared'], ['stage.reserve_down', 'cleared']]);
    incidents.seen(alert('gpu.idle', 'babel-live'), false);
    expect(incidents.list().filter(i => i.event === 'gpu.idle').map(i => [Boolean(i.endedAt), i.alertCount])).toEqual([[false, 1], [true, 1]]);
  });

  it('closes a one-shot alert after the quiet period, never an incident whose checker reports it as still on', () => {
    const { incidents, resolved, advance } = rig(30 * MIN);
    incidents.seen(alert('deployment.create_failed', 'speech-stack-test'), true);
    incidents.seen(alert('gpu.idle', 'babel-live'), true);
    incidents.clear('gpu.idle', new Set(['babel-live']));
    advance(29 * MIN);
    incidents.tick();
    expect(resolved).toEqual([]);
    advance(2 * MIN);
    incidents.tick();
    expect(resolved.map(i => [i.event, i.resolution, i.endedAt])).toEqual([['deployment.create_failed', 'quiet', new Date(T0 + 31 * MIN).toISOString()]]);
  });

  it('records the actions taken on the incidents they touch: park and stuck-boot retry from the controller log, reorder from the promotions', () => {
    const { incidents } = rig();
    incidents.seen(alert('gpu.outside_window', 'speech-stack'), true);
    incidents.seen(alert('deployment.stuck_boot', 'speech-stack-test'), true);
    incidents.seen(alert('fallback.probe_failed', 'tts|openrouter:hexgrad/kokoro-82m|pm_alex', { items: 'tts openrouter:hexgrad/kokoro-82m (pm_alex) [parle-tts]: timeout' }), true);
    incidents.fromDeploymentLog('deployments: parking replica (power off)', { deployment: 'speech-stack', id: 'scw-1' });
    incidents.fromDeploymentLog('deployments: stuck boot, releasing to retry', { deployment: 'speech-stack-test', id: 'r9' });
    incidents.fromDeploymentLog('deployments: replica ready', { deployment: 'speech-stack' });
    const promotion = { chainKey: 'tts|parle-tts', since: T0, leader: 'openrouter:openai/gpt-4o-mini-tts', declared: 'openrouter:hexgrad/kokoro-82m' };
    incidents.tick([promotion]);
    incidents.tick([promotion]);
    incidents.action('park', 'babel-live', 'painel: marcos');
    const byEvent = Object.fromEntries(incidents.list().map(i => [i.event, i.actions.map(a => [a.kind, a.target, a.detail])]));
    expect(byEvent).toEqual({
      'gpu.outside_window': [['park', 'speech-stack', 'réplica scw-1']],
      'deployment.stuck_boot': [['retry', 'speech-stack-test', 'réplica r9']],
      'fallback.probe_failed': [['reorder', 'parle-tts', 'openrouter:openai/gpt-4o-mini-tts antes de openrouter:hexgrad/kokoro-82m']],
    });
  });
});

describe('incidents: persistence', () => {
  it('survives a restart in the state dir: open stays open with a fresh quiet window, closed keeps its timeline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
    dirs.push(dir);
    const path = join(dir, 'incidents.json');
    const first = rig(30 * MIN, path);
    first.incidents.seen(alert('gpu.idle', 'babel-live'), true);
    first.incidents.seen(alert('deployment.create_failed', 'speech-stack-test'), true);
    first.incidents.action('park', 'babel-live', 'painel: marcos');
    first.incidents.clear('gpu.idle', new Set());
    first.incidents.markMailed(first.incidents.list()[0]!.id);
    await first.incidents.flush();
    expect(JSON.parse(readFileSync(path, 'utf8')).incidents).toHaveLength(2);
    const again = rig(30 * MIN, path);
    again.clock.t = T0 + 29 * MIN;
    await again.incidents.load();
    expect(again.incidents.list()).toEqual(first.incidents.list().map(i => (i.endedAt ? i : { ...i, lastSeenAt: new Date(T0 + 29 * MIN).toISOString() })));
    again.advance(29 * MIN);
    again.incidents.tick();
    expect(again.resolved).toEqual([]);
    again.advance(2 * MIN);
    again.incidents.tick();
    expect(again.resolved.map(i => [i.event, i.mailed])).toEqual([['deployment.create_failed', true]]);
  });

  it('keeps the last 200 incidents', () => {
    const { incidents } = rig();
    for (let i = 0; i < INCIDENTS_KEPT + 5; i++) incidents.seen(alert('deployment.create_failed', `d-${i}`), true);
    expect(incidents.list()).toHaveLength(INCIDENTS_KEPT);
    expect(incidents.list()[0]!.key).toBe(`d-${INCIDENTS_KEPT + 4}`);
  });
});

describe('incidents from the ops alerts and their e-mails', () => {
  const gpu = (lastRequestMinutes: number) => ({
    name: 'babel-live', replicas: [{ phase: 'ready', pricePerHour: 0.8, ageSeconds: 3 * 3600 }], lastRequestAt: new Date(T0 - lastRequestMinutes * MIN).toISOString(),
    warm: null, hold: null, spec: { idleMinutes: 15 },
  }) as unknown as DeploymentView;

  it('opens on the first alert, sees every check, and closes when the GPU is used again', async () => {
    const { incidents, resolved, clock } = rig();
    const sent: OpsAlert[] = [];
    const ops = createOpsAlerts(a => { sent.push(a); }, () => clock.t, OPS_ALERT_DEDUP_MS, 0, incidents);
    ops.fromDeployments([gpu(20)]);
    clock.t += 15_000;
    ops.fromDeployments([gpu(20)]);
    await flush();
    expect(sent.map(a => [a.event, a.key])).toEqual([['gpu.idle', 'babel-live']]);
    expect(incidents.list().map(i => [i.event, i.key, i.alertCount, i.endedAt])).toEqual([['gpu.idle', 'babel-live', 1, null]]);
    ops.fromDeployments([gpu(1)]);
    expect(resolved.map(i => [i.event, i.resolution])).toEqual([['gpu.idle', 'cleared']]);
  });

  it('mails when an incident opens and when it is resolved, not for every warn alert in between; urgent ones still remind', () => {
    const open = { mailed: false };
    const warn = { event: 'gpu.idle', data: { deployment: 'babel-live' } };
    const urgent = { event: 'voice.turn_failing', data: { app: 'parle' } };
    expect(opsIncidentMail(warn, open)).toMatchObject({ opens: true, mail: { subject: 'incidente aberto: GPU ligada e sem uso (babel-live)' } });
    expect(opsIncidentMail(warn, open)!.mail.body).toContain('/admin/atividade#incidentes');
    expect(opsIncidentMail(warn, { mailed: true })).toBeNull();
    expect(opsIncidentMail(urgent, { mailed: true })).toMatchObject({ opens: false, mail: { level: 'urgent' } });
    expect(opsIncidentMail({ event: 'unknown.event', data: {} }, open)).toBeNull();
    const mail = incidentResolvedMail({
      event: 'gpu.idle', key: 'babel-live', startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 42 * MIN).toISOString(), alertCount: 3, resolution: 'cleared',
      actions: [{ at: new Date(T0 + 30 * MIN).toISOString(), kind: 'park', target: 'babel-live', detail: 'painel: marcos' }],
    }, 30);
    expect(mail).toMatchObject({ level: 'warn', kind: 'gpu.idle|babel-live|resolved', subject: 'resolvido: GPU ligada e sem uso (babel-live) após 42 min' });
    expect(mail.body).toContain('- alertas: 3');
    expect(mail.body).toContain('park babel-live (painel: marcos)');
    expect(mail.body).toContain('a condição normalizou');
  });
});

describe('incidents on the panel', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  const opts = { now, csrf: 'c', actor: 'marcos', message: null, app: null };
  const section = (html: string, id: string) => html.slice(html.indexOf(`<section id="${id}"`), html.indexOf('</section>', html.indexOf(`<section id="${id}"`)));

  it('lists them on Atividade with duration, alerts, actions and resolution, and the open ones on the overview', () => {
    const s = demoSnapshot(now, 'bad');
    const atividade = section(renderStatus('n', s, { ...opts, page: 'atividade' }), 'incidentes');
    for (const text of ['<h2>Incidentes</h2>', 'aberto', 'resolvido', 'Turnos de voz', 'reordenou a reserva de parle-tts', 'nova tentativa de boot em speech-stack-test',
      'estacionou speech-stack', 'a condição normalizou', 'nenhum alerta novo']) expect(atividade.toLowerCase()).toContain(text.toLowerCase());
    const overview = section(renderStatus('n', s, opts), 'abertos');
    expect(overview).toMatch(/<h2>Incidentes abertos<\/h2><span class="pill bad">/);
    expect(overview).toContain('href="/admin/atividade#incidentes"');
    expect(overview).toContain('Aula: turnos de voz falhando');
    expect(renderStatus('n', demoSnapshot(now, 'ok'), opts)).not.toContain('<section id="abertos"');
    expect(renderStatus('n', demoSnapshot(now, 'ok'), { ...opts, page: 'atividade' })).toContain('<section id="incidentes">');
  });

  it('shows an app key only the incidents about its own app', () => {
    const s = demoSnapshot(now, 'bad');
    const parle = scopeToApp(s, 'parle');
    expect(parle.incidents!.map(i => i.key)).toEqual(s.incidents!.map(i => i.key).filter(k => k !== 'babel-live'));
    expect(scopeToApp(s, 'babelcast').incidents!.map(i => i.key)).toEqual(['babel-live']);
    const html = PAGES.map(p => renderStatus('n', parle, { ...opts, actor: 'parle', view: { id: 'parle', canPark: false }, page: p.id })).join('');
    expect(html).not.toContain('babel-live');
  });
});
