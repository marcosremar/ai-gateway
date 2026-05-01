/**
 * Liveness probe utilities — distinguish "instance exists in provider DB"
 * from "instance is actually reachable on the network".
 *
 * Vast.ai (and to a lesser extent the other providers) keep a pod's
 * status as `running` for several minutes after the underlying SSH-proxy
 * node falls off the network. Trusting the provider's status alone caused
 * us to ship work to dead pods. These helpers do the cheapest possible
 * "alive?" check — a TCP `connect`. No SSH handshake, no HTTP, just
 * "did the kernel ACK?". That alone is enough to flip the decision from
 * "trust the provider" to "skip this zombie".
 *
 * Used by `ai-gateway gpu list --probe`, `ai-gateway gpu doctor`, and
 * `ai-gateway gpu wait`.
 */

import * as net from 'net';

/**
 * Open a TCP connection to `host:port` and return whether it succeeded
 * within `timeoutMs`. Always resolves — never throws — so callers can
 * `await` without a try/catch in hot loops.
 *
 * Implementation note: we deliberately do NOT use `dns.lookup` first.
 * `net.connect` already does that, and adding a separate DNS step would
 * give a different error surface (NXDOMAIN vs ECONNREFUSED) that the
 * caller doesn't care about — they only need a yes/no.
 */
export async function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (alive: boolean): void => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(alive);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.setTimeout(timeoutMs);
  });
}

/**
 * Shape of the per-instance object that providers (Vast.ai, RunPod, etc.)
 * surface through `/v1/gpu/list`. We pick the bare-minimum fields needed
 * to derive a probe target — anything else stays unread so older API
 * shapes don't break this helper.
 */
export interface InstanceLike {
  endpoint?: string;
  sshHost?: string;
  sshPort?: number | string;
}

/**
 * Pick the best `host:port` to TCP-probe for a given instance.
 *
 * Preference order:
 *   1. The HTTP endpoint (`http://host:port`) if present — that's what
 *      the user-facing app talks to, so its reachability is what
 *      actually matters.
 *   2. The SSH proxy (`sshHost:sshPort`) — falls back when there's no
 *      HTTP endpoint (e.g. plain `vastai/pytorch` images).
 *
 * Returns `null` when neither is available — the caller should report
 * `liveness=unknown` rather than guess.
 *
 * Why not parse the URL with regex: subtle bugs around IPv6, default
 * ports, and `https://`. The `URL` constructor is stricter and gives
 * us `hostname` + `port` directly.
 */
export function pickProbeTarget(inst: InstanceLike): { host: string; port: number } | null {
  const ep = inst.endpoint;
  if (ep && /^https?:\/\//.test(ep)) {
    try {
      const u = new URL(ep);
      const port = u.port
        ? parseInt(u.port, 10)
        : (u.protocol === 'https:' ? 443 : 80);
      if (Number.isFinite(port) && port > 0 && u.hostname) {
        return { host: u.hostname, port };
      }
    } catch {
      // Malformed URL — fall through to SSH path.
    }
  }
  if (inst.sshHost && inst.sshPort) {
    const port = typeof inst.sshPort === 'number' ? inst.sshPort : parseInt(String(inst.sshPort), 10);
    if (Number.isFinite(port) && port > 0) {
      return { host: String(inst.sshHost), port };
    }
  }
  return null;
}

/**
 * Convenience: classify a liveness state given the provider-claimed
 * status and the result of an actual TCP probe. Pulled out so the
 * "ZOMBIE" rule has exactly one source of truth, both for the CLI
 * formatter and tests.
 *
 * A pod is a ZOMBIE iff the provider says it's running but our probe
 * says it isn't. That's the exact failure mode that burned $1.15 of
 * autoresearch time before this code existed.
 */
export type Liveness = 'alive' | 'unreachable' | 'unknown';

export function classifyLiveness(
  providerStatus: string | undefined,
  probeAlive: boolean | null,
): { liveness: Liveness; zombie: boolean } {
  if (probeAlive === null) return { liveness: 'unknown', zombie: false };
  if (probeAlive) return { liveness: 'alive', zombie: false };
  // probe says dead — it's a zombie if the provider still claims running.
  // RunPod returns 'RUNNING' (uppercase), Vast.ai returns 'running' (lowercase) — compare case-insensitively.
  const zombie = (providerStatus ?? '').toLowerCase() === 'running';
  return { liveness: 'unreachable', zombie };
}
