/**
 * SSH Tunnel Manager - creates SSH tunnels to GPU pods for health checks
 * when direct port access is not available.
 */

import { spawn, type ChildProcess } from 'child_process';
import { connect as netConnect } from 'net';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../../../logger';

const log = createLogger('ssh-tunnel');

/**
 * Resolve an SSH identity file to pass with `-i` (fix #5). Relying on the ambient
 * agent silently yields "Permission denied" → exit 255 when the gateway runs
 * without the Vast key loaded. Honors VAST_SSH_KEY / AIGW_SSH_KEY, else the
 * common default keys.
 */
export function resolveSshIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.VAST_SSH_KEY || env.AIGW_SSH_KEY;
  if (explicit && existsSync(explicit)) return explicit;
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const p = join(homedir(), '.ssh', name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Raw TCP connect probe — resolves true if the local port accepts within timeoutMs. */
export function tcpProbe(port: number, timeoutMs: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = netConnect({ port, host });
    const done = (ok: boolean) => { clearTimeout(t); try { sock.destroy(); } catch { /* noop */ } resolve(ok); };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Build the ssh tunnel argv (pure, testable). Adds `-i` + IdentitiesOnly when an identity is given. */
export function buildSshArgs(opts: {
  localPort: number; remotePort: number; sshPort: number; sshHost: string;
  identityFile?: string; logLevel?: string;
}): string[] {
  const args = [
    '-N',
    '-L', `${opts.localPort}:localhost:${opts.remotePort}`,
    '-p', String(opts.sshPort),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=60',
    '-o', 'ServerAliveCountMax=5',
    '-o', 'TCPKeepAlive=yes',
    '-o', `LogLevel=${opts.logLevel ?? 'ERROR'}`,
    '-o', 'ExitOnForwardFailure=yes',
  ];
  if (opts.identityFile) args.push('-i', opts.identityFile, '-o', 'IdentitiesOnly=yes');
  args.push(`root@${opts.sshHost}`);
  return args;
}

let nextLocalPort = 19000;

const DEFAULT_OPEN_RETRIES = 20;
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];
const MAX_RECONNECT_ATTEMPTS = 30;

export class SshTunnel {
  private proc: ChildProcess | null = null;
  private _localPort = 0;
  private _open = false;
  private _closed = false;
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _stderr = '';
  /** Last ssh failure reason (code + stderr tail) — read by vast-client (fix #5). */
  public lastError: string | null = null;

  constructor(
    public readonly sshHost: string,
    public readonly sshPort: number,
    public readonly remotePort: number = 8000,
  ) {}

  get localPort(): number { return this._localPort; }
  get endpoint(): string { return `http://127.0.0.1:${this._localPort}`; }
  get isOpen(): boolean { return this._open; }
  get reconnectAttempts(): number { return this._reconnectAttempts; }

  async open(timeoutMs = 10_000, retries = DEFAULT_OPEN_RETRIES): Promise<boolean> {
    if (this._open) return true;
    if (!this.sshHost || !this.sshPort) return false;
    this._closed = false;

    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt > 0) {
        const backoff = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)];
        log.log(`Retry ${attempt + 1}/${retries} for ${this.sshHost}:${this.sshPort} after ${backoff}ms backoff`);
        await new Promise(r => setTimeout(r, backoff));
      }
      const ok = await this._spawnOnce(timeoutMs);
      if (ok) return true;
      if (this._closed) return false;
    }
    return false;
  }

  private _spawnOnce(timeoutMs: number): Promise<boolean> {
    this._localPort = nextLocalPort++;
    if (nextLocalPort > 19999) nextLocalPort = 19000;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        log.warn(`Timeout connecting to ${this.sshHost}:${this.sshPort}`);
        this._killProc();
        resolve(false);
      }, timeoutMs);

      let processExited = false;
      let resolved = false;
      const finish = (val: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(val);
      };

      try {
        const identityFile = resolveSshIdentity();
        this.proc = spawn('ssh', buildSshArgs({
          localPort: this._localPort, remotePort: this.remotePort,
          sshPort: this.sshPort, sshHost: this.sshHost, identityFile,
        }), { stdio: ['ignore', 'pipe', 'pipe'] });

        // Capture stderr so a 255 has a real reason (auth vs refused vs proxy)
        // instead of the old discarded-stderr mystery.
        this.proc.stderr?.on('data', (b: Buffer) => { this._stderr = (this._stderr + b.toString()).slice(-1000); });

        this.proc.on('error', (err) => {
          log.warn(`Process error: ${err.message}`);
          this._open = false;
          finish(false);
        });

        this.proc.on('exit', (code) => {
          processExited = true;
          const wasOpen = this._open;
          this._open = false;
          if (code !== 0 && code !== null) {
            const tail = this._stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
            this.lastError = `code ${code}${tail ? `: ${tail}` : ''}`;
            log.warn(`Exited with ${this.lastError}`);
          }
          if (wasOpen && !this._closed) {
            this._scheduleReconnect();
          }
          finish(false);
        });

        setTimeout(async () => {
          if (processExited || resolved) return;
          try {
            const testRes = await fetch(`http://127.0.0.1:${this._localPort}/health`, {
              signal: AbortSignal.timeout(5000),
            }).catch(() => null);
            if (testRes) {
              this._open = true;
              this._reconnectAttempts = 0;
              log.log(`Connected: localhost:${this._localPort} -> ${this.sshHost}:${this.sshPort}:${this.remotePort}`);
              finish(true);
            } else {
              // Fix #5: don't accept optimistically. Validate the forward with a raw
              // TCP connect — only "open" if the local port actually accepts (app may
              // still be booting). A non-forwarding tunnel must NOT be accepted.
              const tcpOk = await tcpProbe(this._localPort, 2000);
              if (tcpOk) {
                this._open = true;
                this._reconnectAttempts = 0;
                log.log(`Tunnel forward up (app not yet responding): localhost:${this._localPort} -> ${this.sshHost}:${this.sshPort}`);
                finish(true);
              } else {
                this.lastError = this.lastError ?? 'tunnel forward not established (local port not accepting)';
                finish(false);
              }
            }
          } catch {
            finish(false);
          }
        }, 3000);
      } catch (err) {
        log.warn(`Failed to spawn: ${err}`);
        finish(false);
      }
    });
  }

  private _scheduleReconnect(): void {
    if (this._closed) return;
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.warn(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for ${this.sshHost}:${this.sshPort} - giving up`);
      return;
    }
    const idx = Math.min(this._reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1);
    const backoff = RECONNECT_BACKOFF_MS[idx];
    this._reconnectAttempts++;
    log.log(`Auto-reconnect ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} for ${this.sshHost}:${this.sshPort} in ${backoff}ms`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._closed) return;
      const ok = await this._spawnOnce(15_000);
      if (ok) {
        log.log(`Reconnected after ${this._reconnectAttempts} attempt(s): localhost:${this._localPort} -> ${this.sshHost}:${this.sshPort}`);
        this._reconnectAttempts = 0;
      }
    }, backoff);
  }

  private _killProc(): void {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill('SIGTERM'); } catch { /* process may have already exited */ }
      setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* already dead */ } }, 3_000);
    }
  }

  close(): void {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._killProc();
    this._open = false;
  }
}

const activeTunnels = new Map<string, SshTunnel>();

export function getOrCreateTunnel(sshHost: string, sshPort: number, remotePort = 8000): SshTunnel {
  const key = `${sshHost}:${sshPort}:${remotePort}`;
  const existing = activeTunnels.get(key);
  if (existing && existing.isOpen) return existing;
  if (existing) {
    existing.close();
    activeTunnels.delete(key);
  }
  const tunnel = new SshTunnel(sshHost, sshPort, remotePort);
  activeTunnels.set(key, tunnel);
  return tunnel;
}

export function closeAllTunnels(): void {
  for (const [key, tunnel] of activeTunnels) {
    tunnel.close();
    activeTunnels.delete(key);
  }
}

export function getActiveTunnelCount(): number {
  return activeTunnels.size;
}
