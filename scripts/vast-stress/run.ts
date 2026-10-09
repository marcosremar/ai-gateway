import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dir;
const gw = process.env.GW ?? 'http://localhost:4200';
const key = process.env.KEY;
const namespace = process.env.DEPLOYMENTS_NAMESPACE;
if (!key || !namespace || !process.env.SANDBOX_TOKEN) throw new Error('GW, KEY, DEPLOYMENTS_NAMESPACE and SANDBOX_TOKEN are required (see README.md)');

const limit = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const MAX_COLD_S = limit('STRESS_MAX_COLD_S', 300);
const MIN_OK_PCT = limit('STRESS_MIN_OK_PCT', 99);
const MAX_TTFT_MS = limit('STRESS_MAX_TTFT_MS', 500);
const TIMEOUT_S = limit('STRESS_TIMEOUT_S', 90);
const MAX_RECOVERY_S = limit('STRESS_MAX_RECOVERY_S', 420);
const MAX_USD = limit('STRESS_MAX_USD', 1);
const DEP = 'stress-llm';
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${gw}${path}`, {
    method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.json() as Promise<Record<string, any>>;
}

function vast(...args: string[]): any {
  const out = Bun.spawnSync(['bun', join(here, 'vast.ts'), ...args], { env: process.env });
  if (out.exitCode !== 0) throw new Error(`vast.ts ${args.join(' ')}: ${out.stderr.toString().slice(0, 300)}`);
  return JSON.parse(out.stdout.toString());
}

async function load(levels: string, seconds: number, timeout = TIMEOUT_S): Promise<any[]> {
  const proc = Bun.spawn(['bun', join(here, 'load.ts'), '--deployment', DEP, '--levels', levels, '--seconds', String(seconds), '--timeout', String(timeout)],
    { env: process.env, stdout: 'pipe' });
  const lines = (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const l of lines) console.log(JSON.stringify(l));
  return lines;
}

const replicas = async () => ((await api('GET', `/v1/deployments/${DEP}`)).replicas ?? []) as Array<{ id: string; phase: string; pricePerHour: number | null }>;
const spentAt: Record<string, { since: number; eurPerHour: number }> = {};
let spentEur = 0;
async function meter() {
  const now = Date.now();
  const live = await replicas();
  for (const r of live) spentAt[r.id] ??= { since: now, eurPerHour: r.pricePerHour ?? 0 };
  for (const [id, s] of Object.entries(spentAt)) {
    if (live.some(r => r.id === id)) continue;
    spentEur += ((now - s.since) / 3_600_000) * s.eurPerHour;
    delete spentAt[id];
  }
}
const meterTimer = setInterval(() => { void meter().catch(() => {}); }, 10_000);

async function until(what: string, ok: () => Promise<boolean>, seconds: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    if (await ok().catch(() => false)) return (Date.now() - started) / 1000;
    await Bun.sleep(5000);
  }
  console.log(`timeout waiting for ${what}`);
  return null;
}

const before = vast('balance');
console.log(JSON.stringify({ balanceBefore: before }));
check(vast('list').mine.length === 0, `no instance of ${namespace} before the run`);
const spec = JSON.parse(readFileSync(join(here, 'llm.json'), 'utf8'));
await api('PUT', `/v1/deployments/${DEP}`, { ...spec, minReplicas: 0, maxReplicas: 1 });

try {
  const [burst] = await load('10', 1, MAX_COLD_S);
  check(burst.ok === 10, `cold burst: 10/10 answered within ${MAX_COLD_S}s (got ${burst.ok}, ttft p50 ${burst.ttftMs.p50} ms)`);
  check(vast('list').mine.filter((m: { deployment: string }) => m.deployment === DEP).length <= 1, 'cold burst rented at most one machine');

  const ramp = await load('1,4,16,64', 90);
  check(ramp.filter(r => r.concurrency <= 16).every(r => r.successRate >= MIN_OK_PCT), `ramp: success ≥ ${MIN_OK_PCT}% up to 16`);
  check(ramp[0].ttftMs.p95 <= MAX_TTFT_MS, `ramp: TTFT p95 at 1 ≤ ${MAX_TTFT_MS} ms (got ${ramp[0].ttftMs.p95})`);
  check(ramp.every(r => r.clientTimeouts === 0), 'ramp: no request hung past the client timeout');

  const [victim] = await replicas();
  const flowing = load('8', 150, 300);
  await Bun.sleep(30_000);
  console.log(JSON.stringify(vast('destroy', victim.id)));
  const recovered = await until('a ready replacement', async () => (await replicas()).some(r => r.id !== victim.id && r.phase === 'ready'), MAX_RECOVERY_S);
  const [during] = await flowing;
  check(recovered !== null, `out-of-band destroy: ready replacement in ${recovered ?? '>' + MAX_RECOVERY_S}s`);
  check(during.clientTimeouts === 0, `out-of-band destroy: no caller hung (errors: ${JSON.stringify(during.errors)})`);
  check(!(await replicas()).some(r => r.id === victim.id), 'out-of-band destroy: no ghost replica in the state');
} finally {
  await api('DELETE', `/v1/deployments/${DEP}`);
  await until('the namespace to be empty at the provider', async () => vast('list').mine.length === 0, 180);
  await meter();
  for (const s of Object.values(spentAt)) spentEur += ((Date.now() - s.since) / 3_600_000) * s.eurPerHour;
  clearInterval(meterTimer);
}

const after = vast('balance');
const left = vast('list').mine;
const spentUsd = spentEur * 1.08;
console.log(JSON.stringify({ balanceAfter: after, balanceDeltaUsd: before.credit - after.credit, gatewaySpendUsd: Math.round(spentUsd * 1000) / 1000, left }));
check(left.length === 0, 'nothing left rented at the provider');
check(spentUsd <= MAX_USD, `spend ≤ US$${MAX_USD} (gateway price × time: US$${spentUsd.toFixed(3)})`);
console.log(failures.length ? `FAILED: ${failures.length} check(s)` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
