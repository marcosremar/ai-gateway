#!/usr/bin/env bun
import { createServer, type OutgoingHttpHeaders, type ServerResponse } from 'http';
import { networkInterfaces } from 'os';
import { ADMIN_COOKIE, createAdminPage } from '../src/admin-page';
import { demoContainerLog, demoSnapshot, demoStates, type DemoState } from '../__tests__/__fixtures__/admin-snapshot';

const key = process.env.ADMIN_DEMO_KEY?.trim();
if (!key) throw new Error('ADMIN_DEMO_KEY is required: the admin key the demo login accepts');
const appKey = process.env.ADMIN_DEMO_APP_KEY?.trim() || null;
const port = Number(process.env.PORT || 4100);
const state = (process.env.ADMIN_DEMO_STATE || 'warn') as DemoState;
if (!demoStates.includes(state)) throw new Error(`ADMIN_DEMO_STATE must be one of ${demoStates.join(', ')}`);

const DEMO_COOKIE = 'aigw_demo';
const dismissed: Record<string, number> = {};
const gpuTypes: Record<string, { machineType: string | null; at: number }> = {};
const trials: Record<string, { machineType: string; at: number }> = {};
const TRIAL_DEMO_MS = 45_000;

function withGpuTypes(snapshot: ReturnType<typeof demoSnapshot>): ReturnType<typeof demoSnapshot> {
  for (const d of snapshot.gpus ?? []) {
    const set = gpuTypes[d.name];
    if (!set || !d.gpuType) continue;
    d.gpuType = { ...d.gpuType, current: set.machineType ?? d.gpuType.default, setBy: set.machineType ? 'marcos' : null,
      setAt: set.machineType ? new Date(set.at).toISOString() : null };
  }
  for (const [name, t] of Object.entries(trials)) {
    const v = snapshot.gpuValidation?.[name];
    if (!v) continue;
    const running = Date.now() - t.at < TRIAL_DEMO_MS;
    const startedAt = new Date(t.at).toISOString();
    v.trial = running ? { machineType: t.machineType, deployment: v.testCopy!, by: 'marcos', startedAt, deadline: new Date(t.at + 40 * 60_000).toISOString() } : null;
    if (running) v.trialRefusal = `já há um teste em curso: ${t.machineType}`;
    v.types = v.types.map(x => (x.machineType !== t.machineType || running ? x : {
      ...x, failed: null, validated: { at: new Date(t.at + TRIAL_DEMO_MS).toISOString(), deployment: v.testCopy!, country: 'NL', checkMs: 1380, seed: null },
    }));
  }
  return snapshot;
}

const page = createAdminPage({
  actorOf: (given) => {
    if (given === key) return { name: 'marcos', app: null };
    if (appKey && given === appKey) return { name: 'parle', app: 'parle', mayPark: () => true };
    return null;
  },
  snapshot: () => ({ ...withGpuTypes(demoSnapshot(Date.now(), state)), dismissed }),
  gpuType: async (name, machineType) => { gpuTypes[name] = { machineType, at: Date.now() }; },
  gpuTest: async (name, machineType) => { trials[name] = { machineType, at: Date.now() }; },
  dismiss: async (id) => { dismissed[id] = Date.now() + 7 * 86_400_000; },
  park: async () => {},
  probe: async () => {},
  sendDigest: async () => { console.log('demo: digest not mailed (no mailer in the demo)'); return 'demo'; },
  secrets: () => (appKey ? [key, appKey] : [key]),
  containerLog: async (name) => demoContainerLog(name, Date.now()),
});

function plainHttpCookie(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const cookie = headers['Set-Cookie'];
  if (typeof cookie !== 'string') return headers;
  return { ...headers, 'Set-Cookie': cookie.replace(`${ADMIN_COOKIE}=`, `${DEMO_COOKIE}=`).replace('; Secure', '') };
}

function servePlainHttp(res: ServerResponse): void {
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  res.writeHead = ((...args: unknown[]) =>
    writeHead(...args.map(a => (a && typeof a === 'object' && !Array.isArray(a) ? plainHttpCookie(a as OutgoingHttpHeaders) : a)))) as typeof res.writeHead;
}

const server = createServer((req, res) => {
  req.headers.cookie = req.headers.cookie?.split(/;\s*/)
    .filter(c => !c.startsWith(`${ADMIN_COOKIE}=`))
    .map(c => c.replace(`${DEMO_COOKIE}=`, `${ADMIN_COOKIE}=`))
    .join('; ');
  servePlainHttp(res);
  if (page.handle(req, res)) return;
  res.writeHead(302, { Location: '/admin' });
  res.end();
});

const lanAddress = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal)?.address;
server.listen(port, '0.0.0.0', () => console.log(
  `admin demo (simulated state "${state}"${appKey ? ', app key signs in as parle' : ''}, no provider keys): `
  + `http://localhost:${port}/admin${lanAddress ? ` · http://${lanAddress}:${port}/admin` : ''}`,
));
