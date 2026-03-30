/**
 * Fly.io Machines provider — on-demand CPU instances for bot deployment.
 *
 * API docs: https://fly.io/docs/machines/api/
 * Auth: Bearer token (FLY_API_TOKEN env var).
 * Pricing: shared-cpu-4x 8GB = ~$0.03/hr (pay per second, only while running).
 *
 * Used for bot deployment (CPU-only Chromium pods) as a fast-booting
 * alternative to RunPod/Scaleway. Machines boot in ~10-20s.
 *
 * Requires a pre-created Fly app (FLY_APP_NAME or 'babelcast-bot').
 * Create once with: fly apps create babelcast-bot --org personal
 */

import { AbstractGpuProvider, TIMEOUTS } from '../gpu-providers/abstract-provider';
import type { AbstractGpuProviderOptions } from '../gpu-providers/abstract-provider';
import type { GpuInstance, InstanceSpec, ProviderCredentials } from '../gpu-providers/types';

// ── Constants ────────────────────────────────────────────────────────────────

const FLY_API = 'https://api.machines.dev/v1';
const DEFAULT_APP = 'babelcast-bot';
const DEFAULT_REGION = 'iad'; // US East (low latency to Teams servers)

// ── Fly API types ───────────────────────────────────────────────────────────

interface FlyMachine {
  id: string;
  name: string;
  state: string; // 'created' | 'starting' | 'started' | 'stopping' | 'stopped' | 'destroying' | 'destroyed'
  region: string;
  instance_id: string;
  private_ip: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class FlyioClient extends AbstractGpuProvider {
  readonly providerId = 'flyio';
  readonly bootTimeSecs = 20; // Fly machines boot fast (~10-20s)

  /** TLS hostname for when connecting via IP (DNS not propagated). */
  private flyHost: string = '';

  constructor(opts?: AbstractGpuProviderOptions) {
    super(opts);
  }

  private headers(token: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private appName(): string {
    return process.env.FLY_APP_NAME || DEFAULT_APP;
  }

  // ── Instance lifecycle ─────────────────────────────────────────────────

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
  ): Promise<GpuInstance> {
    const token = credentials.apiKey;
    const app = this.appName();
    const region = spec.region || process.env.FLY_REGION || DEFAULT_REGION;

    // Prefer Fly registry image (built via flyctl deploy) over Docker Hub
    let image = spec.dockerImage || 'marcosremar/meet-teams-bot:latest';
    if (image === 'marcosremar/meet-teams-bot:latest') {
      // Use Fly registry image if available (has patches not yet in Docker Hub)
      const flyImage = process.env.FLY_BOT_IMAGE || `registry.fly.io/${this.appName()}:latest`;
      image = flyImage;
    } else if (!image.includes('/') || (!image.startsWith('registry.') && !image.includes('.io/'))) {
      image = `registry.hub.docker.com/${image}`;
    }

    // Chromium + FFmpeg + PulseAudio need at least 4 vCPUs to avoid audio dropouts.
    // Use performance CPUs for consistent scheduling (shared CPUs cause audio glitches).
    const cpus = spec.vcpus ?? 4;
    const cpuKind = cpus > 2 ? 'performance' : 'shared';
    const memoryMb = (spec.ramGb ?? 8) * 1024;
    const name = `babelcast-bot-${Date.now()}`;

    this.log.log(`[flyio] Creating machine in ${region}: ${image} (${cpus} vCPU, ${memoryMb}MB RAM)`);

    // Ensure the app exists (create if not — idempotent)
    await this.ensureApp(app, token);

    const body = {
      name,
      region,
      config: {
        image,
        env: spec.env || {},
        guest: {
          cpu_kind: cpuKind as 'shared' | 'performance',
          cpus,
          memory_mb: memoryMb,
        },
        services: [
          {
            ports: [
              { port: 443, handlers: ['tls', 'http'] },
              { port: 80, handlers: ['http'], force_https: true },
            ],
            protocol: 'tcp',
            internal_port: 8080,
          },
        ],
        auto_destroy: true,
        restart: { policy: 'no' },
      },
    };

    const res = await fetch(`${FLY_API}/apps/${app}/machines`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUTS.create),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Fly.io create failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const machine: FlyMachine = await res.json();
    this.log.log(`[flyio] Machine created: ${machine.id} (state: ${machine.state})`);

    // Wait for the machine to reach 'started' state (long-poll, max 59s per Fly API limit)
    try {
      await this.waitForState(app, machine.id, token, 'started', 59);
      this.log.log(`[flyio] Machine ${machine.id} is running`);
    } catch (e) {
      this.log.log(`[flyio] Wait for start failed: ${e instanceof Error ? e.message : e}`);
    }

    // Resolve endpoint — try fly.dev DNS first, fall back to allocated IPv4
    let endpoint = `https://${app}.fly.dev`;
    let dnsReady = false;
    try {
      const dnsCheck = await fetch(`${endpoint}/version`, { signal: AbortSignal.timeout(5_000) });
      if (dnsCheck.ok) dnsReady = true;
    } catch { /* DNS not propagated yet */ }

    if (!dnsReady) {
      // DNS not ready — resolve IPv4 and connect directly
      const ip = await this.resolveAppIp(app, token);
      if (ip) {
        this.log.log(`[flyio] DNS not ready, using IP endpoint: https://${ip}`);
        endpoint = `https://${ip}`;
        this.flyHost = `${app}.fly.dev`;
      } else {
        this.log.log(`[flyio] DNS not ready and no IP resolved, using fly.dev (may timeout)`);
      }
    }

    return {
      instanceId: machine.id,
      providerId: 'flyio',
      status: 'running',
      endpoint,
      sshHost: '',
      sshPort: 0,
      costPerHr: 0.03, // approximate for shared-cpu-4x 8GB
      createdAt: new Date(machine.created_at),
    };
  }

  async deleteInstance(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<void> {
    const token = credentials.apiKey;
    const app = this.appName();

    this.log.log(`[flyio] Destroying machine ${instanceId}`);

    // Stop first, then destroy
    try {
      await fetch(`${FLY_API}/apps/${app}/machines/${instanceId}/stop`, {
        method: 'POST',
        headers: this.headers(token),
        signal: AbortSignal.timeout(15_000),
      });
      await this.waitForState(app, instanceId, token, 'stopped', 30).catch(() => {});
    } catch { /* might already be stopped */ }

    const res = await fetch(`${FLY_API}/apps/${app}/machines/${instanceId}?force=true`, {
      method: 'DELETE',
      headers: this.headers(token),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`Fly.io delete failed (${res.status}): ${text.slice(0, 200)}`);
    }

    this.log.log(`[flyio] Machine ${instanceId} destroyed`);
  }

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const token = credentials.apiKey;
    const app = this.appName();

    try {
      const res = await fetch(`${FLY_API}/apps/${app}/machines`, {
        headers: this.headers(token),
        signal: AbortSignal.timeout(TIMEOUTS.read),
      });

      if (!res.ok) return [];
      const machines: FlyMachine[] = await res.json();

      return machines
        .filter(m => m.name.startsWith('babelcast-bot-'))
        .map(m => ({
          instanceId: m.id,
          providerId: 'flyio' as const,
          status: m.state === 'started' ? 'running' as const : 'stopped' as const,
          endpoint: `https://${app}.fly.dev`,
          sshHost: '',
          sshPort: 0,
          costPerHr: 0.03,
          createdAt: new Date(m.created_at),
        }));
    } catch {
      return [];
    }
  }

  async getInstanceDetail(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<Record<string, unknown>> {
    const token = credentials.apiKey;
    const app = this.appName();

    const res = await fetch(`${FLY_API}/apps/${app}/machines/${instanceId}`, {
      headers: this.headers(token),
      signal: AbortSignal.timeout(TIMEOUTS.read),
    });

    if (!res.ok) throw new Error(`Fly.io get failed (${res.status})`);
    return res.json();
  }

  async resolveInstanceEndpoint(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<string | null> {
    const app = this.appName();
    return `https://${app}.fly.dev`;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Resolve the app's allocated shared IPv4 address. */
  private async resolveAppIp(app: string, token: string): Promise<string | null> {
    try {
      // Use flyctl CLI which has the auth context
      const proc = Bun.spawn(['flyctl', 'ips', 'list', '--app', app, '--json'], {
        stdout: 'pipe', stderr: 'pipe',
      });
      await proc.exited;
      const out = await new Response(proc.stdout).text();
      const ips = JSON.parse(out) as Array<{ Address: string; Type: string }>;
      const v4 = ips.find(ip => ip.Type === 'shared_v4' || ip.Type === 'v4');
      return v4?.Address?.replace('/32', '') || null;
    } catch {
      // Fallback: allocate a shared IPv4 via CLI
      try {
        const proc = Bun.spawn(['flyctl', 'ips', 'allocate-v4', '--shared', '--app', app, '--json'], {
          stdout: 'pipe', stderr: 'pipe',
        });
        await proc.exited;
        const out = await new Response(proc.stdout).text();
        const data = JSON.parse(out);
        return data?.Address?.replace('/32', '') || null;
      } catch {
        return null;
      }
    }
  }

  /** Long-poll until the machine reaches the desired state. */
  private async waitForState(
    app: string,
    machineId: string,
    token: string,
    state: string,
    timeoutSecs: number,
  ): Promise<void> {
    const res = await fetch(
      `${FLY_API}/apps/${app}/machines/${machineId}/wait?state=${state}&timeout=${timeoutSecs}`,
      {
        headers: this.headers(token),
        signal: AbortSignal.timeout((timeoutSecs + 10) * 1000),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Wait for ${state} failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  /** Ensure the Fly app exists (create if needed — idempotent). */
  private async ensureApp(app: string, token: string): Promise<void> {
    // Check if app exists
    const check = await fetch(`${FLY_API}/apps/${app}`, {
      headers: this.headers(token),
      signal: AbortSignal.timeout(10_000),
    });

    if (check.ok) return; // app exists

    // Create the app — detect org from existing apps
    const orgSlug = await this.resolveOrgSlug(token);
    this.log.log(`[flyio] Creating app '${app}' in org '${orgSlug}'...`);
    const create = await fetch(`${FLY_API}/apps`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ app_name: app, org_slug: orgSlug }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!create.ok) {
      const text = await create.text();
      // 422 = app already exists (race condition), that's fine
      if (create.status !== 422) {
        throw new Error(`Fly.io app create failed (${create.status}): ${text.slice(0, 200)}`);
      }
    }

    this.log.log(`[flyio] App '${app}' ready`);
  }

  /** Resolve the org slug from the token's existing apps. */
  private orgSlugCache: string | null = null;
  private async resolveOrgSlug(token: string): Promise<string> {
    if (this.orgSlugCache) return this.orgSlugCache;
    try {
      const res = await fetch(`${FLY_API}/apps?org_slug=personal`, {
        headers: this.headers(token),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = await res.json() as { apps?: Array<{ organization?: { slug?: string } }> };
        const slug = data.apps?.[0]?.organization?.slug;
        if (slug) {
          this.orgSlugCache = slug;
          return slug;
        }
      }
    } catch { /* fallback */ }
    return process.env.FLY_ORG || 'personal';
  }

  /**
   * Fetch the bot's /version endpoint using fly-force-instance-id header
   * to target the specific machine (since all machines share the app URL).
   */
  /** Get the TLS hostname (for Host header when connecting via IP). */
  getFlyHost(): string { return this.flyHost; }

  async probeHealth(
    machineId: string,
    credentials: ProviderCredentials,
  ): Promise<boolean> {
    const app = this.appName();
    const baseUrl = this.flyHost ? `https://${this.flyHost}` : `https://${app}.fly.dev`;
    try {
      const headers: Record<string, string> = { 'fly-force-instance-id': machineId };
      const res = await fetch(`${baseUrl}/version`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
