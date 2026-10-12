#!/usr/bin/env bun
import { createServer } from 'http';
import { createAdminPage } from '../src/admin-page';
import { demoSnapshot } from '../__tests__/__fixtures__/admin-snapshot';

const key = process.env.ADMIN_DEMO_KEY?.trim();
if (!key) throw new Error('ADMIN_DEMO_KEY is required: the admin key the demo login accepts');
const port = Number(process.env.PORT || 4100);

const server = createServer((_req, res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end('{"error":"unauthorized"}');
});
createAdminPage({
  actorOf: (given) => (given === key ? 'marcos' : null),
  snapshot: () => demoSnapshot(Date.now()),
  park: async () => {},
  probe: async () => {},
  secrets: () => [key],
}).mount(server);
server.listen(port, '127.0.0.1', () => console.log(`admin demo on http://localhost:${port}/admin (simulated state, no provider keys)`));
