import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { nginxConfig } from '../../../src/deployments/cloud-init';
import { createWsTransport } from '../../../sdk/browser/realtime/transports/ws';
import { fakeController, startFakeEdge, type FakeEdge } from '../realtime/_fakes';
import { startGateway, type TestGateway } from '../realtime/_gateway';

const CONFIG = { system: 'Tu es Lia. Segredo do prompt.', voice: 'lia', deployment: 'speech' };

function open(url: string, protocols?: string[]) {
  return new Promise<{ ws: WebSocket; protocol: string }>((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.on('open', () => resolve({ ws, protocol: ws.protocol }));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.on('error', reject);
  });
}

describe('audit 2026-10-09 #19: the realtime session token stays out of URLs and access logs', () => {
  let edge: FakeEdge;
  let gw: TestGateway;
  beforeEach(async () => {
    edge = await startFakeEdge();
    gw = await startGateway(fakeController({ replicas: [{ id: 'r1', ip: edge.host }] }).controller);
  });
  afterEach(async () => { await gw.close(); await edge.close(); });

  const session = async () => (await (await gw.create({ config: CONFIG })).json()) as { token: string; transports: Array<{ type: string; url?: string }> };

  it('the gateway hands the token to the replica in a header, never in the URL', async () => {
    const s = await session();
    const { ws } = await open(s.transports.find(t => t.type === 'ws')!.url!);
    ws.close();
    expect(edge.wsUrls).toHaveLength(1);
    expect(edge.wsUrls[0]).not.toContain('token=');
    expect(edge.wsUrls[0]).not.toContain(s.token.split('.')[1]!);
  });

  it('a browser may send the token as a WebSocket subprotocol instead of the query (old ?token= clients still work)', async () => {
    const s = await session();
    const base = `${gw.url.replace('http', 'ws')}/v1/realtime/ws`;
    const viaProtocol = await open(base, ['aigw.rt', `aigw.token.${s.token}`]);
    expect(viaProtocol.protocol).toBe('aigw.rt');
    viaProtocol.ws.close();
    const s2 = await session();
    const viaQuery = await open(s2.transports.find(t => t.type === 'ws')!.url!);
    viaQuery.ws.close();
    await expect(open(base, ['aigw.rt', 'aigw.token.forged.token.here'])).rejects.toMatchObject({ status: 401 });
  });

  it('the browser SDK connects with the subprotocol and a URL without the token', async () => {
    const seen: Array<{ url: string; protocols?: string | string[] }> = [];
    class FakeWS { binaryType = ''; readyState = 0; bufferedAmount = 0; onopen: (() => void) | null = null; onerror: (() => void) | null = null;
      onmessage = null; onclose = null;
      constructor(url: string, protocols?: string | string[]) { seen.push({ url, protocols }); setTimeout(() => this.onerror?.(), 0); }
      send() {} close() {} }
    const ctx = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', timeouts: { wsOpenMs: 1000 }, mic: async () => null,
      emit: () => {}, dropped: () => {} } as never;
    const t = createWsTransport(ctx, 'wss://gw.example/v1/realtime/ws?token=aaa.bbb.ccc', { WebSocket: FakeWS as never });
    await t.connect(new AbortController().signal).catch(() => {});
    expect(seen[0]!.url).not.toContain('token=');
    expect(seen[0]!.protocols).toEqual(['aigw.rt', 'aigw.token.aaa.bbb.ccc']);
  });
});

describe('audit 2026-10-09 #19: the replica nginx does not log the WS request line', () => {
  it('the WS location has its own access/error logging off and takes the token from the header', () => {
    const conf = nginxConfig('t'.repeat(32), 80, 8000, 8765);
    const ws = /location = \/__aigw\/rt\/ws \{([\s\S]*?)\n {2}\}/.exec(conf)?.[1] ?? '';
    expect(ws).toContain('access_log off;');
    expect(ws).toMatch(/error_log \/dev\/null crit;/);
    expect(ws).toContain('proxy_pass http://127.0.0.1:8765/__aigw/rt/ws?$aigw_ws_args;');
    expect(conf).toMatch(/map \$http_x_aigw_session_token \$aigw_ws_args \{ "" \$args; default "token=\$http_x_aigw_session_token"; \}/);
  });
});
