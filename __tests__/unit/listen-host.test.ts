import { readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ALL_INTERFACES, listenHost, LOOPBACK } from '../../src/config/listen-host';
import { startProxy } from '../../src/gateway/proxy/server';

const RAILWAY = { RAILWAY_ENVIRONMENT: 'production' };

/** A port nobody listens on (startProxy reads port 0 as 4000, where another gateway of this machine may run). */
const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer().listen(0, ALL_INTERFACES, () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

describe('where serve.ts listens (QA parle 16/10/2026: 0.0.0.0 with no client key let the LAN reach the Mac models)', () => {
  it('off Railway: this machine only, unless GATEWAY_HOST says otherwise', () => {
    expect(listenHost({})).toBe(LOOPBACK);
    expect(listenHost({ GATEWAY_HOST: '  ' })).toBe(LOOPBACK);
    expect(listenHost({ GATEWAY_HOST: ' 0.0.0.0 ' })).toBe(ALL_INTERFACES);
    expect(listenHost({ GATEWAY_HOST: '::' })).toBe('::');
  });

  it('on Railway: every interface, as published, whatever GATEWAY_HOST says', () => {
    expect(listenHost(RAILWAY)).toBe(ALL_INTERFACES);
    expect(listenHost({ RAILWAY_PROJECT_ID: 'p' })).toBe(ALL_INTERFACES);
    expect(listenHost({ RAILWAY_ENVIRONMENT_ID: 'e', GATEWAY_HOST: '127.0.0.1' })).toBe(ALL_INTERFACES);
  });

  it('serve.ts binds the proxy to listenHost, never to a literal address; the images keep 0.0.0.0', () => {
    const serve = readFileSync('serve.ts', 'utf8');
    expect(serve).toMatch(/const HOST = listenHost\(process\.env\);/);
    expect(serve).toMatch(/startProxy\(\{\n {2}port: PORT,\n {2}hostname: HOST,/);
    expect(serve).not.toMatch(/hostname: '0\.0\.0\.0'/);
    for (const file of ['Dockerfile', 'Dockerfile.production']) expect(readFileSync(file, 'utf8')).toMatch(/^ENV GATEWAY_HOST=0\.0\.0\.0$/m);
  });

  it('a proxy on the default host answers on loopback and refuses a connection to another address of this machine', async () => {
    const lan = Object.values(networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
    const port = await freePort();
    const server = await startProxy({ port, hostname: listenHost({}), providers: {} } as never);
    try {
      expect(server.address()).toMatchObject({ address: LOOPBACK, port });
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      if (lan) {
        const reached = await new Promise<boolean>((resolve) => {
          const socket = connect({ host: lan, port });
          socket.once('connect', () => { socket.destroy(); resolve(true); });
          socket.once('error', () => resolve(false));
        });
        expect(reached).toBe(false);
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
