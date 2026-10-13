import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  AppTelemetryError, AppTelemetryStore, classSessions, createAppTelemetry, parseBatch, turnStats, VOICE_TURN_ALERT, type VoiceTurn,
} from '../../../src/app-telemetry';
import { createOpsAlerts, type OpsAlert } from '../../../src/telemetry/ops-alerts';
import { opsAlertMail } from '../../../src/telemetry/alert-email';
import { scopeToApp } from '../../../src/admin-page';
import { renderStatus } from '../../../src/admin-page/pages';
import { demoSnapshot } from '../../__fixtures__/admin-snapshot';

const NOW = Date.parse('2026-10-13T16:30:00Z');
const INSTALL = '3f2b8c1e-9d4a-4e6b-8f00-1a2b3c4d5e6f';
const turn = (extra: Record<string, unknown> = {}) => ({
  ok: true, requestId: 'req-7f3a9c', ms: { stt: 310, probe: 40, llm: 420, tts: 380, total: 1150 }, degraded: [], stage: '360', classWindow: true, ...extra,
});
const batch = (fields: Record<string, unknown>) => ({ installId: INSTALL, appVersion: '1.0.0', os: 'linux', events: [{ ts: NOW, kind: 'voice.turn', fields }] });
const refusal = (fields: Record<string, unknown>) => {
  try { parseBatch(batch(fields), NOW); return null; } catch (err) { return err instanceof AppTelemetryError ? err.message : String(err); }
};
const vt = (at: number, extra: Partial<VoiceTurn> = {}): VoiceTurn => ({
  at, app: 'parle', ok: true, failedStage: null, reason: null, requestId: `r${at}`, totalMs: 1000, degraded: [], stage: '360', classWindow: true, ...extra,
});
const failed = (at: number, stage = 'tts', reason = 'timeout', extra: Partial<VoiceTurn> = {}) => vt(at, { ok: false, failedStage: stage, reason, totalMs: null, ...extra });

describe('voice.turn validation', () => {
  it('accepts the technical fields parle sends, failed or not', () => {
    expect(refusal(turn())).toBeNull();
    expect(refusal(turn({ ok: false, failedStage: 'tts', reason: 'upstream_502', degraded: ['tts'], stage: 'fast', classWindow: false, ms: { stt: 300, total: null } }))).toBeNull();
    expect(parseBatch(batch(turn()), NOW).events[0]!.kind).toBe('voice.turn');
  });

  it('refuses any transcript, text or student field instead of dropping it, and free text in reason', () => {
    for (const field of [{ transcript: 'bom dia' }, { text: 'um pão' }, { studentId: 's-12' }, { student: { name: 'Ana' } }, { email: 'a@b.c' }, { lessonNote: 'x' }]) {
      expect(refusal(turn(field))).toMatch(/is not accepted: a voice\.turn carries only/);
    }
    expect(refusal(turn({ ok: false, failedStage: 'tts', reason: 'O aluno disse bom dia e o TTS travou' }))).toMatch(/reason must be a short code/);
    expect(refusal(turn({ reason: 'x'.repeat(49) }))).toMatch(/reason must be a short code/);
    expect(refusal(turn({ degraded: ['tts falhou porque o aluno falou baixo'] }))).toMatch(/degraded/);
    expect(refusal(turn({ ms: { total: 900, words: 12 } }))).toMatch(/ms must hold only/);
  });

  it('refuses a malformed turn', () => {
    expect(refusal(turn({ ok: 'yes' }))).toMatch(/ok must be a boolean/);
    expect(refusal(turn({ failedStage: 'gpu' }))).toMatch(/failedStage/);
    expect(refusal(turn({ requestId: undefined }))).toMatch(/requestId/);
    expect(refusal(turn({ requestId: 'has spaces in it' }))).toMatch(/requestId/);
    expect(refusal(turn({ stage: '3d' }))).toMatch(/stage must be/);
    expect(refusal(turn({ classWindow: 1 }))).toMatch(/classWindow/);
    expect(refusal(turn({ ms: { total: -5 } }))).toMatch(/ms must hold only/);
  });
});

describe('voice.turn ingest', () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise(r => s.close(r));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function gateway(dir: string) {
    const tel = createAppTelemetry({
      env: {}, store: new AppTelemetryStore({ dir, retentionDays: 365 }), userOf: (req) => (req.headers.authorization === 'Bearer k-parle' ? 'parle' : 'babelcast'),
      isAdminToken: () => false, now: () => NOW, sweepIntervalMs: 0,
    });
    await tel.start();
    const server = createServer((req, res) => void tel.routes.find(r => r.method === req.method && r.path === req.url)!.handler(req, res));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const post = (body: unknown, key = 'k-parle') => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/telemetry/app/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { tel, post };
  }

  it('stores accepted turns with the app of the key, keeps them for the panel across a restart, and stores nothing of a refused batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-turn-'));
    dirs.push(dir);
    const first = await gateway(dir);
    expect((await first.post(batch(turn({ ok: false, failedStage: 'stt', reason: 'empty_audio' })))).status).toBe(200);
    expect((await first.post(batch(turn()), 'k-babel')).status).toBe(200);
    const refused = await first.post(batch(turn({ transcript: 'bom dia' })));
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain('bom dia');
    expect(first.tel.voiceTurns().map(t => [t.app, t.ok, t.failedStage, t.reason, t.totalMs])).toEqual([['parle', false, 'stt', 'empty_audio', 1150], ['babelcast', true, null, null, 1150]]);
    const again = await gateway(dir);
    expect(again.tel.voiceTurns()).toEqual(first.tel.voiceTurns());
    expect((await again.tel.store.read(0, NOW)).some(r => JSON.stringify(r).includes('bom dia'))).toBe(false);
  });
});

describe('voice.turn aggregation', () => {
  it('counts turns, ok share, p50/p95 of the total, failures by stage and reason, degraded stages', () => {
    const turns = [
      ...Array.from({ length: 18 }, (_, i) => vt(NOW - i * 1000, { totalMs: 900 + i * 50, degraded: i < 3 ? ['tts'] : [] })),
      failed(NOW - 30_000), failed(NOW - 31_000), failed(NOW - 32_000, 'stt', 'empty_audio'),
    ];
    const s = turnStats(turns);
    expect(s).toMatchObject({ turns: 21, failed: 3, p50Ms: 1300, p95Ms: 1750 });
    expect(s.okShare).toBeCloseTo(18 / 21, 6);
    expect(s.failures).toEqual([{ stage: 'tts', reason: 'timeout', count: 2 }, { stage: 'stt', reason: 'empty_audio', count: 1 }]);
    expect(s.degraded).toEqual([{ stage: 'tts', count: 3 }]);
    expect(turnStats([])).toMatchObject({ turns: 0, okShare: null, p50Ms: null, p95Ms: null });
  });

  it('splits class sessions on a 45 min gap and ignores turns outside a class window', () => {
    const h = 3_600_000;
    const sessions = classSessions([vt(NOW - 25.5 * h), vt(NOW - 26 * h), vt(NOW - 2 * h), vt(NOW - h - 14 * 60_000), vt(NOW, { classWindow: false })]);
    expect(sessions.map(s => [s.turns.length, s.startedAt, s.endedAt])).toEqual([[2, NOW - 26 * h, NOW - 25.5 * h], [1, NOW - 2 * h, NOW - 2 * h], [1, NOW - h - 14 * 60_000, NOW - h - 14 * 60_000]]);
  });
});

describe('voice.turn class alert', () => {
  const flush = () => new Promise(r => setTimeout(r, 0));
  const rig = () => {
    const sent: OpsAlert[] = [];
    return { sent, alerts: createOpsAlerts(a => { sent.push(a); }, () => NOW) };
  };
  const minute = 60_000;
  const window = (n: number, fails: number, extra: Partial<VoiceTurn> = {}) =>
    Array.from({ length: n }, (_, i) => (i < fails ? failed(NOW - i * 20_000, 'tts', 'timeout', extra) : vt(NOW - i * 20_000, extra)));

  it('fires an urgent alert at 10 % failures over at least 20 turns in 10 min, not below', async () => {
    const { sent, alerts } = rig();
    alerts.fromVoiceTurns(window(20, 1));
    alerts.fromVoiceTurns(window(19, 10));
    await flush();
    expect(sent).toEqual([]);
    alerts.fromVoiceTurns(window(20, 2));
    alerts.fromVoiceTurns(window(30, 9));
    await flush();
    expect(sent.map(a => [a.event, a.data.app, a.data.turns, a.data.failed])).toEqual([['voice.turn_failing', 'parle', 20, 2]]);
    expect(sent[0]!.data.failures).toBe('tts/timeout x2');
    const mail = opsAlertMail(sent[0]!)!;
    expect(mail.level).toBe('urgent');
    expect(mail.subject).toContain('(parle)');
  });

  it('fires when p95 passes 4 s, and only for turns in a class window within the last 10 min', async () => {
    const { sent, alerts } = rig();
    alerts.fromVoiceTurns(window(20, 0, { totalMs: VOICE_TURN_ALERT.p95Ms + 100, classWindow: false }));
    alerts.fromVoiceTurns(window(20, 0, { totalMs: VOICE_TURN_ALERT.p95Ms }));
    alerts.fromVoiceTurns(Array.from({ length: 25 }, (_, i) => failed(NOW - 11 * minute - i * 1000)));
    await flush();
    expect(sent).toEqual([]);
    alerts.fromVoiceTurns(window(20, 0, { totalMs: VOICE_TURN_ALERT.p95Ms + 100 }));
    alerts.fromVoiceTurns([...window(20, 0, { totalMs: 900, app: 'babelcast' }), ...window(20, 4, { app: 'babelcast' })]);
    await flush();
    expect(sent.map(a => [a.event, a.data.app])).toEqual([['voice.turn_slow', 'parle'], ['voice.turn_failing', 'babelcast']]);
    expect(opsAlertMail(sent[0]!)!.level).toBe('urgent');
  });
});

describe('class card on the overview', () => {
  const opts = { now: Date.parse('2026-10-13T10:00:00Z'), csrf: 'c', actor: 'marcos', message: null, app: null };
  const section = (html: string) => html.slice(html.indexOf('<section id="aula"'), html.indexOf('</section>', html.indexOf('<section id="aula"')));

  it('shows a class in progress: turns in 10 min and since the start, ok share, p50/p95 against 1,5 s and 2 s, failures and their request ids', () => {
    const s = demoSnapshot(opts.now, 'bad');
    const html = renderStatus('n', s, opts);
    const card = section(html);
    expect(card).toMatch(/<h2>Aula em curso<\/h2><span class="pill bad">/);
    expect(card).toContain('nenhuma GPU na janela de aula');
    for (const text of ['Turnos em 10 min', 'desde 11:12', 'Turnos ok', 'meta 1,5 s · teto 2 s', 'Etapas degradadas', 'Falhas por etapa e motivo', 'Últimas falhas', 'upstream_502']) {
      expect(card).toContain(text);
    }
    const lastFail = s.voiceTurns!.filter(t => !t.ok).sort((a, b) => b.at - a.at)[0]!;
    expect(card).toContain(`<code class="rid">${lastFail.requestId}</code>`);
    expect(html).toContain('Algo está fora do ar');
    expect(section(renderStatus('n', demoSnapshot(opts.now, 'warn'), opts))).toMatch(/<h2>Aula em curso<\/h2><span class="pill warn">/);
  });

  it('after class shows «Última aula» as information, never as an alarm', () => {
    const s = demoSnapshot(opts.now, 'ok');
    s.voiceTurns = [...s.voiceTurns!, ...Array.from({ length: 160 }, (_, i) => failed(opts.now - 70 * 60_000 - i * 1000))];
    const html = renderStatus('n', s, opts);
    expect(section(html)).toMatch(/<h2>Última aula<\/h2><span class="pill bad">/);
    expect(html).toContain('Tudo funcionando');
  });

  it('shows an app key only the turns of its own app', () => {
    const s = demoSnapshot(opts.now, 'warn');
    s.voiceTurns = [...s.voiceTurns!, failed(opts.now - 60_000, 'llm', 'babel_secret_reason', { app: 'babelcast', requestId: 'babel-req-1' })];
    expect(scopeToApp(s, 'parle').voiceTurns!.every(t => t.app === 'parle')).toBe(true);
    expect(scopeToApp(s, 'babelcast').voiceTurns!.map(t => t.requestId)).toEqual(['babel-req-1']);
    const parle = renderStatus('n', scopeToApp(s, 'parle'), { ...opts, actor: 'parle', view: { id: 'parle', canPark: false } });
    expect(parle).not.toContain('babel-req-1');
    expect(parle).toContain('Aula em curso');
    expect(renderStatus('n', s, { ...opts, app: 'parle' })).not.toContain('babel-req-1');
    expect(renderStatus('n', s, opts)).toContain('babel-req-1');
  });

  it('keeps the plain class strip when app telemetry is off', () => {
    const html = renderStatus('n', { ...demoSnapshot(opts.now, 'warn'), voiceTurns: null }, opts);
    expect(html).not.toContain('<section id="aula"');
  });
});
