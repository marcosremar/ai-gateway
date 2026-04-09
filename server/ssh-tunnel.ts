/**
 * SSH Tunnel Manager — creates SSH tunnels to GPU pods for health checks
 * when direct port access is not available (Vast.ai machines without direct_port_count).
 *
 * P2a: Includes auto-reconnect on unexpected exit and retry-with-backoff in open().
 *
 * Usage:
 *   const tunnel = new SshTunnel(sshHost, sshPort, remotePort);
 *   await tunnel.open();           // opens tunnel, assigns local port
 *   const ep = tunnel.endpoint;    // "http://127.0.0.1:LOCAL_PORT"
 *   await tunnel.close();          // cleanup (also disables auto-reconnect)
 */

import { spawn, type ChildProcess } from 'child_process';

let nextLocalPort = 19000; // start range for local tunnel ports

// Initial open retries: we need a generous budget because Vast.ai instances
// often take 5-15 minutes after going to "running" status before the
// container's docker image finishes pulling and the in-container sshd
// becomes reachable. 20 attempts with progressive backoff ≈ 12 min total.
const DEFAULT_OPEN_RETRIES = 20;
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 45_000, 45_000, 60_000];
const MAX_RECONNECT_ATTEMPTS = 10;

export class SshTunnel {
  private proc: ChildProcess | null = null;
  private _localPort = 0;
  private _open = false;
  private _closed = false;            // P2a: explicit user close — disables auto-reconnect
  private _reconnectAttempts = 0;     // P2a: count of reconnect retries
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly sshHost: string,
    public readonly sshPort: number,
    public readonly remotePort: number = 8000,
  ) {}

  get localPort(): number { return this._localPort; }
  get endpoint(): string { return `http://127.0.0.1:${this._localPort}`; }
  get isOpen(): boolean { return this._open; }
  get reconnectAttempts(): number { return this._reconnectAttempts; }

  /**
   * P2a: Open tunnel with retry. Tries up to `retries` times with backoff.
   * Each spawn attempt has its own internal `timeoutMs` budget.
   */
  async open(timeoutMs = 10_000, retries = DEFAULT_OPEN_RETRIES): Promise<boolean> {
    if (this._open) return true;
    if (!this.sshHost || !this.sshPort) return false;
    this._closed = false; // re-enable after a previous close

    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt > 0) {
        const backoff = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)];
        console.log(`[ssh-tunnel] Retry ${attempt + 1}/${retries} for ${this.sshHost}:${this.sshPort} after ${backoff}ms backoff`);
        await new Promise(r => setTimeout(r, backoff));
      }
      const ok = await this._spawnOnce(timeoutMs);
      if (ok) return true;
      if (this._closed) return false; // user called close() during retry
    }
    return false;
  }

  /** Internal: spawn a single SSH process attempt. */
  private _spawnOnce(timeoutMs: number): Promise<boolean> {
    // Allocate fresh local port for each attempt
    this._localPort = nextLocalPort++;
    if (nextLocalPort > 19999) nextLocalPort = 19000;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[ssh-tunnel] Timeout connecting to ${this.sshHost}:${this.sshPort}`);
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
        this.proc = spawn('ssh', [
          '-N',
          '-L', `${this._localPort}:localhost:${this.remotePort}`,
          '-p', String(this.sshPort),
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'UserKnownHostsFile=/dev/null',
          '-o', 'ConnectTimeout=8',
          '-o', 'ServerAliveInterval=30',
          '-o', 'ServerAliveCountMax=3',
          '-o', 'LogLevel=ERROR',
          '-o', 'ExitOnForwardFailure=yes',
          `root@${this.sshHost}`,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        this.proc.on('error', (err) => {
          console.warn(`[ssh-tunnel] Process error: ${err.message}`);
          this._open = false;
          finish(false);
        });

        this.proc.on('exit', (code) => {
          processExited = true;
          const wasOpen = this._open;
          this._open = false;
          if (code !== 0 && code !== null) {
            console.warn(`[ssh-tunnel] Exited with code ${code}`);
          }
          // P2a: Auto-reconnect if it died after being open and user didn't close it
          if (wasOpen && !this._closed) {
            this._scheduleReconnect();
          }
          finish(false);
        });

        // SSH tunnel readiness check after 3s
        setTimeout(async () => {
          if (processExited || resolved) return;
          try {
            const testRes = await fetch(`http://127.0.0.1:${this._localPort}/health`, {
              signal: AbortSignal.timeout(5000),
            }).catch(() => null);
            if (testRes) {
              this._open = true;
              this._reconnectAttempts = 0; // reset on successful open
              console.log(`[ssh-tunnel] Connected: localhost:${this._localPort} → ${this.sshHost}:${this.sshPort}:${this.remotePort}`);
              finish(true);
            } else {
              // Tunnel process started but health not responding yet — still mark as open
              this._open = true;
              this._reconnectAttempts = 0;
              console.log(`[ssh-tunnel] Tunnel open (health not yet responding): localhost:${this._localPort} → ${this.sshHost}:${this.sshPort}`);
              finish(true);
            }
          } catch {
            finish(false);
          }
        }, 3000);
      } catch (err) {
        console.warn(`[ssh-tunnel] Failed to spawn: ${err}`);
        finish(false);
      }
    });
  }

  /** P2a: Schedule a reconnect attempt with backoff. */
  private _scheduleReconnect(): void {
    if (this._closed) return;
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[ssh-tunnel] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for ${this.sshHost}:${this.sshPort} — giving up`);
      return;
    }
    const idx = Math.min(this._reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1);
    const backoff = RECONNECT_BACKOFF_MS[idx];
    this._reconnectAttempts++;
    console.log(`[ssh-tunnel] Auto-reconnect ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} for ${this.sshHost}:${this.sshPort} in ${backoff}ms`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._closed) return;
      await this._spawnOnce(10_000);
    }, backoff);
  }

  /** P2a: Kill the underlying SSH process without disabling auto-reconnect. */
  private _killProc(): void {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill('SIGTERM'); } catch { /* process may have already exited */ }
      setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* already dead */ } }, 3_000);
    }
  }

  /** Permanently close the tunnel — disables auto-reconnect. */
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

// ── Active tunnel registry (cleanup on shutdown) ──

const activeTunnels = new Map<string, SshTunnel>();

export function getOrCreateTunnel(sshHost: string, sshPort: number, remotePort = 8000): SshTunnel {
  const key = `${sshHost}:${sshPort}:${remotePort}`;
  let tunnel = activeTunnels.get(key);
  if (tunnel && tunnel.isOpen) return tunnel;
  tunnel = new SshTunnel(sshHost, sshPort, remotePort);
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
