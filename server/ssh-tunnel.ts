/**
 * SSH Tunnel Manager — creates SSH tunnels to GPU pods for health checks
 * when direct port access is not available (Vast.ai machines without direct_port_count).
 *
 * Usage:
 *   const tunnel = new SshTunnel(sshHost, sshPort, remotePort);
 *   await tunnel.open();           // opens tunnel, assigns local port
 *   const ep = tunnel.endpoint;    // "http://127.0.0.1:LOCAL_PORT"
 *   await tunnel.close();          // cleanup
 */

import { spawn, type ChildProcess } from 'child_process';

let nextLocalPort = 19000; // start range for local tunnel ports

export class SshTunnel {
  private proc: ChildProcess | null = null;
  private _localPort = 0;
  private _open = false;

  constructor(
    public readonly sshHost: string,
    public readonly sshPort: number,
    public readonly remotePort: number = 8000,
  ) {}

  get localPort(): number { return this._localPort; }
  get endpoint(): string { return `http://127.0.0.1:${this._localPort}`; }
  get isOpen(): boolean { return this._open; }

  async open(timeoutMs = 10_000): Promise<boolean> {
    if (this._open) return true;
    if (!this.sshHost || !this.sshPort) return false;

    this._localPort = nextLocalPort++;
    if (nextLocalPort > 19999) nextLocalPort = 19000; // wrap around

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[ssh-tunnel] Timeout connecting to ${this.sshHost}:${this.sshPort}`);
        this.close();
        resolve(false);
      }, timeoutMs);

      try {
        this.proc = spawn('ssh', [
          '-N',                              // no command, just tunnel
          '-L', `${this._localPort}:localhost:${this.remotePort}`,
          '-p', String(this.sshPort),
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'UserKnownHostsFile=/dev/null',
          '-o', 'ConnectTimeout=8',
          '-o', 'ServerAliveInterval=30',
          '-o', 'ServerAliveCountMax=3',
          '-o', 'LogLevel=ERROR',
          `root@${this.sshHost}`,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        this.proc.on('error', (err) => {
          console.warn(`[ssh-tunnel] Process error: ${err.message}`);
          clearTimeout(timer);
          this._open = false;
          resolve(false);
        });

        this.proc.on('exit', (code) => {
          this._open = false;
          if (code !== 0 && code !== null) {
            console.warn(`[ssh-tunnel] Exited with code ${code}`);
          }
        });

        // SSH tunnel is "ready" when the port is bound locally
        // Wait a bit then test the connection
        setTimeout(async () => {
          clearTimeout(timer);
          try {
            // Quick test: can we connect to the local port?
            const testRes = await fetch(`http://127.0.0.1:${this._localPort}/health`, {
              signal: AbortSignal.timeout(5000),
            }).catch(() => null);
            if (testRes) {
              this._open = true;
              console.log(`[ssh-tunnel] Connected: localhost:${this._localPort} → ${this.sshHost}:${this.sshPort}:${this.remotePort}`);
              resolve(true);
            } else {
              // Tunnel process started but health not responding yet — still mark as open
              // (the remote server may still be booting)
              this._open = true;
              console.log(`[ssh-tunnel] Tunnel open (health not yet responding): localhost:${this._localPort} → ${this.sshHost}:${this.sshPort}`);
              resolve(true);
            }
          } catch {
            resolve(false);
          }
        }, 3000); // give SSH 3s to establish connection
      } catch (err) {
        clearTimeout(timer);
        console.warn(`[ssh-tunnel] Failed to spawn: ${err}`);
        resolve(false);
      }
    });
  }

  close(): void {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch {}
      this.proc = null;
    }
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
