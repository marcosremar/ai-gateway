import { defaultLogger } from '../logger';

/**
 * Whether to skip TLS certificate verification for GPU health probes.
 * Useful for self-signed certs on private GPU endpoints.
 *
 * NOTE: Bun's fetch supports per-request TLS config via `tls: { rejectUnauthorized: false }`,
 * but Node's native fetch does not. For Node, set the `NODE_TLS_REJECT_UNAUTHORIZED=0`
 * environment variable as a workaround (applies process-wide).
 */
const GPU_HEALTH_SKIP_TLS = !!process.env.GPU_HEALTH_SKIP_TLS;

/** Probe a GPU endpoint's /health to check if it's serving. */
export async function probeGpuHealth(endpoint: string, returnData?: false, timeoutMs?: number): Promise<boolean>;
export async function probeGpuHealth(endpoint: string, returnData: true, timeoutMs?: number): Promise<{ ok: boolean; timedOut?: boolean; data?: Record<string, any> }>;
export async function probeGpuHealth(endpoint: string, returnData?: boolean, timeoutMs = parseInt(process.env.GPU_HEALTH_TIMEOUT_MS || '15000', 10)): Promise<boolean | { ok: boolean; timedOut?: boolean; data?: Record<string, any> }> {
  if (!endpoint) return returnData ? { ok: false } : false;
  try {
    const fetchOptions: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (GPU_HEALTH_SKIP_TLS) {
      // Bun supports per-request TLS config; Node does not.
      // For Node, use env: NODE_TLS_REJECT_UNAUTHORIZED=0
      (fetchOptions as any).tls = { rejectUnauthorized: false };
    }
    const res = await fetch(`${endpoint}/health`, fetchOptions);
    if (!res.ok) return returnData ? { ok: false } : false;
    const data = await res.json();
    // Accept healthy, ok, degraded (partial services), and ready
    const HEALTHY = new Set(['healthy', 'ok', 'degraded', 'ready']);
    const ok = HEALTHY.has(data.status);
    return returnData ? { ok, data: ok ? data : undefined } : ok;
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return returnData ? { ok: false, timedOut: timedOut || undefined } : false;
  }
}

/**
 * Probe health via SSH — for providers where HTTP is unreachable (Vast.ai without direct ports).
 * Retries up to SSH_MAX_RETRIES times with a short delay between attempts to handle
 * transient SSH connection failures (host key issues, connection resets during boot).
 */
export async function probeGpuHealthSsh(sshHost: string, sshPort: number): Promise<boolean> {
  if (!sshHost || !sshPort || sshPort <= 0) return false;
  const SSH_MAX_RETRIES = 3;
  const SSH_RETRY_DELAY_MS = 3_000;

  for (let attempt = 1; attempt <= SSH_MAX_RETRIES; attempt++) {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',  // avoid stale host key errors
        '-o', 'ConnectTimeout=5',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2',
        '-o', 'BatchMode=yes',
        '-p', String(sshPort),
        `root@${sshHost}`,
        'curl -s --max-time 3 http://localhost:8000/health 2>/dev/null || echo "{}"',
      ], { timeout: 15_000 });
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === '{}') {
        // curl returned empty or default — app not ready yet (not an SSH failure)
        return false;
      }
      const data = JSON.parse(trimmed);
      const HEALTHY_SSH = new Set(['healthy', 'ok', 'degraded', 'ready']);
      return HEALTHY_SSH.has(data.status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < SSH_MAX_RETRIES) {
        // Transient SSH error — wait and retry
        await new Promise((r) => setTimeout(r, SSH_RETRY_DELAY_MS));
        continue;
      }
      // All retries exhausted — SSH unreachable or app not up
      const isSshRefused = msg.includes('Connection refused') || msg.includes('Connection reset') || msg.includes('No route');
      if (!isSshRefused) {
        // Unexpected error (e.g. JSON parse) — log it for debugging
        defaultLogger.warn(`[ssh-health] ${sshHost}:${sshPort} attempt ${attempt} failed: ${msg}`);
      }
      return false;
    }
  }
  return false;
}
