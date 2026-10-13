/**
 * Fakes for the realtime control-plane tests: a controller (the four methods the service reads) and a fake edge — an
 * HTTP server speaking the replica side of the contract (status, offer, ice, session delete, WS).
 */
import { createServer, type IncomingMessage, type Server } from 'http';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'net';
import type { RealtimeController } from '../../../src/realtime';
import { deriveRealtimeKey, verifySessionToken } from '../../../src/realtime';

export const REPLICA_TOKEN = 'replica-token-for-tests';

export interface FakeReplica { id: string; ip: string | null; phase?: string; draining?: boolean; stagesOut?: string[] }

export function fakeController(opts: { app?: string | null; replicas?: FakeReplica[]; paused?: boolean; exposure?: boolean; spec?: Record<string, unknown> } = {}) {
  const state = {
    app: opts.app === undefined ? 'parle' : opts.app,
    replicas: opts.replicas ?? [],
    woken: 0,
    exists: true,
  };
  const controller: RealtimeController = {
    get: (name: string) => (state.exists && name === 'speech' ? {
      name, app: state.app, spec: { paused: !!opts.paused },
      replicas: state.replicas.map(r => ({ id: r.id, ip: r.ip, phase: r.phase ?? 'ready', draining: !!r.draining, ...(r.stagesOut ? { stagesOut: r.stagesOut } : {}) })),
    } as never : null),
    tokenOf: (name: string) => (state.exists && name === 'speech' ? REPLICA_TOKEN : null),
    specOf: (name: string) => (name === 'speech' ? { exposure: opts.exposure ? {} : undefined, ...opts.spec } as never : null),
    wake: (name: string) => { state.woken++; return { name } as never; },
  };
  return { controller, state };
}

export interface EdgeStatusBody { active: number; max: number; available?: number; transports?: string[]; udpPorts?: [number, number] }

export interface FakeEdge {
  server: Server;
  wss: WebSocketServer;
  host: string;
  status: EdgeStatusBody | null;
  offers: Array<{ body: Record<string, unknown>; token: string | undefined; traceparent?: string }>;
  wsTraceparents: Array<string | undefined>;
  wsUrls: string[];
  ice: Array<Record<string, unknown>>;
  deleted: string[];
  sockets: WsSocket[];
  /** Answer status for the next offers (e.g. 409 full). */
  offerStatus: number;
  wsRefuse: boolean;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); } });
  });
}

export async function startFakeEdge(): Promise<FakeEdge> {
  const edge = {
    status: { active: 0, max: 8, transports: ['webrtc', 'ws'], udpPorts: [40000, 40100] } as EdgeStatusBody | null,
    offers: [], wsTraceparents: [], wsUrls: [], ice: [], deleted: [], sockets: [], offerStatus: 200, wsRefuse: false,
  } as unknown as FakeEdge;
  const server = createServer(async (req, res) => {
    const token = req.headers['x-aigw-token'] as string | undefined;
    if (token !== REPLICA_TOKEN) { res.writeHead(401); res.end(); return; }
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/__aigw/rt/status') {
      if (!edge.status) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(edge.status));
      return;
    }
    if (req.method === 'POST' && url === '/__aigw/rt/offer') {
      const body = await readBody(req);
      edge.offers.push({ body, token, ...(req.headers.traceparent ? { traceparent: req.headers.traceparent as string } : {}) });
      if (edge.offerStatus !== 200) { res.writeHead(edge.offerStatus); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sdp: 'v=0\r\no=edge answer\r\n', type: 'answer', sessionId: 'edge-1' }));
      return;
    }
    if (req.method === 'POST' && url === '/__aigw/rt/ice') {
      edge.ice.push(await readBody(req));
      res.writeHead(204); res.end();
      return;
    }
    if (req.method === 'DELETE' && url.startsWith('/__aigw/rt/session/')) {
      edge.deleted.push(decodeURIComponent(url.slice('/__aigw/rt/session/'.length)));
      res.writeHead(204); res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({
    noServer: true,
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://edge');
    const token = (req.headers['x-aigw-session-token'] as string | undefined) ?? url.searchParams.get('token') ?? '';
    edge.wsUrls.push(req.url ?? '');
    const ok = req.headers['x-aigw-token'] === REPLICA_TOKEN && url.pathname === '/__aigw/rt/ws'
      && 'claims' in verifySessionToken(token, deriveRealtimeKey(REPLICA_TOKEN), Math.floor(Date.now() / 1000));
    if (!ok || edge.wsRefuse) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    edge.wsTraceparents.push(req.headers.traceparent as string | undefined);
    wss.handleUpgrade(req, socket, head, (ws) => {
      edge.sockets.push(ws);
      ws.send(JSON.stringify({ type: 'ready' }));
      ws.on('message', (data, isBinary) => {
        // Echo: text as {type:"echo", data}, binary back as is.
        if (isBinary) ws.send(data as Buffer, { binary: true });
        else ws.send(JSON.stringify({ type: 'echo', data: String(data) }));
      });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  edge.server = server;
  edge.wss = wss;
  edge.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  edge.close = async () => {
    for (const s of edge.sockets) s.terminate();
    wss.close();
    await new Promise<void>(r => server.close(() => r()));
  };
  return edge;
}
