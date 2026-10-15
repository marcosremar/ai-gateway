import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSuggestionDigest, digestMail, highImpact, DIGEST_BOOT_QUIET_MS, DIGEST_IMMEDIATE_GAP_MS } from '../../src/admin-page/digest';
import { possibleSaving, recommendations, type Recommendation } from '../../src/admin-page/recommendations';
import { warmWindowRules, linkReorderRules } from '../../src/admin-page/savings-rules';
import { scopeToApp } from '../../src/admin-page';
import type { AlertMail } from '../../src/telemetry/alert-email';
import { EUR_TO_USD } from '../../src/deployments/vast-backend';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const reco = (id: string, extra: Partial<Recommendation> = {}): Recommendation => ({
  id, level: 'ok', title: `título ${id}`, saw: 'visto', why: 'porque', impact: null, action: { text: `faça ${id}` }, ...extra,
});
const saving = (eur: number) => ({ saving: { perMonth: eur, unit: '€' as const }, impact: { amount: eur, unit: '€' as const, text: `~${eur}/mês` } });

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

function harness(list: Recommendation[], start = NOW, classOpen = false) {
  const clock = { now: start };
  const mails: AlertMail[] = [];
  const state = { list, classOpen, fail: false };
  const make = (path?: string) => createSuggestionDigest({
    list: () => state.list, classOpen: () => state.classOpen, baseUrl: 'https://gw.test', now: () => clock.now, ...(path ? { path } : {}),
    deliver: async (mail) => { if (state.fail) return null; mails.push(mail); return `m${mails.length}`; },
  });
  return { clock, mails, state, make };
}

describe('suggestion digest mail', () => {
  it('ranks high impact first, marks what is new, says what each saves or improves, the action and the panel link', () => {
    const list = [
      reco('idle-tail:a', saving(4)),
      reco('app-slo:parle', { level: 'bad', gain: 'menos turnos sem resposta', action: { go: '/admin/servicos?app=parle#trafego', label: 'Ver o tráfego do app' } }),
      reco('warm-end:speech-stack:20:30', saving(12)),
    ];
    const mail = digestMail(list, { now: NOW, baseUrl: 'https://gw.test', sent: { 'idle-tail:a': NOW - 86_400_000 }, kind: 'weekly' });
    expect(mail.kind).toBe('digest|weekly');
    expect(mail.subject).toMatch(/^resumo das sugestões: 3 abertas, economia possível/);
    const order = ['app-slo:parle', 'warm-end:speech-stack:20:30', 'idle-tail:a'].map(id => mail.body.indexOf(`título ${id}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(mail.body).toContain('1. [NOVA] título app-slo:parle');
    expect(mail.body).toContain('. título idle-tail:a');
    expect(mail.body).toContain('Melhora: menos turnos sem resposta');
    expect(mail.body).toMatch(/Economiza ~€\s12,00\/mês/);
    expect(mail.body).toContain('O que fazer: Ver o tráfego do app');
    expect(mail.body).toContain('Ver: https://gw.test/admin/servicos?app=parle#trafego');
    expect(mail.body).toContain('Ver: https://gw.test/admin/gpus');
    expect(mail.body).toContain('2 novas desde o último resumo');
    expect(mail.body).toMatch(/Economia possível este mês: €/);
  });

  it('counts as high impact ≥ €10/month or a service risk that no other alert already mails', () => {
    expect(highImpact(reco('warm-end:x', saving(10)))).toBe(true);
    expect(highImpact(reco('warm-end:x', saving(9.99)))).toBe(false);
    expect(highImpact(reco('app-slo:parle', { level: 'bad' }))).toBe(true);
    expect(highImpact(reco('reserve-failed:tts:x', { level: 'bad' }))).toBe(false);
    expect(highImpact(reco('balance-low:vast', { level: 'bad' }))).toBe(false);
  });

  it('totals the possible saving of the month, prorated to the days left, and the €/h burning now', () => {
    const list = [reco('warm-end:a', saving(31)), reco('gpu-idle:b', { impact: { amount: 0.79, unit: '€', text: '€/h' } }), reco('idle-tail:c', { saving: { perMonth: 11, unit: 'US$' } })];
    const t = possibleSaving(list, Date.parse('2026-10-31T10:00:00Z'));
    expect(t.monthEur).toBeCloseTo(31 + 11 / EUR_TO_USD, 6);
    expect(t.restOfMonthEur).toBeCloseTo(t.monthEur / 31, 6);
    expect(t.nowEurPerHour).toBe(0.79);
  });
});

describe('suggestion digest schedule', () => {
  const monday8 = Date.parse('2026-10-19T06:00:00Z');

  it('sends nothing during the quiet minutes after boot, then once for a new high-impact suggestion, never twice for it', async () => {
    const h = harness([reco('warm-end:a', saving(20)), reco('idle-tail:b', saving(2))]);
    const d = h.make();
    expect(await d.tick()).toBeNull();
    h.clock.now += DIGEST_BOOT_QUIET_MS;
    expect(await d.tick()).toBe('m1');
    expect(h.mails[0]!.subject).toBe('nova sugestão: título warm-end:a');
    h.clock.now += DIGEST_IMMEDIATE_GAP_MS * 3;
    expect(await d.tick()).toBeNull();
    h.state.list = [...h.state.list, reco('idle-tail:c', saving(3))];
    expect(await d.tick()).toBeNull();
    h.state.list = [...h.state.list, reco('app-slo:parle', { level: 'bad' })];
    expect(await d.tick()).toBe('m2');
    expect(h.mails[1]!.body).toContain('[NOVA] título app-slo:parle');
    expect(h.mails[1]!.body).toContain('[NOVA] título idle-tail:c');
    expect(h.mails[1]!.body).not.toContain('[NOVA] título warm-end:a');
    expect(d.status()).toMatchObject({ enabled: true, lastKind: 'immediate' });
  });

  it('waits an hour between two immediate mails and retries a failed delivery', async () => {
    const h = harness([reco('warm-end:a', saving(20))], NOW + DIGEST_BOOT_QUIET_MS);
    const d = h.make();
    h.clock.now += DIGEST_BOOT_QUIET_MS;
    h.state.fail = true;
    expect(await d.tick()).toBeNull();
    h.state.fail = false;
    expect(await d.tick()).toBe('m1');
    h.state.list = [...h.state.list, reco('warm-end:b', saving(30))];
    expect(await d.tick()).toBeNull();
    h.clock.now += DIGEST_IMMEDIATE_GAP_MS;
    expect(await d.tick()).toBe('m2');
  });

  it('sends the weekly digest on Monday from 8:00 Paris, once, never while a class window is open, on Paris time after the winter switch', async () => {
    const h = harness([reco('idle-tail:b', saving(2))], monday8 - DIGEST_BOOT_QUIET_MS - 60_000);
    const d = h.make();
    h.clock.now = monday8 - 60_000;
    expect(await d.tick()).toBeNull();
    h.clock.now = monday8;
    h.state.classOpen = true;
    expect(await d.tick()).toBeNull();
    h.state.classOpen = false;
    expect(await d.tick()).toBe('m1');
    expect(h.mails[0]!.kind).toBe('digest|weekly');
    h.clock.now = monday8 + 3 * 3_600_000;
    expect(await d.tick()).toBeNull();
    h.clock.now = monday8 + 86_400_000;
    expect(await d.tick()).toBeNull();
    h.clock.now = monday8 + 7 * 86_400_000;
    expect(await d.tick()).toBeNull();
    h.clock.now = monday8 + 7 * 86_400_000 + 3_600_000;
    expect(await d.tick()).toBe('m2');
  });

  it('follows Paris time across the winter switch: 8:00 is 07:00 UTC in November', async () => {
    const winterMonday8 = Date.parse('2026-11-02T07:00:00Z');
    const h = harness([reco('idle-tail:b', saving(2))], winterMonday8 - DIGEST_BOOT_QUIET_MS - 3_600_000);
    const d = h.make();
    h.clock.now = winterMonday8 - 60_000;
    expect(await d.tick()).toBeNull();
    h.clock.now = winterMonday8;
    expect(await d.tick()).toBe('m1');
  });

  it('keeps what it sent across a restart, so nothing is mailed twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digest-'));
    dirs.push(dir);
    const path = join(dir, 'suggestion-digest.json');
    const h = harness([reco('warm-end:a', saving(20))]);
    const first = h.make(path);
    h.clock.now += DIGEST_BOOT_QUIET_MS;
    expect(await first.tick()).toBe('m1');
    const again = h.make(path);
    await again.load();
    h.clock.now += DIGEST_BOOT_QUIET_MS + DIGEST_IMMEDIATE_GAP_MS;
    expect(await again.tick()).toBeNull();
    expect(again.status().lastSentAt).not.toBeNull();
    expect(await again.sendNow()).toBe('m2');
    expect(again.status().lastKind).toBe('manual');
  });

  it('is off without the alert mailer', async () => {
    const d = createSuggestionDigest({ list: () => [reco('warm-end:a', saving(20))], deliver: null, classOpen: () => false, baseUrl: '', now: () => NOW + DIGEST_BOOT_QUIET_MS });
    expect(await d.tick()).toBeNull();
    expect(d.status().enabled).toBe(false);
  });
});

describe('saving and service-quality suggestions', () => {
  const ctx = (s = demoSnapshot(NOW, 'warn')) => ({ s, now: NOW, csrf: '', app: null, view: null });

  it('fits the warm window to the observed class use: later end saves money, a late start costs the first minutes', () => {
    const rules = warmWindowRules(ctx());
    const end = rules.find(r => r.id === 'warm-end:speech-stack:20:30')!;
    expect(end.saving!.perMonth).toBeCloseTo((30 / 60) * 0.79 * 4 * 4.35, 6);
    expect(end.action).toEqual({ text: 'PATCH /v1/deployments/speech-stack warmSchedule: fim 20:00 em vez de 20:30' });
    const late = rules.find(r => r.id === 'warm-late:speech-stack:17:30')!;
    expect(late.gain).toMatch(/GPU pronta antes do primeiro pedido/);
    expect(late.action).toEqual({ text: 'PATCH /v1/deployments/speech-stack warmSchedule: início 17:20 em vez de 17:30' });
    const s = demoSnapshot(NOW, 'warn');
    s.traffic!.daily!.parle = s.traffic!.daily!.parle!.slice(0, 2);
    expect(warmWindowRules(ctx(s))).toEqual([]);
  });

  it('suggests moving a flaky or slow cloud link below a steady one, only with enough tries', () => {
    const s = demoSnapshot(NOW, 'warn');
    s.chains!.chat!['parle-chat'] = { serving: 'openrouter:a', onFallback: false, links: [{ target: 'openrouter:a', state: 'ready' }, { target: 'openrouter:b', state: 'ready' }] };
    const line = (key: string, served: number, fallbacks: number, p95Ms: number) => ({ key, served, failed: 0, fallbacks, p50Ms: p95Ms / 2, p95Ms });
    s.traffic!.byApp!.parle!.links = [line('chat|openrouter:a', 60, 30, 900), line('chat|openrouter:b', 40, 0, 800)];
    const flaky = linkReorderRules(ctx(s));
    expect(flaky.map(r => r.id)).toEqual(['link-reorder:chat:parle-chat']);
    expect(flaky[0]!.gain).toBe('~30 desvios a menos por dia');
    s.traffic!.byApp!.parle!.links = [line('chat|openrouter:a', 60, 0, 3000), line('chat|openrouter:b', 40, 0, 900)];
    expect(linkReorderRules(ctx(s))[0]!.gain).toMatch(/p95 3,00 s → 900 ms/);
    s.traffic!.byApp!.parle!.links = [line('chat|openrouter:a', 10, 5, 3000), line('chat|openrouter:b', 40, 0, 900)];
    expect(linkReorderRules(ctx(s))).toEqual([]);
  });

  it('gives an app session only its own suggestions and no digest', () => {
    const scoped = scopeToApp(demoSnapshot(NOW, 'warn'), 'babelcast');
    expect(scoped.digest).toBeNull();
    const ids = recommendations({ s: scoped, now: NOW, csrf: '', app: null, view: { id: 'babelcast', canPark: false } }).map(r => r.id);
    expect(ids.some(id => id.includes('speech-stack'))).toBe(false);
  });
});
