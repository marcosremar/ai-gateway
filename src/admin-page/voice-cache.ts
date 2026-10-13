import type { TtsCacheAppStats, TtsCacheStats } from '../gateway/proxy/tts-cache';
import type { Recommendation } from './recommendations';
import { appTitle, count, esc, meter, pct, table, type Ctx, type Section } from './ui';

const MB = 1024 * 1024;
const HIGH_HIT_RATE = 0.3;
const MIN_LOOKUPS = 50;
const seconds = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min`
  : `${(ms / 3_600_000).toFixed(1).replace('.', ',')} h`);
const rate = (s: Pick<TtsCacheAppStats, 'hits' | 'misses'>) => (s.hits + s.misses ? s.hits / (s.hits + s.misses) : null);

function totals(stats: TtsCacheStats, app: string | null): TtsCacheAppStats {
  if (!app) return { hits: stats.hits, misses: stats.misses, bypassed: stats.bypassed, savedMs: stats.savedMs };
  return stats.byApp[app] ?? { hits: 0, misses: 0, bypassed: 0, savedMs: 0 };
}

export function voiceCache(ctx: Ctx): Section {
  const base = { id: 'cachevoz', title: 'Cache de voz (TTS)', actions: '', count: null };
  const stats = ctx.s.ttsCache;
  if (!stats) return { ...base, level: 'ok', notes: [], meta: '', body: '<p class="empty">O cache de voz está desligado neste gateway (TTS_CACHE=0).</p>' };
  const own = ctx.view?.id ?? ctx.app;
  const t = totals(stats, own);
  const r = rate(t);
  const stat = (label: string, value: string, extra = '') => `<div><span>${esc(label)}</span><b>${esc(value)}</b>${extra}</div>`;
  const used = own ? '' : stat('Memória', `${(stats.bytes / MB).toFixed(1).replace('.', ',')} de ${Math.round(stats.maxBytes / MB)} MB`, meter(stats.bytes, stats.maxBytes, 'ok'))
    + (stats.diskMaxBytes ? stat('Disco', `${(stats.diskBytes / MB).toFixed(1).replace('.', ',')} de ${Math.round(stats.diskMaxBytes / MB)} MB`, meter(stats.diskBytes, stats.diskMaxBytes, 'ok')) : '');
  const rows = Object.entries(stats.byApp).filter(([id]) => !own || id === own).sort(([, a], [, b]) => b.hits - a.hits).map(([id, a]) => [
    `<b>${esc(appTitle(id, ctx.s.apps.find(x => x.id === id)?.profile).name)}</b>`, count(a.hits + a.misses), count(a.hits), rate(a) === null ? '—' : pct(rate(a)!),
    seconds(a.savedMs), count(a.bypassed),
  ]);
  return {
    ...base, level: 'ok', notes: [],
    meta: `desde o boot · validade ${stats.ttlHours} h · ${count(stats.entries)} falas na memória${stats.evictions ? ` · ${count(stats.evictions)} descartadas por falta de espaço` : ''}`,
    body: `<div class="stats">${stat('Acertos', r === null ? '—' : pct(r), `<small>${count(t.hits)} de ${count(t.hits + t.misses)} pedidos</small>`)}`
      + `${stat('Sínteses evitadas', count(t.hits), `<small>~${seconds(t.savedMs)} de síntese a menos</small>`)}${used}</div>`
      + table([{ label: 'App' }, { label: 'Pedidos', num: true }, { label: 'Acertos', num: true }, { label: 'Taxa', num: true }, { label: 'Síntese evitada', num: true },
        { label: 'Sem cache', num: true, wide: true }], rows, 'Nenhum pedido de voz desde o boot.')
      + '<p class="foot-note">A mesma fala (app, voz, texto, formato, velocidade e cadeia de provedores) volta da memória ou do disco sem chamar a GPU nem a nuvem; '
      + 'o pedido ainda conta na telemetria e no gasto, a € 0. Só entra no cache áudio completo e não silencioso; para um app que precisa da GPU, '
      + 'a voz da reserva na nuvem nunca é guardada. Um pedido com Cache-Control: no-store passa direto.</p>',
  };
}

export function voiceCacheRules(ctx: Ctx): Recommendation[] {
  const stats = ctx.s.ttsCache;
  if (!stats) return [];
  const t = totals(stats, ctx.view?.id ?? null);
  const r = rate(t);
  if (r === null || t.hits + t.misses < MIN_LOOKUPS || r < HIGH_HIT_RATE) return [];
  const full = stats.evictions > 0 && !ctx.view;
  return [{
    id: 'tts-cache', level: 'ok', title: `Cache de voz evita ${pct(r)} das sínteses`,
    saw: `${count(t.hits)} acertos em ${count(t.hits + t.misses)} pedidos desde o boot · ~${seconds(t.savedMs)} de síntese evitada${full ? ` · ${count(stats.evictions)} falas descartadas por falta de espaço` : ''}`,
    why: full ? 'As falas se repetem bastante e o cache está cheio: com mais memória, mais pedidos voltariam sem chamar a GPU nem a nuvem.'
      : 'As falas fixas se repetem: cada acerto é uma síntese a menos na GPU ou na nuvem, e a resposta chega na hora.',
    impact: null, gain: `~${seconds(t.savedMs)} de síntese evitada desde o boot`,
    action: full ? { text: `TTS_CACHE_MEMORY_MB=${Math.round((stats.maxBytes / MB) * 2)} (hoje ${Math.round(stats.maxBytes / MB)})` } : { go: '/admin/gastos#cachevoz', label: 'Ver o cache de voz' },
  }];
}
