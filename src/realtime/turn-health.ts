import { createSocket } from 'dgram';
import { connect as tcpConnect } from 'net';
import { connect as tlsConnect } from 'tls';
import { randomBytes } from 'crypto';

export interface TurnTarget {
  url: string;
  host: string;
  port: number;
  transport: 'udp' | 'tcp' | 'tls';
}

export type TurnProbe = (target: TurnTarget, timeoutMs: number) => Promise<{ ok: boolean; rttMs: number | null }>;

export type TurnState = 'unknown' | 'alive' | 'dead';

export interface TurnUrlHealth {
  url: string;
  state: TurnState;
  since: number | null;
  checkedAt: number | null;
  rttMs: number | null;
  failures: number;
}

const MAGIC_COOKIE = 0x2112a442;
const ALLOCATE_REQUEST = 0x0003;
const REQUESTED_TRANSPORT_UDP = Buffer.from([0x00, 0x19, 0x00, 0x04, 17, 0, 0, 0]);
export const TURN_CHECK_TIMEOUT_MS = 2_000;
const UDP_RETRY_MS = 500;

export function parseTurnUrl(url: string): TurnTarget | null {
  const [address = '', query = ''] = url.trim().split('?');
  const [scheme, host, port] = address.split(':');
  if ((scheme !== 'turn' && scheme !== 'turns') || !host) return null;
  const tls = scheme === 'turns';
  return { url, host, port: Number(port) || (tls ? 5349 : 3478), transport: tls ? 'tls' : query === 'transport=tcp' ? 'tcp' : 'udp' };
}

export function allocateRequest(transactionId: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(ALLOCATE_REQUEST, 0);
  header.writeUInt16BE(REQUESTED_TRANSPORT_UDP.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, REQUESTED_TRANSPORT_UDP]);
}

export function isStunReplyTo(message: Buffer, transactionId: Buffer): boolean {
  return message.length >= 20 && (message[0]! & 0xc0) === 0 && message.readUInt32BE(4) === MAGIC_COOKIE && message.subarray(8, 20).equals(transactionId);
}

export const probeTurn: TurnProbe = (target, timeoutMs) => new Promise((resolve) => {
  const transactionId = randomBytes(12);
  const request = allocateRequest(transactionId);
  const started = performance.now();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let release = () => {};
  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    for (const t of timers) clearTimeout(t);
    release();
    resolve({ ok, rttMs: ok ? Math.round(performance.now() - started) : null });
  };
  timers.push(setTimeout(() => finish(false), timeoutMs));
  if (target.transport === 'udp') {
    const socket = createSocket(target.host.includes(':') ? 'udp6' : 'udp4');
    release = () => { try { socket.close(); } catch { return; } };
    socket.on('message', (message) => { if (isStunReplyTo(message, transactionId)) finish(true); });
    socket.on('error', () => finish(false));
    const send = () => { if (!settled) socket.send(request, target.port, target.host, () => {}); };
    send();
    for (let at = UDP_RETRY_MS; at < timeoutMs; at += UDP_RETRY_MS) timers.push(setTimeout(send, at));
    return;
  }
  const socket = target.transport === 'tls'
    ? tlsConnect({ host: target.host, port: target.port, servername: target.host }, () => socket.write(request))
    : tcpConnect({ host: target.host, port: target.port }, () => socket.write(request));
  release = () => socket.destroy();
  let received = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    if (received.length >= 20) finish(isStunReplyTo(received, transactionId));
  });
  socket.on('error', () => finish(false));
  socket.on('close', () => finish(false));
});

export interface TurnHealthOptions {
  probe?: TurnProbe;
  now?: () => number;
  timeoutMs?: number;
  failAfter?: number;
  onChange?: (entry: TurnUrlHealth, previous: TurnState) => void;
}

export class TurnHealth {
  private readonly entries: Array<TurnUrlHealth & { target: TurnTarget | null; answered: boolean }>;

  constructor(urls: string[], private readonly opts: TurnHealthOptions = {}) {
    this.entries = urls.map(url => ({ url, target: parseTurnUrl(url), state: 'unknown', since: null, checkedAt: null, rttMs: null, failures: 0, answered: false }));
  }

  async check(): Promise<void> {
    const now = this.opts.now ?? Date.now;
    await Promise.all(this.entries.map(async (e) => {
      if (!e.target) return;
      const result = await (this.opts.probe ?? probeTurn)(e.target, this.opts.timeoutMs ?? TURN_CHECK_TIMEOUT_MS).catch(() => ({ ok: false, rttMs: null }));
      e.checkedAt = now();
      e.rttMs = result.rttMs;
      e.failures = result.ok ? 0 : e.failures + 1;
      e.answered ||= result.ok;
      const next: TurnState = result.ok ? 'alive' : e.answered && e.failures >= (this.opts.failAfter ?? 2) ? 'dead' : e.state;
      if (next === e.state && e.since !== null) return;
      const previous = e.state;
      e.state = next;
      e.since = e.checkedAt;
      this.opts.onChange?.(this.viewOf(e), previous);
    }));
  }

  usable(): string[] {
    return this.entries.filter(e => e.state !== 'dead').map(e => e.url);
  }

  view(): TurnUrlHealth[] {
    return this.entries.map(e => this.viewOf(e));
  }

  private viewOf(e: TurnUrlHealth): TurnUrlHealth {
    return { url: e.url, state: e.state, since: e.since, checkedAt: e.checkedAt, rttMs: e.rttMs, failures: e.failures };
  }
}
