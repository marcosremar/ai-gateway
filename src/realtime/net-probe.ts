/**
 * Reachability of a replica's WebRTC media, checked from outside (docker/aigw-edge/aigw_edge/netcheck.py):
 *
 *   1. UDP echo to the edge's probe port (the last port of its media range, opened by the same firewall rule): a reply
 *      means a browser's UDP can get in → path `direct`.
 *   2. The result goes to the edge (`POST /__aigw/rt/net`, behind the token gate) with short-lived TURN credentials;
 *      when inbound UDP is blocked the edge tries to allocate a relay OUTBOUND (UDP, TCP, TLS) → path `relay`.
 *   3. Nothing works → path `ws`: the edge stops listing `webrtc`, so admission offers the WebSocket rung (through this
 *      gateway, the reverse-proxy path, the slowest) without a doomed 5 s ICE attempt.
 *
 * Every probe is logged (`rt.net.probe`) with the result and the edge's path and reasons.
 */
import { createSocket } from 'dgram';
import { randomBytes } from 'crypto';

export type UdpProbeResult = { result: 'ok' | 'blocked'; rttMs: number | null; tries: number };

const PROBE = Buffer.from('AIGWP1');
const REPLY = Buffer.from('AIGWR1');

/** Sends `tries` probes `gapMs` apart; the first matching echo wins. UDP is lossy: one lost datagram is not "blocked". */
export function probeUdp(host: string, port: number, opts: { tries?: number; gapMs?: number; timeoutMs?: number } = {}): Promise<UdpProbeResult> {
  const tries = opts.tries ?? 3, gapMs = opts.gapMs ?? 300, timeoutMs = opts.timeoutMs ?? 1_500;
  return new Promise((resolve) => {
    const nonce = randomBytes(16);
    const socket = createSocket(host.includes(':') ? 'udp6' : 'udp4');
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let sent = 0, started = 0, done = false;
    const finish = (r: UdpProbeResult) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      try { socket.close(); } catch { /* closed */ }
      resolve(r);
    };
    socket.on('message', (msg) => {
      if (msg.length === REPLY.length + nonce.length && msg.subarray(0, REPLY.length).equals(REPLY) && msg.subarray(REPLY.length).equals(nonce)) {
        finish({ result: 'ok', rttMs: Math.round(performance.now() - started), tries: sent });
      }
    });
    socket.on('error', () => finish({ result: 'blocked', rttMs: null, tries: sent }));
    const send = () => {
      if (done) return;
      if (!started) started = performance.now();
      sent++;
      socket.send(Buffer.concat([PROBE, nonce]), port, host, () => {});
    };
    for (let i = 0; i < tries; i++) timers.push(setTimeout(send, i * gapMs));
    timers.push(setTimeout(() => finish({ result: 'blocked', rttMs: null, tries: sent }), (tries - 1) * gapMs + timeoutMs));
  });
}
