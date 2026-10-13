#!/usr/bin/env bun
import { createServer, type OutgoingHttpHeaders, type ServerResponse } from 'http';
import { networkInterfaces } from 'os';
import { ADMIN_COOKIE, createAdminPage } from '../src/admin-page';
import { demoSnapshot, demoStates, type DemoState } from '../__tests__/__fixtures__/admin-snapshot';

const key = process.env.ADMIN_DEMO_KEY?.trim();
if (!key) throw new Error('ADMIN_DEMO_KEY is required: the admin key the demo login accepts');
const appKey = process.env.ADMIN_DEMO_APP_KEY?.trim() || null;
const port = Number(process.env.PORT || 4100);
const state = (process.env.ADMIN_DEMO_STATE || 'warn') as DemoState;
if (!demoStates.includes(state)) throw new Error(`ADMIN_DEMO_STATE must be one of ${demoStates.join(', ')}`);

const DEMO_COOKIE = 'aigw_demo';
const dismissed: Record<string, number> = {};

const page = createAdminPage({
  actorOf: (given) => {
    if (given === key) return { name: 'marcos', app: null };
    if (appKey && given === appKey) return { name: 'parle', app: 'parle', mayPark: () => true };
    return null;
  },
  snapshot: () => ({ ...demoSnapshot(Date.now(), state), dismissed }),
  dismiss: async (id) => { dismissed[id] = Date.now() + 7 * 86_400_000; },
  park: async () => {},
  probe: async () => {},
  sendDigest: async () => { console.log('demo: digest not mailed (no mailer in the demo)'); return 'demo'; },
  secrets: () => (appKey ? [key, appKey] : [key]),
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
