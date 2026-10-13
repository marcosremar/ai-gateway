/**
 * Application-level RTT probe for GPU hosts.
 *
 * A bare TCP connect time is not trustworthy: transparent proxies, NAT
 * gateways and sandboxed egress complete the handshake locally (we measured
 * "5 ms" to unroutable TEST-NET addresses from a proxied container). This
 * probe only counts a sample when the remote end actually sends bytes back:
 *   - port 22: the SSH server greets first ("SSH-2.0-…"), nothing to send
 *   - other ports: a minimal HTTP request; any response byte counts
 * The RTT is the time from "connected" to the first byte, i.e. one real
 * round trip to whatever answered.
 *
 * Intercepting proxies can also answer HTTP themselves (a sandbox proxy
 * replied on 80/443 for unroutable IPs in ~2 ms). So each port is first
 * checked against a canary address that is never routed on the internet
 * (TEST-NET-3, RFC 5737): if the canary "answers" on a port, that port is
 * intercepted on this network and its samples are discarded.
 */

import net from 'net';

export interface RttProbeResult {
  medianMs: number | null;
  p90Ms: number | null;
  samples: number;
  port: number | null;
  /** Ports skipped because this network answers them for any address. */
  interceptedPorts?: number[];
}

/** Never routed on the public internet (RFC 5737). */
export const RTT_CANARY_IP = '203.0.113.1';

export interface RttProbeOptions {
  /** Address used to detect intercepted ports (tests point it at localhost). */
  canaryIp?: string;
}

/** One sample: ms from connect to first response byte, or null (no real answer). */
export function probeRttOnce(ip: string, port: number, timeoutMs = 3_000): Promise<number | null> {
  return new Promise((resolve) => {
    let connectedAt = 0;
    let done = false;
    const socket = net.createConnection({ host: ip, port });
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('connect', () => {
      connectedAt = performance.now();
      if (port !== 22) socket.write(`HEAD / HTTP/1.0\r\nHost: ${ip}\r\n\r\n`);
    });
    socket.once('data', (chunk: Buffer) => {
      // An SSH server greets with "SSH-…"; anything else on 22 is a middlebox.
      if (port === 22 && !chunk.toString('latin1').startsWith('SSH-')) return finish(null);
      finish(connectedAt ? performance.now() - connectedAt : null);
    });
    socket.once('end', () => finish(null));   // closed without a byte — not proof of a real host
    socket.once('error', () => finish(null));
  });
}

const interceptCache = new Map<string, Promise<boolean>>();

/** True when `canaryIp` "answers" on `port` — i.e. the network fakes that port. */
export function isPortIntercepted(port: number, canaryIp = RTT_CANARY_IP, timeoutMs = 1_500): Promise<boolean> {
  const key = `${canaryIp}:${port}`;
  let hit = interceptCache.get(key);
  if (!hit) {
    hit = probeRttOnce(canaryIp, port, timeoutMs).then((ms) => ms !== null);
    interceptCache.set(key, hit);
  }
  return hit;
}

/** Test hook. */
export function _resetInterceptCacheForTests(): void { interceptCache.clear(); }

/**
 * Probe several ports in parallel, `count` samples each, and keep the port
 * with the most real answers (ties → lowest median). Ports this network
 * intercepts are skipped.
 */
export async function probeRtt(
  ip: string, ports: number[], count = 5, timeoutMs = 3_000, opts: RttProbeOptions = {},
): Promise<RttProbeResult> {
  const unique = [...new Set(ports)];
  const intercepted = await Promise.all(unique.map((p) => isPortIntercepted(p, opts.canaryIp)));
  const interceptedPorts = unique.filter((_, i) => intercepted[i]);
  const usable = unique.filter((_, i) => !intercepted[i]);
  const perPort = await Promise.all(usable.map(async (port) => {
    const ok = (await Promise.all(Array.from({ length: count }, () => probeRttOnce(ip, port, timeoutMs))))
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    return { port, ok };
  }));
  const best = perPort
    .filter((p) => p.ok.length > 0)
    .sort((a, b) =>
      b.ok.length !== a.ok.length
        ? b.ok.length - a.ok.length
        : a.ok[Math.floor(a.ok.length / 2)] - b.ok[Math.floor(b.ok.length / 2)],
    )[0];
  const extra = interceptedPorts.length > 0 ? { interceptedPorts } : {};
  if (!best) return { medianMs: null, p90Ms: null, samples: 0, port: null, ...extra };
  const { ok } = best;
  return {
    medianMs: Math.round(ok[Math.floor(ok.length / 2)]),
    p90Ms: Math.round(ok[Math.min(Math.ceil(ok.length * 0.9) - 1, ok.length - 1)]),
    samples: ok.length,
    port: best.port,
    ...extra,
  };
}

export function connectRttOnce(ip: string, port: number, timeoutMs = 2_000): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.createConnection({ host: ip, port });
    const finish = (value: number | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('connect', () => finish(performance.now() - started));
    socket.once('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ECONNREFUSED' ? performance.now() - started : null));
  });
}

export async function probeConnectRtt(
  ip: string, port: number, count = 5, timeoutMs = 2_000, opts: RttProbeOptions = {},
): Promise<number | null> {
  if ((await connectRttOnce(opts.canaryIp ?? RTT_CANARY_IP, port, 1_500)) !== null) return null;
  const ok = (await Promise.all(Array.from({ length: count }, () => connectRttOnce(ip, port, timeoutMs)))).filter((v): v is number => v !== null);
  return ok.length ? Math.round(Math.min(...ok)) : null;
}
