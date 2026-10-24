import { activeWindow, DEFAULT_WARM_TIME_ZONE } from '../src/deployments/autoscale';
import { DECLARED_DEPLOYMENTS } from '../src/deployments/declared';
import type { WarmScheduleEntry } from '../src/deployments/types';

const RAILWAY_UP = ['railway', 'up', '--detach', '--service', 'ai-gateway', '--project', '2213991a-748b-4576-8bd1-f45232f722e3', '--environment', 'production'];
const GATEWAY_URL = 'https://ai-gateway.ucast.me';
const POLL_MS = 10_000;
const LIVE_TIMEOUT_MS = 20 * 60_000;
const PROBE_TIMEOUT_MS = 3 * 60_000;

interface Health {
  commit?: string | null;
  builtAt?: string | null;
  fallbackProbe?: { intervalMinutes: number; ok: number; failing: string[]; links: unknown[] };
}

export function classWindowEndsAt(now: number): number | null {
  const ends = DECLARED_DEPLOYMENTS.map(d => activeWindow(d.spec.warmSchedule as WarmScheduleEntry[] | undefined, now)?.endsAt ?? 0);
  return Math.max(0, ...ends) || null;
}

const parisTime = (t: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_WARM_TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(t);

export function deployBlockers(o: { now: number; duringClass: boolean; dirty: string; head: string; originMain: string }): string[] {
  const blockers: string[] = [];
  const classEnds = classWindowEndsAt(o.now);
  if (classEnds && !o.duringClass) {
    blockers.push(`a parle class window is open until ${parisTime(classEnds)} Paris: a publish restarts the only gateway instance mid-class. Wait, or pass --during-class.`);
  }
  if (o.dirty) blockers.push(`the working tree is not clean (railway up uploads it as it is):\n${o.dirty}`);
  if (o.head !== o.originMain) blockers.push(`HEAD ${o.head.slice(0, 12)} is not origin/main ${o.originMain.slice(0, 12)}: publish main as merged.`);
  return blockers;
}

function exec(cmd: string[], env: Record<string, string | undefined> = process.env): void {
  const { exitCode } = Bun.spawnSync(cmd, { stdio: ['inherit', 'inherit', 'inherit'], env });
  if (exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')} exited ${exitCode}`);
}

function git(...args: string[]): string {
  const { exitCode, stdout } = Bun.spawnSync(['git', ...args], { stderr: 'inherit' });
  if (exitCode !== 0) throw new Error(`git ${args[0]} exited ${exitCode}`);
  return stdout.toString().trim();
}

async function getHealth(path: string, key?: string): Promise<Health | null> {
  try {
    const res = await fetch(GATEWAY_URL + path, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(POLL_MS) });
    return res.ok ? await res.json() as Health : null;
  } catch {
    return null;
  }
}

async function waitFor<T>(probe: () => Promise<T | null | undefined>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await Bun.sleep(POLL_MS);
  }
  return null;
}

async function main(): Promise<void> {
  git('fetch', 'origin', 'main', '--quiet');
  const head = git('rev-parse', 'HEAD');
  const blockers = deployBlockers({
    now: Date.now(), duringClass: process.argv.includes('--during-class'),
    dirty: git('status', '--porcelain'), head, originMain: git('rev-parse', 'origin/main'),
  });
  if (blockers.length) {
    console.error(`deploy:prod refused:\n- ${blockers.join('\n- ')}`);
    process.exit(1);
  }

  try {
    exec(['bun', 'run', 'stamp:build']);
    const env = { ...process.env };
    delete env.RAILWAY_TOKEN;
    exec(RAILWAY_UP, env);
  } finally {
    git('checkout', '--', 'src/build-info.json');
  }

  console.log(`uploaded ${head}; waiting for ${GATEWAY_URL}/health to report it`);
  const live = await waitFor(async () => {
    const health = await getHealth('/health');
    return health?.commit === head ? health : null;
  }, LIVE_TIMEOUT_MS);
  if (!live) {
    console.error(`${head} is not live after ${LIVE_TIMEOUT_MS / 60_000} min: read the Railway build log`);
    process.exit(1);
  }
  console.log(`live: commit ${live.commit}, built ${live.builtAt}`);

  const key = process.env.AI_GATEWAY_ADMIN_KEY;
  if (!key) {
    console.log('fallbackProbe: set AI_GATEWAY_ADMIN_KEY to read it from /health?details=1');
    return;
  }
  const probe = await waitFor(async () => {
    const snapshot = (await getHealth('/health?details=1', key))?.fallbackProbe;
    return snapshot && (snapshot.links.length || snapshot.intervalMinutes <= 0) ? snapshot : null;
  }, PROBE_TIMEOUT_MS);
  console.log(probe
    ? `fallbackProbe: ${probe.ok} ok, failing ${JSON.stringify(probe.failing)} (every ${probe.intervalMinutes} min)`
    : `fallbackProbe: no result after ${PROBE_TIMEOUT_MS / 60_000} min`);
}

if (import.meta.main) await main();
