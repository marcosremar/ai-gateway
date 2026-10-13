/**
 * A stand-in for serve.ts: a node:http server whose own listeners play the proxy (API-key auth → 401, no-wake header,
 * the `POST /v1/realtime/sessions` custom route), with `createRealtime(...).mount` placed in front, as in production.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createRealtime, type CreateRealtimeOptions } from '../../../src/realtime';
import { runNoWake } from '../../../src/gateway/proxy/no-wake';
import type { AppLimitDenial } from '../../../src/gateway/proxy/app-limits';
import type { GatewayTelemetryEvent } from '../../../src/realtime';

export const KEYS: Record<string, string> = { 'key-parle': 'parle', 'key-other': 'other', 'key-admin': 'admin' };

export interface TestGateway {
  url: string;
  server: Server;
  realtime: ReturnType<typeof createRealtime>;
  charged: Array<[string, number]>;
  events: GatewayTelemetryEvent[];
  create(body: unknown, opts?: { key?: string; noWake?: boolean; traceparent?: string }): Promise<Response>;
  close(): Promise<void>;
}

export async function startGateway(
  controller: CreateRealtimeOptions['controller'],
  extra: Partial<CreateRealtimeOptions> & { deny?: AppLimitDenial } = {},
): Promise<TestGateway> {
  const charged: Array<[string, number]> = [];
  const events: GatewayTelemetryEvent[] = [];
  const realtime = createRealtime({
    controller,
    env: { REALTIME_TURN_URLS: 'turn:198.51.100.7:3478?transport=udp', REALTIME_TURN_SECRET: 'turn-secret' },
    userOf: (req) => KEYS[String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')] ?? null,
    isAdmin: (u) => u === 'admin',
    charge: (u, n) => { charged.push([u, n]); return extra.deny ?? null; },
    pollMs: 0,
    turnCheckMs: 0,
    telemetry: (e) => events.push(e),
    ...extra,
  });
  const server = createServer((req, res) => {
    const user = KEYS[String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')];
    if (!user) { res.writeHead(401); res.end('{"error":"proxy auth"}'); return; }
    if (req.method === 'POST' && req.url === '/v1/realtime/updates') { void realtime.updateRoute.handler(req, res); return; }
    if (req.method === 'POST' && req.url === '/v1/realtime/sessions') {
      const run = () => realtime.route.handler(req, res);
      void (req.headers['x-gateway-no-wake'] ? runNoWake(run) : run());
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n'); });
  realtime.mount(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, server, realtime, charged, events,
    create: (body, opts = {}) => fetch(`${url}/v1/realtime/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.key ?? 'key-parle'}`, 'Content-Type': 'application/json',
        ...(opts.noWake ? { 'X-Gateway-No-Wake': '1' } : {}),
        ...(opts.traceparent ? { traceparent: opts.traceparent } : {}),
      },
      body: JSON.stringify(body),
    }),
    close: async () => {
      realtime.stop();
      server.closeAllConnections?.();
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}
