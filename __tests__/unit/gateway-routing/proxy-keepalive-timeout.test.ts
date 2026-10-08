import type { Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/logger', async (original) => ({
  ...(await original<typeof import('../../../src/logger')>()),
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), warn, error: vi.fn() }),
}));

import { createProxyServer } from '../../../src/gateway/proxy/server';

const TOTAL_TIMEOUT_MS = 300;
const KILLED = 'Request killed by total timeout';
const killWarnings = () => warn.mock.calls.filter((call) => call[1] === KILLED);

let server: Server;
let client: Socket;

async function send(path: string): Promise<{ closed: Promise<void>; answered: Promise<void> }> {
  const port = (server.address() as AddressInfo).port;
  client = connect(port, '127.0.0.1');
  const closed = new Promise<void>((r) => client.once('close', () => r()));
  const answered = new Promise<void>((r) => client.once('data', () => r()));
  client.on('error', () => {});
  client.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
  return { closed, answered };
}

beforeEach(async () => {
  warn.mockClear();
  process.env.PROXY_TOTAL_TIMEOUT_MS = String(TOTAL_TIMEOUT_MS);
  server = createProxyServer({
    providers: {} as never,
    customRoutes: [{ method: 'GET', path: '/stalled', handler: () => new Promise<void>(() => {}) }],
  });
  server.keepAliveTimeout = 100;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});

afterEach(async () => {
  delete process.env.PROXY_TOTAL_TIMEOUT_MS;
  client.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('total request timeout on the proxy socket', () => {
  it('closes an idle keep-alive socket after a completed request without warning', async () => {
    const { answered, closed } = await send('/health');
    await answered;
    await closed;
    expect(killWarnings()).toHaveLength(0);
  });

  it('warns and destroys the socket of a request that never answers', async () => {
    const { closed } = await send('/stalled');
    await closed;
    expect(killWarnings()).toHaveLength(1);
  });
});
