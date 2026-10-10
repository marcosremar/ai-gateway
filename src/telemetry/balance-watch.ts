import { createRepeatGate, type AlertLevel, type AlertMail } from './alert-email';

export type BalanceProvider = 'vast' | 'openrouter' | 'runpod' | 'scaleway';

export interface BalanceReading {
  provider: BalanceProvider;
  level: 'ok' | AlertLevel | 'error';
  balanceUsd: number | null;
  burnPerHour: number | null;
  currency: 'USD' | 'EUR';
  hoursLeft: number | null;
  keyExpiresAt: string | null;
  monthEur: number | null;
  monthCapEur: number | null;
  source: string;
  reasons: string[];
  error: string | null;
  checkedAt: string;
}

export interface BalanceThresholds {
  warnUsd: Record<'vast' | 'openrouter' | 'runpod', number>;
  urgentUsd: Record<'vast' | 'openrouter' | 'runpod', number>;
  keyExpiryDays: number;
  hoursLeftWarn: number;
  hoursLeftUrgent: number;
  monthWarnRatio: number;
}

export interface GatewaySpend { scalewayEurPerHour: number; monthEur: number; monthCapEur: number }

type Env = Record<string, string | undefined>;
type Raw = Pick<BalanceReading, 'balanceUsd' | 'burnPerHour'> & Partial<Pick<BalanceReading, 'keyExpiresAt' | 'source' | 'currency'>>;

export const DEFAULT_BALANCE_CHECK_MINUTES = 15;

const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const money = (n: number, c = 'USD') => `${c === 'EUR' ? '€' : 'US$'} ${n.toFixed(2)}`;
const NAMES: Record<BalanceProvider, string> = { vast: 'Vast', openrouter: 'OpenRouter', runpod: 'RunPod', scaleway: 'Scaleway' };
const TODO: Record<BalanceProvider, string> = {
  vast: 'Recarregue em https://cloud.vast.ai/billing/ e desligue as máquinas que ninguém usa (todas as da conta entram no gasto, não só as do gateway).',
  openrouter: 'Recarregue em https://openrouter.ai/settings/credits; chave vencida ou recusada: gere outra e grave na API dev (bun run sandbox:set), depois reinicie o gateway.',
  runpod: 'Recarregue em https://www.runpod.io/console/user/billing ou pare os pods ligados.',
  scaleway: 'Veja os deployments em /health?details=1; reduza réplicas ou suba o teto mensal (scaling.budget.eurPerMonth).',
};

export function balanceThresholdsFromEnv(env: Env): BalanceThresholds {
  return {
    warnUsd: { vast: num(env.BALANCE_VAST_WARN_USD, 5), openrouter: num(env.BALANCE_OPENROUTER_WARN_USD, 5), runpod: num(env.BALANCE_RUNPOD_WARN_USD, 0) },
    urgentUsd: { vast: num(env.BALANCE_VAST_URGENT_USD, 2), openrouter: num(env.BALANCE_OPENROUTER_URGENT_USD, 1), runpod: num(env.BALANCE_RUNPOD_URGENT_USD, 0) },
    keyExpiryDays: num(env.BALANCE_KEY_EXPIRY_DAYS, 7),
    hoursLeftWarn: num(env.BALANCE_HOURS_LEFT_WARN, 12),
    hoursLeftUrgent: num(env.BALANCE_HOURS_LEFT_URGENT, 3),
    monthWarnRatio: num(env.BALANCE_MONTH_WARN_RATIO, 0.8),
  };
}

class Refused extends Error {}

async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) throw new Refused(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as Record<string, unknown>;
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const READERS: Record<'vast' | 'openrouter' | 'runpod', { key: string; read: (key: string, f: typeof fetch) => Promise<Raw> }> = {
  vast: {
    key: 'VAST_API_KEY',
    async read(key, f) {
      const auth = { headers: { Authorization: `Bearer ${key}` } };
      const user = await getJson(f, 'https://console.vast.ai/api/v0/users/current/', auth);
      const list = await getJson(f, 'https://console.vast.ai/api/v0/instances/', auth);
      const running = (Array.isArray(list.instances) ? list.instances : []) as Array<Record<string, unknown>>;
      const burn = running.filter(i => i.actual_status === 'running').reduce((s, i) => s + (n(i.dph_total) ?? 0), 0);
      return { balanceUsd: n(user.credit), burnPerHour: burn, source: 'vast /users/current + /instances (conta inteira)' };
    },
  },
  openrouter: {
    key: 'OPENROUTER_API_KEY',
    async read(key, f) {
      const auth = { headers: { Authorization: `Bearer ${key}` } };
      const info = ((await getJson(f, 'https://openrouter.ai/api/v1/key', auth)).data ?? {}) as Record<string, unknown>;
      const credits = await getJson(f, 'https://openrouter.ai/api/v1/credits', auth)
        .then(r => (r.data ?? {}) as Record<string, unknown>, () => ({}) as Record<string, unknown>);
      const total = n(credits.total_credits);
      const used = n(credits.total_usage);
      const left = [total !== null && used !== null ? total - used : null, n(info.limit_remaining)].filter((v): v is number => v !== null);
      return {
        balanceUsd: left.length ? Math.round(Math.min(...left) * 100) / 100 : null, burnPerHour: null,
        keyExpiresAt: typeof info.expires_at === 'string' ? info.expires_at : null, source: 'openrouter /api/v1/credits + /api/v1/key',
      };
    },
  },
  runpod: {
    key: 'RUNPOD_API_KEY',
    async read(key, f) {
      const res = await getJson(f, 'https://api.runpod.io/graphql', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ myself { clientBalance currentSpendPerHr } }' }),
      });
      const me = ((res.data as Record<string, unknown> | undefined)?.myself ?? {}) as Record<string, unknown>;
      return { balanceUsd: n(me.clientBalance), burnPerHour: n(me.currentSpendPerHr), source: 'runpod graphql myself' };
    },
  },
};

export function judgeBalance(reading: Omit<BalanceReading, 'level' | 'reasons' | 'hoursLeft'>, t: BalanceThresholds, now: number): BalanceReading {
  const reasons: string[] = [];
  let level: BalanceReading['level'] = 'ok';
  const raise = (to: AlertLevel, why: string) => { reasons.push(why); if (level !== 'urgent') level = to; };
  const { provider, balanceUsd: bal, burnPerHour: burn, currency } = reading;
  const hoursLeft = bal !== null && burn !== null && burn > 0 ? Math.max(0, bal / burn) : null;
  if (provider !== 'scaleway' && bal !== null) {
    const urgent = t.urgentUsd[provider];
    const warn = t.warnUsd[provider];
    if (urgent > 0 && bal < urgent) raise('urgent', `saldo ${money(bal)} abaixo do limite urgente de ${money(urgent)}`);
    else if (warn > 0 && bal < warn) raise('warn', `saldo ${money(bal)} abaixo do aviso de ${money(warn)}`);
  }
  if (hoursLeft !== null && hoursLeft < t.hoursLeftWarn) {
    raise(hoursLeft < t.hoursLeftUrgent ? 'urgent' : 'warn', `com o gasto atual de ${money(burn!, currency)}/h o saldo acaba em ~${hoursLeft.toFixed(1)} h`);
  }
  if (reading.keyExpiresAt) {
    const days = (Date.parse(reading.keyExpiresAt) - now) / 86_400_000;
    if (days <= 0) raise('urgent', `a chave venceu em ${reading.keyExpiresAt.slice(0, 10)}`);
    else if (days <= t.keyExpiryDays) raise(days <= 1 ? 'urgent' : 'warn', `a chave vence em ${Math.ceil(days)} dia(s) (${reading.keyExpiresAt.slice(0, 10)})`);
  }
  if (reading.monthEur !== null && reading.monthCapEur) {
    const ratio = reading.monthEur / reading.monthCapEur;
    if (ratio >= 1) raise('urgent', `gasto do mês ${money(reading.monthEur, 'EUR')} atingiu o teto de ${money(reading.monthCapEur, 'EUR')}`);
    else if (ratio >= t.monthWarnRatio) raise('warn', `gasto do mês ${money(reading.monthEur, 'EUR')} já é ${Math.round(ratio * 100)} % do teto de ${money(reading.monthCapEur, 'EUR')}`);
  }
  const cents = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
  return { ...reading, balanceUsd: cents(bal), burnPerHour: burn === null ? null : Math.round(burn * 1000) / 1000, level, reasons, hoursLeft: hoursLeft === null ? null : Math.round(hoursLeft * 10) / 10 };
}

function blank(provider: BalanceProvider, now: number): Omit<BalanceReading, 'level' | 'reasons' | 'hoursLeft'> {
  return {
    provider, balanceUsd: null, burnPerHour: null, currency: 'USD', keyExpiresAt: null, monthEur: null, monthCapEur: null,
    source: '', error: null, checkedAt: new Date(now).toISOString(),
  };
}

export async function readBalances(opts: {
  env: Env; thresholds: BalanceThresholds; spend?: () => GatewaySpend | null; fetchImpl?: typeof fetch; now?: number;
}): Promise<BalanceReading[]> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const out = await Promise.all(Object.entries(READERS).map(async ([provider, r]) => {
    const key = opts.env[r.key]?.trim();
    if (!key) return null;
    const base = blank(provider as BalanceProvider, now);
    try {
      return judgeBalance({ ...base, ...(await r.read(key, f)) }, opts.thresholds, now);
    } catch (err) {
      const refused = err instanceof Refused;
      return {
        ...base, hoursLeft: null, level: refused ? 'urgent' as const : 'error' as const,
        reasons: refused ? [`o provedor recusou a chave ${r.key} (${err.message})`] : [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));
  const spend = opts.spend?.();
  if (spend) {
    out.push(judgeBalance({
      ...blank('scaleway', now), burnPerHour: spend.scalewayEurPerHour, currency: 'EUR', monthEur: spend.monthEur, monthCapEur: spend.monthCapEur || null,
      source: 'estimativa do gateway (a chave aigw-machines não lê a API de billing: 403)',
    }, opts.thresholds, now));
  }
  return out.filter((r): r is BalanceReading => r !== null);
}

export function balanceMail(r: BalanceReading): AlertMail | null {
  if (r.level !== 'warn' && r.level !== 'urgent') return null;
  const refused = r.error !== null;
  const subject = refused ? `${NAMES[r.provider]} recusou a chave` : `${NAMES[r.provider]}: ${r.reasons[0]}`;
  const lines = [
    `${NAMES[r.provider]} — ${r.reasons.join('; ')}.`,
    '',
    r.balanceUsd !== null ? `Saldo: ${money(r.balanceUsd)}` : null,
    r.burnPerHour !== null ? `Gasto agora: ${money(r.burnPerHour, r.currency)}/h` : null,
    r.hoursLeft !== null ? `Acaba em: ~${r.hoursLeft} h` : null,
    r.keyExpiresAt ? `Chave vence: ${r.keyExpiresAt.slice(0, 10)}` : null,
    r.monthEur !== null && r.monthCapEur ? `Mês: ${money(r.monthEur, 'EUR')} de ${money(r.monthCapEur, 'EUR')}` : null,
    '',
    `O que fazer: ${TODO[r.provider]}`,
  ].filter(l => l !== null);
  return { kind: `balance|${r.provider}|${refused ? 'refused' : 'low'}`, level: r.level, subject, body: lines.join('\n') };
}

export function digestMail(readings: BalanceReading[], day: string): AlertMail {
  const rows = readings.map(r => [
    `${NAMES[r.provider]}: ${r.level}`,
    r.balanceUsd !== null ? `saldo ${money(r.balanceUsd)}` : null,
    r.burnPerHour !== null ? `gasto ${money(r.burnPerHour, r.currency)}/h` : null,
    r.hoursLeft !== null ? `acaba em ~${r.hoursLeft} h` : null,
    r.monthEur !== null ? `mês ${money(r.monthEur, 'EUR')}${r.monthCapEur ? ` de ${money(r.monthCapEur, 'EUR')}` : ''}` : null,
    r.keyExpiresAt ? `chave vence ${r.keyExpiresAt.slice(0, 10)}` : null,
    r.error ? `erro ${r.error}` : null,
  ].filter(Boolean).join(', '));
  return { kind: `digest|${day}`, level: 'warn', subject: `resumo diário de saldos (${day})`, body: `Saldos dos provedores em ${day}:\n\n${rows.join('\n')}` };
}

export function createBalanceWatch(opts: {
  env: Env; onAlert: (mail: AlertMail, reading: BalanceReading | null) => unknown;
  spend?: () => GatewaySpend | null; fetchImpl?: typeof fetch; now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}) {
  const now = opts.now ?? Date.now;
  const due = createRepeatGate(now);
  const thresholds = balanceThresholdsFromEnv(opts.env);
  const intervalMs = Math.max(1, num(opts.env.BALANCE_CHECK_MINUTES, DEFAULT_BALANCE_CHECK_MINUTES)) * 60_000;
  const digestHour = opts.env.ALERT_DAILY_DIGEST?.trim() ? num(opts.env.ALERT_DAILY_DIGEST, -1) : -1;
  let readings: BalanceReading[] = [];
  let lastDigest = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  async function check(): Promise<BalanceReading[]> {
    const t = now();
    readings = await readBalances({ env: opts.env, thresholds, ...(opts.spend ? { spend: opts.spend } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), now: t });
    for (const r of readings) {
      const mail = balanceMail(r);
      if (mail && due(mail)) await Promise.resolve().then(() => opts.onAlert(mail, r)).catch(() => {});
    }
    const day = new Date(t).toISOString().slice(0, 10);
    if (digestHour >= 0 && new Date(t).getUTCHours() >= digestHour && lastDigest !== day && readings.length) {
      lastDigest = day;
      await Promise.resolve().then(() => opts.onAlert(digestMail(readings, day), null)).catch(() => {});
    }
    return readings;
  }

  return {
    check,
    thresholds,
    intervalMs,
    snapshot: () => ({ intervalMinutes: intervalMs / 60_000, thresholds, readings }),
    start(): void {
      const run = () => void check().catch(err => opts.log?.('balance check failed', { error: err instanceof Error ? err.message : String(err) }));
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
  };
}
