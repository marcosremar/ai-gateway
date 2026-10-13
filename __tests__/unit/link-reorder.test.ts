import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkStats, orderTargets, recordLinkOutcome, reorderSnapshot, resetLinkReorder, REORDER } from '../../src/gateway/proxy/link-reorder';
import { runTargets, selectTargets } from '../../src/gateway/proxy/provider-routing';
import { CircuitBreakerRegistry } from '../../src/gateway/providers/cloud/circuit-breaker';
import { buildServeProviders, equivalenceGroup, type RouteEntrySpec } from '../../src/config/serve-providers';
import { setGatewayTelemetrySink } from '../../src/telemetry/emit';
import type { TelemetryEvent } from '../../src/telemetry/contract';
import { parseAppProfile } from '../../src/deployments/apps';
import { renderStatus } from '../../src/admin-page/pages';
import { demoSnapshot } from '../__fixtures__/admin-snapshot';

const T0 = Date.parse('2026-10-13T10:00:00Z');
const MIN = 60_000;
const link = (providerId: string, model: string, group?: string) => ({ providerId, model, provider: { isConfigured: () => true }, ...(group ? { group, chainKey: 'chat|x-chat' } : {}) });
const feed = (stage: string, t: { providerId: string; model: string }, n: number, ms: number, ok = true, at = T0) => {
  for (let i = 0; i < n; i++) recordLinkOutcome(stage, t, ms, ok, at);
};
const names = (ts: Array<{ providerId: string; model: string }>) => ts.map(t => `${t.providerId}:${t.model}`);

const events: TelemetryEvent[] = [];
beforeEach(() => { resetLinkReorder(); events.length = 0; setGatewayTelemetrySink(e => events.push(e)); });
afterEach(() => { setGatewayTelemetrySink(null); resetLinkReorder(); });

describe('link reorder: promotion and demotion', () => {
  const gpu = link('deployment:speech', 'qwen');
  const a = link('openrouter', 'gemini', 'model:gemini');
  const other = link('zai', 'glm', 'model:glm');
  const b = link('google', 'gemini', 'model:gemini');
  const chain = [gpu, a, other, b];

  it('keeps the declared order without enough samples, then promotes a faster equivalent over a slow one', () => {
    feed('chat', a, REORDER.minSamples - 1, 3_400);
    feed('chat', b, REORDER.minSamples, 1_200);
    expect(names(orderTargets('chat', chain, T0))).toEqual(names(chain));
    feed('chat', a, 1, 3_400);
    const out = orderTargets('chat', chain, T0);
    expect(names(out)).toEqual(['deployment:speech:qwen', 'google:gemini', 'zai:glm', 'openrouter:gemini']);
    expect(reorderSnapshot()).toEqual([expect.objectContaining({ leader: 'google:gemini', declared: 'openrouter:gemini', reason: 'promovida: p95 1,2 s vs 3,4 s' })]);
    expect(events.map(e => [e.event, e.attrs?.alias, e.attrs?.reason])).toEqual([['route.reorder', 'x-chat', 'promovida: p95 1,2 s vs 3,4 s']]);
  });

  it('promotes on failures, never a link that is itself failing, and not for a small difference', () => {
    feed('chat', a, 16, 900);
    feed('chat', a, 4, 900, false);
    feed('chat', b, 20, 1_100);
    expect(reorderSnapshot()).toEqual([]);
    expect(names(orderTargets('chat', chain, T0))[1]).toBe('google:gemini');
    resetLinkReorder();
    feed('chat', a, 20, 3_000);
    feed('chat', b, 18, 1_000);
    feed('chat', b, 2, 1_000, false);
    expect(names(orderTargets('chat', chain, T0))[1]).toBe('openrouter:gemini');
    resetLinkReorder();
    feed('chat', a, 20, 1_400);
    feed('chat', b, 20, 1_000);
    expect(names(orderTargets('chat', chain, T0))[1]).toBe('openrouter:gemini');
  });

  it('holds a promotion for the minimum dwell, reverts only when the first is healthy again (hysteresis), or after 30 min', () => {
    feed('chat', a, 20, 3_400);
    feed('chat', b, 20, 1_200);
    orderTargets('chat', chain, T0);
    feed('chat', a, 30, 1_000, true, T0 + MIN);
    expect(names(orderTargets('chat', chain, T0 + 2 * MIN))[1]).toBe('google:gemini');
    resetLinkReorder();
    feed('chat', a, 20, 3_400);
    feed('chat', b, 20, 1_200);
    orderTargets('chat', chain, T0);
    feed('chat', a, 20, 1_250, true, T0 + 6 * MIN);
    feed('chat', b, 20, 1_000, true, T0 + 6 * MIN);
    expect(names(orderTargets('chat', chain, T0 + 6 * MIN))[1]).toBe('google:gemini');
    feed('chat', a, 30, 1_050, true, T0 + 22 * MIN);
    feed('chat', b, 20, 1_000, true, T0 + 22 * MIN);
    expect(names(orderTargets('chat', chain, T0 + 22 * MIN))[1]).toBe('openrouter:gemini');
    expect(events.map(e => e.event)).toEqual(['route.reorder', 'route.reorder', 'route.reorder_reverted']);
    resetLinkReorder();
    feed('chat', a, 20, 3_400);
    feed('chat', b, 20, 1_200);
    orderTargets('chat', chain, T0);
    expect(names(orderTargets('chat', chain, T0 + REORDER.maxDwellMs))[1]).toBe('openrouter:gemini');
    expect(events.at(-1)!.attrs).toMatchObject({ reason: 'reavaliação após 30 min' });
  });

  it('never crosses equivalence groups and never moves the GPU deployment', () => {
    feed('chat', a, 20, 9_000);
    feed('chat', other, 20, 300);
    const out = orderTargets('chat', chain, T0);
    expect(names(out)).toEqual(names(chain));
    expect(out[0]).toBe(gpu);
    expect(linkStats('chat', gpu).n).toBe(0);
  });
});

describe('link reorder: who is equivalent', () => {
  const tts = (e: Partial<RouteEntrySpec>) => equivalenceGroup('tts', { provider: 'openrouter', ...e }, e.model ?? 'hexgrad/kokoro-82m');

  it('groups STT by language capability, chat by model or an explicit group, TTS only by the same voice', () => {
    expect(equivalenceGroup('stt', { provider: 'groq' }, 'whisper-large-v3')).toBe(equivalenceGroup('stt', { provider: 'openrouter' }, 'openai/whisper-large-v3'));
    expect(equivalenceGroup('stt', { provider: 'deepgram', language: 'en' }, 'nova-2')).not.toBe(equivalenceGroup('stt', { provider: 'groq' }, 'whisper'));
    expect(equivalenceGroup('chat', { provider: 'openrouter' }, 'gemini')).toBe(equivalenceGroup('chat', { provider: 'google' }, 'gemini'));
    expect(equivalenceGroup('chat', { provider: 'openrouter' }, 'gemini')).not.toBe(equivalenceGroup('chat', { provider: 'zai' }, 'glm'));
    expect(equivalenceGroup('chat', { provider: 'openrouter', equivalent: 'fast' }, 'gemini')).toBe(equivalenceGroup('chat', { provider: 'zai', equivalent: 'fast' }, 'glm'));
    expect(tts({ voice: 'pm_alex' })).toBe(tts({ provider: 'deepinfra', voice: 'pm_alex' }));
    expect(tts({ voice: 'pm_alex' })).not.toBe(tts({ voice: 'pf_dora' }));
    expect(tts({ voice: 'pm_alex', equivalent: 'kokoro' })).not.toBe(tts({ voice: 'pf_dora', equivalent: 'kokoro' }));
    expect(tts({ voice: 'pm_alex', equivalent: 'kokoro' })).toBe(tts({ model: 'kokoro-v1', voice: 'pm_alex', equivalent: 'kokoro' }));
    expect(tts({ equivalent: 'kokoro' })).not.toBe(tts({ model: 'kokoro-v1', equivalent: 'kokoro' }));
    expect(tts({ voices: { feminine: 'pf_dora', masculine: 'pm_alex' } })).not.toBe(tts({ voices: { feminine: 'pf_dora', masculine: 'pm_santa' } }));
  });

  it('a TTS chain with a male and a female voice keeps its order whatever the latency', () => {
    const male = { ...link('openrouter', 'kokoro'), group: tts({ voice: 'pm_alex' }), chainKey: 'tts|parle-tts' };
    const female = { ...link('deepinfra', 'kokoro'), group: tts({ voice: 'pf_dora' }), chainKey: 'tts|parle-tts' };
    feed('tts', male, 20, 5_000);
    feed('tts', female, 20, 400);
    expect(orderTargets('tts', [male, female], T0)).toEqual([male, female]);
  });
});

describe('link reorder in the routing', () => {
  it('selectTargets returns the effective order and runTargets feeds the measures', async () => {
    const breakers = new CircuitBreakerRegistry();
    const slow = { ...link('openrouter', 'gemini', 'model:gemini') };
    const fast = { ...link('google', 'gemini', 'model:gemini') };
    for (let i = 0; i < REORDER.minSamples; i++) {
      await runTargets([slow], async () => { await new Promise(r => setTimeout(r, 12)); return 'ok'; }, { stage: 'chat', breakers });
      await runTargets([fast], async () => 'ok', { stage: 'chat', breakers });
    }
    expect(linkStats('chat', slow).n).toBe(REORDER.minSamples);
    expect(selectTargets([slow, fast] as never, 'chat', breakers).usable.map((t: { providerId: string }) => t.providerId)).toEqual(['google', 'openrouter']);
  });

  it('builds groups only when the app allows it: reorderCloudLinks: false in its profile turns it off', () => {
    const fake = (id: string) => ({ providerId: id, isConfigured: () => true });
    const opts = (reorderFor?: (stage: 'chat' | 'stt' | 'tts', alias: string) => boolean) => buildServeProviders({
      instances: { chat: { openrouter: fake('openrouter'), zai: fake('zai') }, stt: {}, tts: {} } as never,
      env: {}, openrouter: { state: 'valid' }, modelRoutes: {},
      appRoutes: { chat: { 'x-chat': [{ provider: 'openrouter', model: 'gemini' }, { provider: 'zai', model: 'gemini' }] } },
      ...(reorderFor ? { reorderFor } : {}),
    } as never);
    const on = (opts().providers as { chatRoutes: Record<string, Array<{ group?: string; chainKey?: string }>> }).chatRoutes['x-chat']!;
    expect(on.map(t => [t.group, t.chainKey])).toEqual([['model:gemini', 'chat|x-chat'], ['model:gemini', 'chat|x-chat']]);
    const off = (opts(() => false).providers as { chatRoutes: Record<string, Array<{ group?: string }>> }).chatRoutes['x-chat']!;
    expect(off.every(t => t.group === undefined)).toBe(true);
    expect(parseAppProfile({ requiresGpu: false, gpuDeployments: [], reorderCloudLinks: false })).toMatchObject({ reorderCloudLinks: false });
    expect(parseAppProfile({ requiresGpu: false, gpuDeployments: [] })).not.toHaveProperty('reorderCloudLinks');
    expect(() => parseAppProfile({ requiresGpu: false, gpuDeployments: [], reorderCloudLinks: 'no' })).toThrow(/reorderCloudLinks/);
  });

  it('shows the effective order and the reason on «Garantia do serviço»', () => {
    const s = demoSnapshot(T0, 'warn');
    s.chains!.chat!['parle-chat'] = { serving: 'deployment:speech-stack', onFallback: false, links: [
      { target: 'deployment:speech-stack', state: 'ready' }, { target: 'openrouter:google/gemini-2.5-flash', state: 'ready' }, { target: 'google:google/gemini-2.5-flash', state: 'ready' },
    ] };
    s.reorders = [{ chainKey: 'chat|parle-chat', group: 'model:google/gemini-2.5-flash', leader: 'google:google/gemini-2.5-flash', declared: 'openrouter:google/gemini-2.5-flash', since: T0, reason: 'promovida: p95 1,2 s vs 3,4 s' }];
    const html = renderStatus('n', s, { now: T0, csrf: 'c', actor: 'marcos', message: null, app: null, page: 'servicos' });
    const block = html.slice(html.indexOf('<code>parle-chat</code>'), html.indexOf('</ol>', html.indexOf('<code>parle-chat</code>')));
    expect(block.indexOf('google:google/gemini-2.5-flash')).toBeLessThan(block.indexOf('openrouter:google/gemini-2.5-flash'));
    expect(block.indexOf('deployment') === -1 || block.indexOf('speech-stack')).toBeTruthy();
    expect(block).toContain('promovida: p95 1,2 s vs 3,4 s');
    expect(block).toContain('rebaixada');
    expect(html).toContain('Ordem efetiva');
  });
});
