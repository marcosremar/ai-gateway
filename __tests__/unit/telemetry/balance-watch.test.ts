import { describe, expect, it } from 'vitest';
import { balanceThresholdsFromEnv, createBalanceWatch, readBalances, type GatewaySpend } from '../../../src/telemetry/balance-watch';
import { alertEmailFromEnv, createAlertMailer, opsAlertMail, secretValues, type AlertMail } from '../../../src/telemetry/alert-email';

const VAST_KEY = 'vast-secret-0123456789abcdef';
const OR_KEY = 'sk-or-v1-0123456789abcdef0123456789';
const RP_KEY = 'rpa_0123456789ABCDEFGHIJ';
const T0 = Date.parse('2026-10-10T12:00:00Z');

interface World { vastCredit: number; vastDph: number[]; orTotal: number; orUsed: number; orExpires: string | null; orStatus: number; rpBalance: number; rpSpend: number }

function fakeProviders(w: World): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/users/current/')) return json({ credit: w.vastCredit });
    if (url.endsWith('/instances/')) return json({ instances: w.vastDph.map(d => ({ actual_status: 'running', dph_total: d })).concat([{ actual_status: 'exited', dph_total: 9 }]) });
    if (url.endsWith('/api/v1/key')) return w.orStatus === 200 ? json({ data: { limit_remaining: null, expires_at: w.orExpires } }) : json({ error: 'no' }, w.orStatus);
    if (url.endsWith('/api/v1/credits')) return json({ data: { total_credits: w.orTotal, total_usage: w.orUsed } });
    if (url.includes('runpod')) return json({ data: { myself: { clientBalance: w.rpBalance, currentSpendPerHr: w.rpSpend } } });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

const healthy: World = { vastCredit: 50, vastDph: [0.3], orTotal: 100, orUsed: 10, orExpires: null, orStatus: 200, rpBalance: 20, rpSpend: 0 };
const env = { VAST_API_KEY: VAST_KEY, OPENROUTER_API_KEY: OR_KEY, RUNPOD_API_KEY: RP_KEY };

function rig(world: World, extra: Record<string, string> = {}, spend: GatewaySpend | null = null) {
  let t = T0;
  const alerts: AlertMail[] = [];
  const watch = createBalanceWatch({
    env: { ...env, ...extra }, fetchImpl: fakeProviders(world), now: () => t, spend: () => spend,
    onAlert: (mail) => { alerts.push(mail); },
  });
  return { watch, alerts, world, advance: (ms: number) => { t += ms; } };
}

describe('balance watch: provider balances against thresholds', () => {
  it('healthy accounts raise nothing; numbers and burn come from the providers', async () => {
    const { watch, alerts } = rig({ ...healthy });
    const readings = await watch.check();
    expect(alerts).toEqual([]);
    const vast = readings.find(r => r.provider === 'vast')!;
    expect(vast).toMatchObject({ level: 'ok', balanceUsd: 50, burnPerHour: 0.3, hoursLeft: 166.7 });
    expect(readings.find(r => r.provider === 'openrouter')).toMatchObject({ level: 'ok', balanceUsd: 90 });
    expect(readings.find(r => r.provider === 'runpod')).toMatchObject({ level: 'ok', balanceUsd: 20, hoursLeft: null });
  });

  it('Vast below US$ 5 warns, below US$ 2 is urgent, and «acaba em < 12 h» counts every running instance of the account', async () => {
    const warn = await readBalances({ env, thresholds: balanceThresholdsFromEnv({}), fetchImpl: fakeProviders({ ...healthy, vastCredit: 4, vastDph: [0.1] }), now: T0 });
    expect(warn.find(r => r.provider === 'vast')).toMatchObject({ level: 'warn', hoursLeft: 40 });
    const urgent = await readBalances({ env, thresholds: balanceThresholdsFromEnv({}), fetchImpl: fakeProviders({ ...healthy, vastCredit: 1.5 }), now: T0 });
    expect(urgent.find(r => r.provider === 'vast')!.level).toBe('urgent');
    const burning = await readBalances({ env, thresholds: balanceThresholdsFromEnv({}), fetchImpl: fakeProviders({ ...healthy, vastCredit: 9.9, vastDph: [0.5, 0.5] }), now: T0 });
    const vast = burning.find(r => r.provider === 'vast')!;
    expect(vast).toMatchObject({ level: 'warn', burnPerHour: 1, hoursLeft: 9.9 });
    expect(vast.reasons.join(' ')).toMatch(/acaba em ~9\.9 h/);
  });

  it('thresholds are configurable per provider', async () => {
    const t = balanceThresholdsFromEnv({ BALANCE_VAST_WARN_USD: '20', BALANCE_HOURS_LEFT_WARN: '1', BALANCE_KEY_EXPIRY_DAYS: '30' });
    const out = await readBalances({ env, thresholds: t, fetchImpl: fakeProviders({ ...healthy, vastCredit: 15 }), now: T0 });
    expect(out.find(r => r.provider === 'vast')!.level).toBe('warn');
    expect(t.keyExpiryDays).toBe(30);
  });

  it('an OpenRouter key that expires in ≤ 7 days warns, ≤ 1 day or expired is urgent, a 401 is «chave recusada»', async () => {
    const soon = await readBalances({ env, thresholds: balanceThresholdsFromEnv({}), fetchImpl: fakeProviders({ ...healthy, orExpires: '2026-10-15T00:00:00Z' }), now: T0 });
    const or = soon.find(r => r.provider === 'openrouter')!;
    expect(or.level).toBe('warn');
    expect(or.reasons[0]).toMatch(/vence em 5 dia/);
    const gone = await readBalances({ env, thresholds: balanceThresholdsFromEnv({}), fetchImpl: fakeProviders({ ...healthy, orExpires: '2026-10-09T00:00:00Z' }), now: T0 });
    expect(gone.find(r => r.provider === 'openrouter')!.level).toBe('urgent');
    const refused = await readBalances({ env, thresholds: balanceThresholdsFromEnv({}), fetchImpl: fakeProviders({ ...healthy, orStatus: 401 }), now: T0 });
    expect(refused.find(r => r.provider === 'openrouter')).toMatchObject({ level: 'urgent', error: 'HTTP 401' });
  });

  it('OpenRouter credit under US$ 5 warns', async () => {
    const out = await readBalances({ env, thresholds: balanceThresholdsFromEnv({}), fetchImpl: fakeProviders({ ...healthy, orTotal: 1661.76, orUsed: 1657.5 }), now: T0 });
    expect(out.find(r => r.provider === 'openrouter')).toMatchObject({ level: 'warn', balanceUsd: 4.26 });
  });

  it('Scaleway: month spend against the summed monthly ceiling of the deployments', async () => {
    const out = await readBalances({ env: {}, thresholds: balanceThresholdsFromEnv({}), spend: () => ({ scalewayEurPerHour: 0.79, monthEur: 85, monthCapEur: 100 }), now: T0 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ provider: 'scaleway', level: 'warn', burnPerHour: 0.79, currency: 'EUR' });
  });

  it('a provider that is down shows the error and sends no email; a missing key is skipped', async () => {
    const failing = (async () => { throw new Error('ECONNRESET'); }) as typeof fetch;
    const alerts: AlertMail[] = [];
    const watch = createBalanceWatch({ env: { VAST_API_KEY: VAST_KEY }, fetchImpl: failing, onAlert: m => { alerts.push(m); } });
    const out = await watch.check();
    expect(out).toEqual([expect.objectContaining({ provider: 'vast', level: 'error', error: 'ECONNRESET' })]);
    expect(alerts).toEqual([]);
  });
});

describe('balance alerts: dedup and digest', () => {
  it('warn repeats every 6 h, urgent every 1 h, and an escalation goes out at once', async () => {
    const { watch, alerts, world, advance } = rig({ ...healthy, vastCredit: 4 });
    await watch.check();
    advance(5 * 3_600_000);
    await watch.check();
    expect(alerts.map(a => a.level)).toEqual(['warn']);
    advance(3_600_000 + 1);
    await watch.check();
    expect(alerts.map(a => a.level)).toEqual(['warn', 'warn']);
    world.vastCredit = 1;
    await watch.check();
    advance(30 * 60_000);
    await watch.check();
    expect(alerts.map(a => a.level)).toEqual(['warn', 'warn', 'urgent']);
    advance(31 * 60_000);
    await watch.check();
    expect(alerts.map(a => a.level)).toEqual(['warn', 'warn', 'urgent', 'urgent']);
    expect(alerts[2]!.subject).toMatch(/^Vast: saldo US\$ 1\.00/);
  });

  it('ALERT_DAILY_DIGEST=<UTC hour> sends one summary a day', async () => {
    const { watch, alerts, advance } = rig({ ...healthy }, { ALERT_DAILY_DIGEST: '13' });
    await watch.check();
    expect(alerts).toEqual([]);
    advance(3_600_000);
    await watch.check();
    advance(15 * 60_000);
    await watch.check();
    expect(alerts.map(a => a.kind)).toEqual(['digest|2026-10-10']);
    expect(alerts[0]!.body).toMatch(/Vast: ok, saldo US\$ 50\.00/);
  });
});

describe('alert email (Resend)', () => {
  const mail: AlertMail = { kind: 'balance|vast|low', level: 'urgent', subject: 'Vast: saldo baixo', body: `chave ${VAST_KEY} e Bearer ${OR_KEY}` };

  it('needs ALERT_EMAIL_TO and RESEND_API_KEY; the list splits on commas', () => {
    expect(alertEmailFromEnv({ RESEND_API_KEY: 're_x' })).toBeNull();
    expect(alertEmailFromEnv({ RESEND_API_KEY: 're_x', ALERT_EMAIL_TO: 'a@x.com, b@y.com' })).toMatchObject({ to: ['a@x.com', 'b@y.com'] });
  });

  it('posts to Resend, returns the id, and never puts a secret in subject or body', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: 'email-123' }), { status: 200 });
    }) as unknown as typeof fetch;
    const mailer = createAlertMailer({ apiKey: 're_live', from: 'AI <a@b.c>', to: ['dono@x.com'], fetchImpl, secrets: () => secretValues(env) });
    expect(await mailer.send(mail)).toBe('email-123');
    expect(await mailer.send(mail)).toBeNull();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://api.resend.com/emails');
    expect(posts[0]!.body.subject).toBe('[ai-gateway] URGENTE: Vast: saldo baixo');
    const sent = JSON.stringify(posts[0]!.body);
    for (const secret of [VAST_KEY, OR_KEY, RP_KEY, 're_live']) expect(sent).not.toContain(secret);
  });

  it('a failing email provider returns null and throws nothing', async () => {
    const down = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const crash = (async () => { throw new Error('dns'); }) as typeof fetch;
    const logs: string[] = [];
    for (const fetchImpl of [down, crash]) {
      const mailer = createAlertMailer({ apiKey: 're_x', from: 'a@b.c', to: ['d@x.com'], fetchImpl, log: m => { logs.push(m); } });
      await expect(mailer.send(mail)).resolves.toBeNull();
    }
    expect(logs).toEqual(['alert email failed', 'alert email failed']);
  });

  it('a throwing onAlert does not break the check', async () => {
    const watch = createBalanceWatch({ env: { VAST_API_KEY: VAST_KEY }, fetchImpl: fakeProviders({ ...healthy, vastCredit: 1 }), onAlert: () => { throw new Error('smtp'); } });
    await expect(watch.check()).resolves.toHaveLength(1);
  });

  it('the ops alerts of PR #83 become emails: credit and lost replica urgent, create failure warn', () => {
    expect(opsAlertMail({ event: 'provider.credit_exhausted', data: { provider: 'vast', balanceUsd: 0.4 } })).toMatchObject({ level: 'urgent', subject: 'crédito do provedor esgotado (vast)' });
    expect(opsAlertMail({ event: 'replica.lost_with_sessions', data: { deployment: 'parle-speech', busy: 3 } })!.level).toBe('urgent');
    expect(opsAlertMail({ event: 'deployment.create_failed', data: { deployment: 'parle-speech', error: 'x' } })!.level).toBe('warn');
    expect(opsAlertMail({ event: 'deployment.out_of_stock', data: { deployment: 'd' } })!.level).toBe('warn');
    expect(opsAlertMail({ event: 'stage.reserve_down', data: { stage: 'chat', target: 'groq', state: 'no_key' } })!.body).toMatch(/sandbox:set/);
    expect(opsAlertMail({ event: 'unknown', data: {} })).toBeNull();
  });
});

describe('controller spend summary (Scaleway fallback for the billing API)', () => {
  it('sums the monthly ceilings and the running Scaleway replicas', async () => {
    const { DeploymentController } = await import('../../../src/deployments/controller');
    const { HttpReplicaProbe } = await import('../../../src/deployments/http');
    const { MemoryDeploymentStore } = await import('../../../src/deployments/store');
    const { FakeCloud, until } = await import('../deployments/_fake-cloud');
    const t = T0;
    const c = new DeploymentController({
      backend: new FakeCloud(() => t), store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, now: () => t,
    });
    await c.init();
    await c.put('speech', { profile: 'cpu-echo', minReplicas: 1, maxEurPerHour: 2, scaling: { budget: { eurPerMonth: 120 } } });
    await c.put('other', { profile: 'cpu-echo', minReplicas: 0, maxEurPerHour: 2, scaling: { budget: { eurPerMonth: 30 } } });
    c.start();
    try {
      await until(() => c.get('speech')!.status === 'ready', 3000);
      const s = c.spendSummary();
      expect(s.monthCapEur).toBe(150);
      expect(s.scalewayEurPerHour).toBeGreaterThan(0);
      expect(s.scalewayEurPerHour).toBe(c.get('speech')!.replicas[0]!.pricePerHour);
    } finally {
      await c.stop();
    }
  });
});
