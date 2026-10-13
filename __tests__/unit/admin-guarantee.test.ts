import { describe, expect, it } from 'vitest';
import { scopeToApp, type AdminSnapshot } from '../../src/admin-page';
import { PAGES, renderStatus } from '../../src/admin-page/pages';
import { services } from '../../src/admin-page/guarantee';
import { idleGpu } from '../../src/deployments/idle';
import { createOpsAlerts, type OpsAlert } from '../../src/telemetry/ops-alerts';
import type { DeploymentView } from '../../src/deployments/types';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const render = (s: AdminSnapshot, view: { id: string; canPark: boolean } | null = null, app: string | null = null) =>
  PAGES.map(p => renderStatus('n', s, { now: NOW, csrf: 'c', actor: view?.id ?? 'marcos', message: null, app, view, page: p.id })).join('');
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', minReplicas: 1, timeZone: 'Europe/Paris' }];
const section = (html: string, id: string) => html.slice(html.indexOf(`<section id="${id}"`), html.indexOf('</section>', html.indexOf(`<section id="${id}"`)));

const gpu = (extra: Partial<DeploymentView>, spec: Record<string, unknown> = {}) => ({
  name: 'g', replicas: [{ phase: 'ready', pricePerHour: 0.8, ageSeconds: 3 * 3600 }], lastRequestAt: null, warm: null, hold: null,
  spec: { idleMinutes: 20, ...spec }, ...extra,
}) as unknown as DeploymentView;

describe('GPU on but idle', () => {
  it('alerts only after the deployment idleMinutes (15 by default) and never inside a class window', () => {
    expect(idleGpu(gpu({ lastRequestAt: iso(19) }), NOW)).toBeNull();
    expect(idleGpu(gpu({ lastRequestAt: iso(21) }), NOW)).toMatchObject({ limitMinutes: 20, eurPerHour: 0.8 });
    expect(idleGpu(gpu({ lastRequestAt: iso(16) }, { idleMinutes: undefined }), NOW)?.limitMinutes).toBe(15);
    expect(idleGpu(gpu({ lastRequestAt: iso(60) }), NOW)?.wastedEur).toBeCloseTo(0.8, 6);
    const always = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', minReplicas: 1, timeZone: 'Europe/Paris' }];
    expect(idleGpu(gpu({ lastRequestAt: iso(60) }, { warmSchedule: always }), NOW)).toBeNull();
    expect(idleGpu(gpu({ lastRequestAt: iso(60), warm: { replicas: 1, until: iso(-30) } }), NOW)).toBeNull();
    expect(idleGpu(gpu({ replicas: [] }), NOW)).toBeNull();
  });

  it('turns the GPUs section to Atenção with the money wasted, lists it in the overview card and keeps Estacionar', () => {
    const html = render(demoSnapshot(NOW, 'warn'));
    const gpus = section(html, 'gpus');
    expect(gpus).toMatch(/<h2>GPUs<\/h2><span class="pill warn">/);
    expect(gpus).toMatch(/sem uso há 40 min · €\s0,53 gastos · €\s0,79\/h/);
    expect(/<a class="card warn" href="\/admin\/gpus"[^]*?<\/a>/.exec(html)![0]).toMatch(/babel-live ligada sem uso há 40 min: €\s0,53 gastos, €\s0,79\/h/);
    expect(gpus).toContain('name="name" value="babel-live"');
    expect(section(html, 'alertas')).toContain('gpu.idle');
    const ok = section(render(demoSnapshot(NOW, 'ok')), 'gpus');
    expect(ok).toMatch(/<h2>GPUs<\/h2><span class="meta">/);
    expect(ok).toMatch(/aquecida para a aula até \d\d:\d\d/);
  });

  it('raises a gpu.idle ops alert from the controller views', () => {
    const sent: OpsAlert[] = [];
    const alerts = createOpsAlerts(a => sent.push(a), () => NOW);
    alerts.fromDeployments([{ ...gpu({ lastRequestAt: iso(45) }), name: 'speech-stack' }]);
    alerts.fromDeployments([{ ...gpu({ lastRequestAt: iso(5) }), name: 'quiet' }]);
    return Promise.resolve().then(() => {
      expect(sent.map(a => [a.event, a.data.deployment])).toEqual([['gpu.idle', 'speech-stack']]);
      expect(sent[0]!.data).toMatchObject({ minutes: 45, eurPerHour: 0.8, wastedEur: 0.6 });
    });
  });
});

describe('service guarantee', () => {
  it('lists each app service with its chain in the order the gateway tries it, and marks who serves now', () => {
    const list = services(demoSnapshot(NOW, 'warn'));
    const tts = list.find(x => x.alias === 'parle-tts')!;
    expect(tts.links.map(l => [l.target, l.kind])).toEqual([['deployment:speech-stack', 'own-gpu'], ['openrouter:hexgrad/kokoro-82m', 'cloud']]);
    expect(tts.links.map(l => l.serving)).toEqual([true, false]);
    expect(tts.links[1]!.probe?.ok).toBe(true);
    expect(list.map(x => `${x.app}/${x.stage}/${x.alias}`).sort()).toEqual(['babelcast/chat/babel-chat', 'babelcast/tts/babel-tts', 'parle/chat/parle-chat', 'parle/stt/parle-stt', 'parle/tts/parle-tts']);
    const html = section(render(demoSnapshot(NOW, 'warn')), 'garantia');
    const block = html.slice(html.indexOf('<code>parle-tts</code>'));
    expect(block.indexOf('speech-stack')).toBeLessThan(block.indexOf('openrouter:hexgrad/kokoro-82m'));
    expect(html).toContain('atende agora');
  });

  it('gives the three verdicts', () => {
    const s = demoSnapshot(NOW, 'warn');
    expect(services(s).find(x => x.alias === 'parle-tts')).toMatchObject({ verdict: 'garantido', level: 'ok' });

    const parked = demoSnapshot(NOW, 'warn');
    parked.chains!.stt!['parle-stt'] = { serving: 'openrouter:openai/whisper-large-v3', onFallback: true, links: [
      { target: 'deployment:speech-stack', state: 'cold' }, { target: 'openrouter:openai/whisper-large-v3', state: 'ready' },
    ] };
    const cloudOnly = services(parked, null, NOW).find(x => x.alias === 'parle-stt')!;
    expect(cloudOnly).toMatchObject({ verdict: 'so-nuvem', level: 'ok' });
    expect(cloudOnly.links.map(l => l.serving)).toEqual([false, true]);
    expect(section(render(parked), 'garantia')).toContain('Só nuvem · esperado fora da aula');
    expect(section(render(parked), 'garantia')).not.toContain('precisa da GPU: na nuvem ele funciona degradado');

    parked.gpus = parked.gpus!.map(d => (d.name === 'speech-stack' ? { ...d, spec: { ...d.spec, warmSchedule: ALWAYS } } : d));
    expect(services(parked, null, NOW).find(x => x.alias === 'parle-stt')).toMatchObject({ verdict: 'so-nuvem', level: 'warn' });
    expect(section(render(parked), 'garantia')).toContain('precisa da GPU: na nuvem ele funciona degradado');

    const down = services(demoSnapshot(NOW, 'bad'), null, NOW).find(x => x.alias === 'parle-tts')!;
    expect(down).toMatchObject({ verdict: 'sem-garantia', level: 'bad' });
    expect(down.links.map(l => l.state)).toEqual(['falhou', 'falhou no teste']);
    const html = render(demoSnapshot(NOW, 'bad'));
    expect(section(html, 'garantia')).toMatch(/<h2>Garantia do serviço<\/h2><span class="pill bad">/);
    expect(/<a class="card bad" href="\/admin\/servicos"[^]*?<\/a>/.exec(html)![0]).toContain('Parle Texto → fala: sem garantia');
  });

  it('links each app row to its guarantee on the services page, before the reserves and the traffic', () => {
    const html = renderStatus('n', demoSnapshot(NOW, 'warn'), { now: NOW, csrf: 'c', actor: 'marcos', message: null, app: null, page: 'servicos' });
    expect(html.indexOf('id="apps"')).toBeLessThan(html.indexOf('id="garantia"'));
    expect(html.indexOf('id="garantia"')).toBeLessThan(html.indexOf('id="trafego"'));
    expect(section(html, 'apps')).toContain('href="#garantia-parle"');
    expect(html).toContain('id="garantia-parle"');
  });

  it('shows an app session and the ?app= filter only that app\'s chains', () => {
    const scoped = scopeToApp(demoSnapshot(NOW, 'bad'), 'parle');
    expect(Object.values(scoped.chains!).flatMap(Object.keys).sort()).toEqual(['parle-chat', 'parle-stt', 'parle-tts']);
    const html = section(render(scoped, { id: 'parle', canPark: false }), 'garantia');
    expect(html).not.toMatch(/babel|gpt-4o-mini-tts/i);
    expect(html).toContain('parcela de tráfego não medida por app');
    const filtered = section(render(demoSnapshot(NOW, 'warn'), null, 'babelcast'), 'garantia');
    expect(filtered).toContain('babel-tts');
    expect(filtered).not.toContain('parle-stt');
  });
});
