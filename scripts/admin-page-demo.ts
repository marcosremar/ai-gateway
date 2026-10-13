#!/usr/bin/env bun
import { createServer } from 'http';
import { createAdminPage } from '../src/admin-page';
import { demoSnapshot, demoStates, type DemoState } from '../__tests__/__fixtures__/admin-snapshot';

const key = process.env.ADMIN_DEMO_KEY?.trim();
if (!key) throw new Error('ADMIN_DEMO_KEY is required: the admin key the demo login accepts');
const appKey = process.env.ADMIN_DEMO_APP_KEY?.trim() || null;
const port = Number(process.env.PORT || 4100);
const state = (process.env.ADMIN_DEMO_STATE || 'warn') as DemoState;
if (!demoStates.includes(state)) throw new Error(`ADMIN_DEMO_STATE must be one of ${demoStates.join(', ')}`);

const server = createServer((_req, res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end('{"error":"unauthorized"}');
});
createAdminPage({
  actorOf: (given) => {
    if (given === key) return { name: 'marcos', app: null };
    if (appKey && given === appKey) return { name: 'parle', app: 'parle', mayPark: () => true };
    return null;
  },
  snapshot: () => demoSnapshot(Date.now(), state),
  park: async () => {},
  probe: async () => {},
  secrets: () => (appKey ? [key, appKey] : [key]),
}).mount(server);
server.listen(port, '127.0.0.1', () => console.log(`admin demo on http://localhost:${port}/admin (simulated state "${state}"${appKey ? ', app key signs in as parle' : ''}, no provider keys)`));
