import type { AdminSnapshot } from './render';

const tokensOf = (text: string) => new Set(text.split(/[^A-Za-z0-9._-]+/).filter(Boolean));

export function scopeToApp(s: AdminSnapshot, app: string): AdminSnapshot {
  const own = s.apps.find(a => a.id === app) ?? null;
  const gpus = s.gpus?.filter(d => d.app === app || own?.profile?.gpuDeployments.includes(d.name)) ?? null;
  const deployments = new Set(gpus?.map(d => d.name) ?? []);
  const keys = s.keys.filter(k => k.user === app);
  const keyIds = new Set(keys.map(k => k.id));
  const ownNames = new Set([app, ...deployments, ...keyIds]);
  const foreign = new Set([...s.apps.map(a => a.id), ...s.appBudgets.map(b => b.app), ...(s.gpus ?? []).map(d => d.name), ...s.keys.flatMap(k => [k.id, k.user])]
    .filter(name => !ownNames.has(name)));
  const aboutOwn = (text: string, alsoOwn: Set<string> = new Set()) => {
    const tokens = [...tokensOf(text)];
    return tokens.some(t => ownNames.has(t) || alsoOwn.has(t)) && !tokens.some(t => foreign.has(t));
  };
  const admins = new Set(s.keys.filter(k => k.admin).map(k => k.user));
  const aliases = new Set(own?.aliases ?? []);
  const links = aliases.size ? s.reserves.links.filter(r => r.aliases.some(a => aliases.has(a))) : s.reserves.links;
  const spentEur = Object.fromEntries(Object.entries(s.gpuSpend?.spentEur ?? {}).filter(([id]) => keyIds.has(id)));
  const running = s.gpuSpend?.running?.filter(r => keyIds.has(r.key) && deployments.has(r.deployment));
  const ownTraffic = s.traffic?.byApp?.[app];
  return {
    reserves: { intervalMinutes: s.reserves.intervalMinutes, links: links.map(r => ({ ...r, aliases: r.aliases.filter(a => aliases.has(a)) })) },
    balances: [],
    providerCredit: [],
    gpus,
    gpuSpend: s.gpuSpend ? { spentEur, ...(running ? { running } : {}) } : null,
    alerts: s.alerts.filter(a => aboutOwn(`${a.event} ${a.summary}`)),
    machines: null,
    keys,
    apps: own ? [own] : [],
    appBudgets: s.appBudgets.filter(b => b.app === app),
    traffic: s.traffic && {
      ...(ownTraffic ?? { hours: [], total: { key: 'total', served: 0, failed: 0, fallbacks: 0, p50Ms: null, p95Ms: null }, stages: [], providers: [], links: [] }),
      activity: s.traffic.activity.filter(e => e.deployment !== null && deployments.has(e.deployment)),
      apps: [], byApp: ownTraffic ? { [app]: ownTraffic } : {}, daily: s.traffic.daily?.[app] ? { [app]: s.traffic.daily[app]! } : {},
      costs: s.traffic.costs?.[app] ? { [app]: s.traffic.costs[app]! } : {},
      estimatedCosts: s.traffic.estimatedCosts?.[app] ? { [app]: s.traffic.estimatedCosts[app]! } : {},
    },
    gpuLogs: Object.fromEntries(Object.entries(s.gpuLogs ?? {}).filter(([name]) => deployments.has(name))),
    spend: s.spend ? { since: s.spend.since, days: s.spend.days.map(d => ({ day: d.day, apps: d.apps[app] ? { [app]: d.apps[app]! } : {} })) } : null,
    dismissed: Object.fromEntries(Object.entries(s.dismissed ?? {}).filter(([id]) => aboutOwn(id))),
    about: s.about ?? null,
    digest: null,
    ttsCache: s.ttsCache ? { ...s.ttsCache, byApp: s.ttsCache.byApp[app] ? { [app]: s.ttsCache.byApp[app]! } : {} } : s.ttsCache ?? null,
    overspend: (s.overspend ?? []).filter(o => o.app === app),
    modelPrices: s.modelPrices ?? null,
    voiceTurns: s.voiceTurns?.filter(t => t.app === app) ?? null,
    incidents: s.incidents?.filter(i => aboutOwn(`${i.event} ${i.key} ${i.alerts.map(a => a.summary).join(' ')}`, aliases)) ?? null,
    chains: s.chains ? Object.fromEntries(Object.entries(own?.stages ?? {}).map(([stage, aliases]) => [stage,
      Object.fromEntries(aliases.filter(a => s.chains![stage]?.[a]).map(a => [a, s.chains![stage]![a]!]))])) : null,
    audit: s.audit
      .filter(e => (e.actor === app || (admins.has(e.actor) && e.names.length > 0)) && e.names.every(n => ownNames.has(n)))
      .map(e => (e.actor === app ? e : { ...e, actor: 'admin' })),
  };
}
