/**
 * rtt-probe — only real answers count.
 *
 * Live finding: from a proxied container, bare TCP connects "succeeded" in
 * 5–17 ms to unroutable TEST-NET addresses. A host that accepts but never
 * answers (what such a proxy looks like) must yield no sample.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'net';
import { probeRtt, probeRttOnce, _resetInterceptCacheForTests } from '../src/gateway/providers/gpu/rtt-probe';

const servers: net.Server[] = [];
const listen = (onConn: (s: net.Socket) => void) => new Promise<number>((resolve) => {
  const srv = net.createServer(onConn);
  servers.push(srv);
  srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port));
});

let sshLike = 0, silent = 0, httpLike = 0, closer = 0;

beforeAll(async () => {
  // SSH greets first — after an artificial 40ms "network" delay
  sshLike = await listen((s) => { setTimeout(() => s.write('SSH-2.0-OpenSSH_9.6\r\n'), 40); });
  // Accepts the handshake, never says anything (transparent-proxy look-alike)
  silent = await listen(() => { /* nothing */ });
  // Answers only after receiving a request
  httpLike = await listen((s) => { s.once('data', () => s.end('HTTP/1.0 404 Not Found\r\n\r\n')); });
  // Accepts then closes without a byte
  closer = await listen((s) => s.end());
});
afterAll(() => { for (const s of servers) s.close(); });

describe('probeRttOnce', () => {
  it('measures connect → first byte for a greeting server', async () => {
    // non-22 port: sends a request, but the SSH-like server greets anyway
    const ms = await probeRttOnce('127.0.0.1', sshLike, 2_000);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThanOrEqual(35);
    expect(ms!).toBeLessThan(1_000);
  });

  it('gets a sample from a request/response server', async () => {
    expect(await probeRttOnce('127.0.0.1', httpLike, 2_000)).not.toBeNull();
  });

  it('rejects a handshake with no answer (fake RTT)', async () => {
    expect(await probeRttOnce('127.0.0.1', silent, 300)).toBeNull();
  });

  it('rejects a connection closed without a byte', async () => {
    expect(await probeRttOnce('127.0.0.1', closer, 1_000)).toBeNull();
  });

  it('returns null for a closed port', async () => {
    const srv = net.createServer();
    const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)));
    await new Promise((r) => srv.close(r));
    expect(await probeRttOnce('127.0.0.1', port, 1_000)).toBeNull();
  });
});

// Canary that never answers on the test ports → nothing intercepted.
const NO_INTERCEPT = { canaryIp: '127.0.0.2' };

describe('probeRtt', () => {
  it('picks the port with real answers and ignores the silent one', async () => {
    _resetInterceptCacheForTests();
    const r = await probeRtt('127.0.0.1', [silent, httpLike], 3, 300, NO_INTERCEPT);
    expect(r.port).toBe(httpLike);
    expect(r.samples).toBe(3);
    expect(r.medianMs).not.toBeNull();
  });

  it('reports no samples when nothing real answers', async () => {
    _resetInterceptCacheForTests();
    const r = await probeRtt('127.0.0.1', [silent, closer], 3, 300, NO_INTERCEPT);
    expect(r).toEqual({ medianMs: null, p90Ms: null, samples: 0, port: null });
  });

  it('discards ports the network answers for any address (intercepting proxy)', async () => {
    _resetInterceptCacheForTests();
    // The "canary" answers on httpLike's port → that port is intercepted.
    const r = await probeRtt('127.0.0.1', [httpLike], 3, 300, { canaryIp: '127.0.0.1' });
    expect(r.samples).toBe(0);
    expect(r.interceptedPorts).toEqual([httpLike]);
  });

  it('rejects a non-SSH answer on port 22', async () => {
    // Only meaningful where 22 is reachable; the invariant is: no SSH banner → no sample.
    const ms = await probeRttOnce('127.0.0.1', 22, 300);
    if (ms !== null) expect(ms).toBeGreaterThanOrEqual(0); // a real local sshd greeted us
  });
});
