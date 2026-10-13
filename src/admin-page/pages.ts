import type { ContainerLogView } from '../deployments/container-logs';
import { bootOf, gpuDetailBody } from './boot';
import { classStrip, trafficOf } from './class-card';
import { openIncidents } from './incidents';
import { services } from './guarantee';
import { recommendations } from './recommendations';
import { gpuActions, sectionsOf, unitOf, type AdminSnapshot, type AppView } from './render';
import { monthForecast, spendWindow } from './spend';
import { CSS } from './styles';
import {
  ago, appTitle, count, duration, esc, form, latest, mark, money, ms, upOf, worst, ZONE, type Ctx, type Level, type Section,
} from './ui';

export interface PageDef { id: string; path: string; title: string; tab: string; icon: string; sections: string[]; lead: string }

const ICON: Record<string, string> = {
  geral: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  servicos: '<path d="M12 3 2 8l10 5 10-5z"/><path d="m2 13 10 5 10-5"/>',
  gpus: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',
  gastos: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.6a4.2 4.2 0 1 0 0 6.8M7.5 11h6m-6 2.5h6"/>',
  chaves: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 3 3 3"/>',
  atividade: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

export const PAGES: PageDef[] = [
  { id: 'geral', path: '/admin', title: 'Visão geral', tab: 'Geral', icon: ICON.geral!, sections: ['aula', 'recomendacoes'], lead: '' },
  {
    id: 'servicos', path: '/admin/servicos', title: 'Serviços', tab: 'Serviços', icon: ICON.servicos!, sections: ['apps', 'garantia', 'reservas', 'trafego'],
    lead: 'Cada app, como cada etapa é garantida, as reservas na nuvem e o tráfego das últimas 24 h.',
  },
  {
    id: 'gpus', path: '/admin/gpus', title: 'GPUs e máquinas', tab: 'GPUs', icon: ICON.gpus!, sections: ['gpus', 'maquinas'],
    lead: 'Qual GPU está ligada, por quê, quanto custa e se o boot travou.',
  },
  {
    id: 'gastos', path: '/admin/gastos', title: 'Gastos', tab: 'Gastos', icon: ICON.gastos!, sections: ['gastos', 'cachevoz', 'saldos'],
    lead: 'GPU por dia e por app, e quanto saldo resta em cada provedor.',
  },
  {
    id: 'chaves', path: '/admin/chaves', title: 'Chaves', tab: 'Chaves', icon: ICON.chaves!, sections: ['chaves'],
    lead: 'Quem acessa o gateway, o que cada chave pode ligar e quanto gastou hoje. O valor da chave nunca aparece.',
  },
  {
    id: 'atividade', path: '/admin/atividade', title: 'Atividade', tab: 'Atividade', icon: ICON.atividade!, sections: ['incidentes', 'alertas', 'atividade'],
    lead: 'Incidentes com o que foi feito em cada um, os alertas enviados e o registro de quem fez o quê no painel, nas chaves e nas GPUs.',
  },
];

export const ANCHOR_PAGE: Record<string, string> = { visao: '/admin', ...Object.fromEntries(PAGES.flatMap(p => p.sections.map(id => [id, p.path]))) };
export const pageAt = (path: string) => PAGES.find(p => p.path === path) ?? null;

const svg = (paths: string, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const LOGO = svg('<path d="M4 7h16M4 12h10M4 17h6"/><circle cx="18" cy="15" r="3"/>');
const HEADLINE: Record<Level, string> = { ok: 'Tudo funcionando', warn: 'Funcionando, com avisos', bad: 'Algo está fora do ar' };

const SCRIPT = `var P=Object.assign(Object.create(null),%MAP%),h=location.hash.slice(1),t=P[h]||P[h.split('-')[0]];if(t&&t!==location.pathname)location.replace(t+location.search+'#'+h);`
  + `var l=document.getElementById('login');if(l)l.addEventListener('submit',function(){l.next.value+=location.hash});`
  + `document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.dataset.confirm))e.preventDefault()})});`;

function page(nonce: string, title: string, body: string, refresh = false): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${
    refresh ? '<meta http-equiv="refresh" content="60">' : ''}<meta name="robots" content="noindex"><title>${esc(title)}</title><style nonce="${nonce}">${CSS}</style></head><body>${body}`
    + `<script nonce="${nonce}">${SCRIPT.replace('%MAP%', JSON.stringify(ANCHOR_PAGE))}</script></body></html>`;
}

const pageLevel = (p: PageDef, all: Map<string, Section>) => {
  const own = p.sections.map(id => all.get(id)).filter((x): x is Section => Boolean(x));
  const counted = own.filter(x => !x.info);
  return worst((counted.length ? counted : own).map(x => x.level));
};

function statusBar(s: AdminSnapshot, now: number, time: string): string {
  const a = s.about;
  const fresh = (label: string, iso: string | null) => `<span>${label} ${iso ? esc(ago(iso, now)) : 'sem leitura'}</span>`;
  return `<footer class="bar" aria-label="Estado do gateway">${a ? `<span>build <code>${esc(a.commit?.slice(0, 7) ?? '—')}</code></span><span>no ar há ${duration(a.uptimeSeconds)}</span>` : ''}`
    + `${a?.region ? `<span>região ${esc(a.region)}</span>` : ''}<span>atualizado ${time}</span>`
    + `${s.traffic ? fresh('telemetria', a?.telemetryAt ?? null) : ''}${s.balances.length ? fresh('saldos', latest(s.balances.map(b => b.checkedAt))) : ''}`
    + `${fresh('reservas', latest(s.reserves.links.map(r => r.checkedAt)))}</footer>`;
}

interface Frame { ctx: Ctx; all: Map<string, Section>; overall: Level; actor: string; time: string; current: string; message: string | null }

function shell(f: Frame, content: string): string {
  const query = f.ctx.app ? `?app=${encodeURIComponent(f.ctx.app)}` : '';
  const own = f.ctx.view && appTitle(f.ctx.view.id, f.ctx.s.apps.find(a => a.id === f.ctx.view!.id)?.profile);
  const links = PAGES.map((p) => {
    const level = p.id === 'geral' ? f.overall : pageLevel(p, f.all);
    const cur = p.id === f.current;
    return `<li><a href="${p.path}${query}" class="${level}${cur ? ' cur' : ''}"${cur ? ' aria-current="page"' : ''}>${svg(p.icon, 'ic')}`
      + `<span class="lb">${esc(p.tab)}</span>${level === 'ok' ? '' : mark(level)}</a></li>`;
  }).join('');
  const side = `<aside class="side"><div class="brand">${LOGO}<span>ai-gateway <small>${own ? esc(own.name) : 'admin'}</small></span></div>`
    + `<nav aria-label="Páginas"><ul class="nav">${links}</ul></nav>`
    + `<div class="foot"><div class="who"><b>${esc(f.actor)}</b><br>atualizado às ${f.time}<br>recarrega a cada 1 min</div>${form('/admin/logout', f.ctx.csrf, 'Sair', '')}</div></aside>`;
  const msg = f.message ? `<p class="msg" role="status">${esc(f.message)}</p>` : '';
  return `<div class="shell">${side}<main class="main">${msg}${content}${statusBar(f.ctx.s, f.ctx.now, f.time)}</main></div>`;
}

const sectionHtml = (x: Section) => `<section id="${x.id}"><header class="sh"><h2>${esc(x.title)}</h2>${x.badge ?? (x.level === 'ok' ? '' : pillOf(x.level))}${
  x.meta ? `<span class="meta">${esc(x.meta)}</span>` : ''}${x.actions ? `<div class="acts">${x.actions}</div>` : ''}</header>${x.body}</section>`;

const LEVEL_WORD: Record<Level, string> = { ok: 'Normal', warn: 'Atenção', bad: 'Problema' };
const pillOf = (level: Level) => `<span class="pill ${level}">${mark(level)}${LEVEL_WORD[level]}</span>`;

interface Card { page: PageDef; level: Level; verdict: string; facts: string; notes: string[] }

const NOTES_SHOWN = 3;

function cardHtml(c: Card, query: string): string {
  const notes = c.notes.slice(0, NOTES_SHOWN).map(n => `<li>${esc(n)}</li>`).join('')
    + (c.notes.length > NOTES_SHOWN ? `<li class="more">e mais ${c.notes.length - NOTES_SHOWN}</li>` : '');
  return `<a class="card ${c.level}" href="${c.page.path}${query}"><span class="ch">${svg(c.page.icon, 'ic')}<span>${esc(c.page.title)}</span>${mark(c.level)}</span>`
    + `<b class="cv">${esc(c.verdict)}</b><span class="cf">${esc(c.facts)}</span>${notes ? `<ul>${notes}</ul>` : ''}<span class="go">Abrir ${esc(c.page.title.toLowerCase())} →</span></a>`;
}

function cards(ctx: Ctx, all: Map<string, Section>): Card[] {
  const { s, now } = ctx;
  const notesOf = (p: PageDef, extra: string[] = []) => [...p.sections, ...extra].flatMap(id => (all.get(id)?.info ? [] : all.get(id)?.notes ?? []));
  const [, svcPage, gpuPage, spendPage, keyPage] = PAGES as [PageDef, PageDef, PageDef, PageDef, PageDef, PageDef];
  const list = services(s, ctx.app, now);
  const garantidos = list.filter(x => x.level === 'ok').length;
  const t = trafficOf(ctx);
  const total = t ? t.total.served + t.total.failed : 0;
  const svcLevel = pageLevel(svcPage, all);
  const svcNotes = notesOf(svcPage);
  const on = (s.gpus ?? []).filter(d => upOf(d).length);
  const perHour = on.flatMap(upOf).reduce((a, r) => a + (r.pricePerHour ?? 0), 0);
  const booting = (s.gpus ?? []).filter(d => bootOf(d)).length;
  const days = s.spend ? spendWindow(ctx).slice(-8) : null;
  const dayTotal = (d: { apps: Record<string, { gpuEur: number }> }) => Object.values(d.apps).reduce((a, e) => a + e.gpuEur, 0);
  const keySpend = Object.values(s.gpuSpend?.spentEur ?? {}).reduce((a, b) => a + b, 0);
  const today = days ? dayTotal(days.at(-1)!) : keySpend;
  const shortest = s.balances.filter(r => r.balanceUsd !== null).sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity))[0];
  const spendLevel = worst([pageLevel(spendPage, all), pageLevel(keyPage, all)]);
  const forecast = monthForecast(ctx);
  return [
    {
      page: svcPage, level: svcLevel,
      verdict: svcLevel === 'ok' ? (list.length ? 'Todos os serviços respondendo' : 'Respondendo') : svcNotes[0] ?? 'Pede atenção',
      facts: [list.length ? `${garantidos} de ${list.length} serviços garantidos` : '', ...(t ? [`${count(total)} chamadas em 24 h`,
        `${count(t.total.failed)} sem resposta`, `p95 ${ms(t.total.p95Ms)}`] : [])].filter(Boolean).join(' · '),
      notes: svcLevel === 'ok' ? [] : svcNotes.slice(1),
    },
    {
      page: gpuPage, level: pageLevel(gpuPage, all),
      verdict: s.gpus ? (on.length ? `${on.length} de ${s.gpus.length} ligadas · ${money(perHour)}/h` : `Todas desligadas (${s.gpus.length})`) : 'GPUs gerenciadas desligadas aqui',
      facts: [booting ? `${booting} iniciando` : '', on.length ? `ligadas: ${on.map(d => d.name).join(', ')}` : 'nenhum custo de GPU agora'].filter(Boolean).join(' · '),
      notes: notesOf(gpuPage),
    },
    {
      page: spendPage, level: spendLevel,
      verdict: `${money(today)} de GPU hoje`,
      facts: [days ? `ontem ${money(dayTotal(days.at(-2)!))} · 7 dias ${money(days.slice(1).reduce((a, d) => a + dayTotal(d), 0))}` : '',
        forecast ? `projeção do mês ${money(forecast.projected.gpuEur)} + nuvem ${money(forecast.projected.cloudUsd, 'US$')}` : '',
        shortest ? `menor saldo ${shortest.provider} ${money(shortest.balanceUsd, unitOf(shortest))}${shortest.hoursLeft !== null ? ` (~${count(Math.round(shortest.hoursLeft))} h)` : ''}` : ''].filter(Boolean).join(' · '),
      notes: [...notesOf(spendPage), ...notesOf(keyPage)],
    },
  ];
}

function overview(f: Frame): string {
  const { ctx, all, overall } = f;
  const attention = [...all.values()].filter(x => !x.info && x.level !== 'ok').length;
  const own = ctx.view && appTitle(ctx.view.id, ctx.s.apps.find(a => a.id === ctx.view!.id)?.profile);
  const query = ctx.app ? `?app=${encodeURIComponent(ctx.app)}` : '';
  return `<header class="hero" id="visao">${mark(overall)}<div><h1>${HEADLINE[overall]}</h1><p>${
    attention ? `${attention} ${attention > 1 ? 'áreas pedem' : 'área pede'} atenção` : 'Nenhuma área pede atenção'} · ${f.time} (Paris)</p></div></header>`
    + (own ? `<p class="scope">Visão do app <b>${esc(own.name)}</b>${own.description ? ` · ${esc(own.description)}` : ''}<small>Só os dados deste app: as GPUs, as chaves, as reservas e os eventos dele.</small></p>` : '')
    + classStrip(ctx, all.get('aula'))
    + openIncidents(ctx)
    + `<div class="cards">${cards(ctx, all).map(c => cardHtml(c, query)).join('')}</div>`
    + sectionHtml(all.get('recomendacoes')!);
}

function subnav(p: PageDef, list: Section[]): string {
  if (list.length < 2) return '';
  return `<nav class="jump" aria-label="Nesta página">${list.map(x => `<a href="#${x.id}" class="${x.level}">${x.level === 'ok' || x.info ? '' : mark(x.level)}${esc(x.title)}${
    x.count !== null ? `<span class="n">${count(x.count)}</span>` : ''}</a>`).join('')}</nav>`;
}

export interface RenderOptions { now: number; csrf: string; actor: string; message: string | null; app: string | null; view?: AppView | null; page?: string }

function frame(s: AdminSnapshot, opts: RenderOptions, current: string, path: string): Frame {
  const view = opts.view ?? null;
  const ctx: Ctx = { s, now: opts.now, csrf: opts.csrf, app: view ? null : opts.app, view, path };
  const all = sectionsOf(ctx, recommendations(ctx));
  const overall = worst([...all.values()].filter(x => !x.info).map(x => x.level));
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(opts.now);
  return { ctx, all, overall, actor: opts.actor, time, current, message: opts.message };
}

export function renderStatus(nonce: string, s: AdminSnapshot, opts: RenderOptions): string {
  const p = PAGES.find(x => x.id === (opts.page ?? 'geral')) ?? PAGES[0]!;
  const f = frame(s, opts, p.id, p.path);
  const own = f.ctx.view && appTitle(f.ctx.view.id, s.apps.find(a => a.id === f.ctx.view!.id)?.profile);
  const list = p.sections.map(id => f.all.get(id)).filter((x): x is Section => Boolean(x));
  const content = p.id === 'geral' ? overview(f)
    : `<header class="ph"><h1>${esc(p.title)}</h1><p>${esc(p.lead)}</p></header>${subnav(p, list)}${list.map(sectionHtml).join('')}`;
  const title = p.id === 'geral' ? HEADLINE[f.overall] : p.title;
  return page(nonce, `ai-gateway · ${own ? `${own.name} · ` : ''}${title}`, shell(f, content), true);
}

export function renderGpuDetail(nonce: string, s: AdminSnapshot, name: string, opts: RenderOptions, container: ContainerLogView | null = null): string | null {
  const d = s.gpus?.find(g => g.name === name);
  if (!d) return null;
  const f = frame(s, opts, 'gpus', `/admin/gpus/${encodeURIComponent(d.name)}`);
  return page(nonce, `ai-gateway · ${d.name}`, shell(f, gpuDetailBody(d, s.gpuLogs?.[name] ?? [], opts.now, gpuActions(d, f.ctx), container)), true);
}

export function renderLogin(nonce: string, error: string | null, next = '/admin'): string {
  return page(nonce, 'ai-gateway · entrar', `<main class="login"><div class="brand">${LOGO}<span>ai-gateway <small>admin</small></span></div>`
    + `<section><h1>Painel do gateway</h1><p>Cole a chave admin, ou a chave do seu app para ver só os dados dele. A sessão dura 12 h neste aparelho.</p>${
      error ? `<p class="msg bad" role="alert">${mark('bad')}${esc(error)}</p>` : ''}<form method="post" action="/admin/login" id="login"><input type="hidden" name="next" value="${esc(next)}">`
    + '<label for="key">Chave admin ou do app</label><input id="key" name="key" type="password" autocomplete="current-password" required autofocus><button>Entrar</button></form></section></main>');
}
