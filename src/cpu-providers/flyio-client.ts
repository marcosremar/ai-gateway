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
import { normalizeInstanceStatus } from '../gateway/providers/gpu/instance-status';

// ── Constants ────────────────────────────────────────────────────────────────

const FLY_API = process.env.FLY_API_BASE || 'https://api.machines.dev/v1';
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
    // BOT_FLY_APP_NAME takes priority — avoids conflict with Fly.io's auto-injected
    // FLY_APP_NAME which is set to the *gateway* app name when running on Fly.io
    return process.env.BOT_FLY_APP_NAME || process.env.FLY_APP_NAME || DEFAULT_APP;
  }

  // ── Instance lifecycle ─────────────────────────────────────────────────

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
  ): Promise<GpuInstance> {
    const token = credentials.apiKey || process.env.FLY_API_TOKEN;
    if (!token) {
      throw new Error('Fly.io API token required (set apiKey or FLY_API_TOKEN)');
    }
    // Reset flyHost for new instance
    this.flyHost = '';
    const app = this.appName();
    const region = spec.region || process.env.FLY_REGION || DEFAULT_REGION;

    // Prefer Fly registry image (built via flyctl deploy) over Docker Hub
    let image = spec.dockerImage || process.env.BOT_DOCKER_IMAGE || 'marcosremar/meet-teams-bot:latest';
    if (image === (process.env.BOT_DOCKER_IMAGE || 'marcosremar/meet-teams-bot:latest')) {
      // Prefer the latest Fly registry image (built via flyctl deploy, has newest patches).
      // FLY_BOT_IMAGE env var overrides everything; otherwise fetch the latest release tag.
      if (process.env.FLY_BOT_IMAGE) {
        image = process.env.FLY_BOT_IMAGE;
      } else {
        const latestFlyImage = await this.getLatestReleaseImage(this.appName(), token).catch(() => null);
        image = latestFlyImage ?? `registry.fly.io/${this.appName()}:latest`;
      }
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
      // Don't return a "running" instance if the machine failed to start
      throw new Error(`Fly.io machine failed to start: ${e instanceof Error ? e.message : e}`);
    }

    // Resolve endpoint — try fly.dev DNS first, fall back to allocated IPv4
    let endpoint = `https://${app}.fly.dev`;
    let dnsReady = false;
    try {
      const dnsCheck = await fetch(`${endpoint}/version`, { signal: AbortSignal.timeout(5_000) });
      if (dnsCheck.ok) dnsReady = true;
    } catch (e) {
      this.log.log(`[flyio] DNS not propagated yet: ${e instanceof Error ? e.message : e}`);
    }

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
      status: 'running',
      endpoint,
      sshHost: '',
      sshPort: 0,
      providerMeta: {
        provider: 'flyio',
        costPerHr: 0.03, // approximate for shared-cpu-4x 8GB
        createdAt: machine.created_at,
      },
    };
  }

  async deleteInstance(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<void> {
    const token = credentials.apiKey || process.env.FLY_API_TOKEN;
    if (!token) {
      throw new Error('Fly.io API token required (set apiKey or FLY_API_TOKEN)');
    }
    const app = this.appName();

    this.log.log(`[flyio] Destroying machine ${instanceId}`);

    // Stop first, then destroy
    try {
      await fetch(`${FLY_API}/apps/${app}/machines/${instanceId}/stop`, {
        method: 'POST',
        headers: this.headers(token),
        signal: AbortSignal.timeout(TIMEOUTS.write),
      });
      await this.waitForState(app, instanceId, token, 'stopped', 30).catch((e) => {
        this.log.log(`[flyio] Wait for stopped state failed during cleanup: ${e instanceof Error ? e.message : e}`);
      });
    } catch (e) {
      this.log.log(`[flyio] Stop failed, might already be stopped: ${e instanceof Error ? e.message : e}`);
    }

    const res = await fetch(`${FLY_API}/apps/${app}/machines/${instanceId}?force=true`, {
      method: 'DELETE',
      headers: this.headers(token),
      signal: AbortSignal.timeout(TIMEOUTS.write),
    });

    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`Fly.io delete failed (${res.status}): ${text.slice(0, 200)}`);
    }

    this.log.log(`[flyio] Machine ${instanceId} destroyed`);
  }

  /** Fly doesn't have a "discover existing instance" concept — deploys are always fresh. */
  async discoverInstance(
    _credentials: ProviderCredentials,
    _gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    return null;
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const token = credentials.apiKey || process.env.FLY_API_TOKEN;
    if (!token) {
      throw new Error('Fly.io API token required (set apiKey or FLY_API_TOKEN)');
    }
    const app = this.appName();
    const res = await fetch(`${FLY_API}/apps/${app}/machines/${instanceId}/start`, {
      method: 'POST',
      headers: this.headers(token),
      signal: AbortSignal.timeout(TIMEOUTS.write),
    });
    if (!res.ok && res.status !== 412) {
      // 412 = already started
      const text = await res.text();
      throw new Error(`Fly.io start failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const token = credentials.apiKey || process.env.FLY_API_TOKEN;
    if (!token) {
      throw new Error('Fly.io API token required (set apiKey or FLY_API_TOKEN)');
    }
    const app = this.appName();
    const res = await fetch(`${FLY_API}/apps/${app}/machines/${instanceId}/stop`, {
      method: 'POST',
      headers: this.headers(token),
      signal: AbortSignal.timeout(TIMEOUTS.write),
    });
    if (!res.ok && res.status !== 412) {
      const text = await res.text();
      throw new Error(`Fly.io stop failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const token = credentials.apiKey || process.env.FLY_API_TOKEN;
    if (!token) return null;
    const app = this.appName();
    try {
      const res = await fetch(`${FLY_API}/apps/${app}/machines/${instanceId}`, {
        headers: this.headers(token),
        signal: AbortSignal.timeout(TIMEOUTS.read),
      });
      if (!res.ok) return null;
      const machine = await res.json() as FlyMachine;
      return normalizeInstanceStatus(machine.state);
    } catch (e) {
      this.log.log(`[flyio] getInstanceStatus failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const token = credentials.apiKey || process.env.FLY_API_TOKEN;
    if (!token) return [];
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
          instanceName: m.name,
          status: normalizeInstanceStatus(m.state),
          endpoint: `https://${app}.fly.dev`,
          sshHost: '',
          sshPort: 0,
          providerMeta: {
            provider: 'flyio',
            costPerHr: 0.03,
            createdAt: m.created_at,
          },
        }));
    } catch {
      return [];
    }
  }

  async getInstanceDetail(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<Record<string, unknown>> {
    const token = credentials.apiKey || process.env.FLY_API_TOKEN;
    if (!token) {
      throw new Error('Fly.io API token required (set apiKey or FLY_API_TOKEN)');
    }
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
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    try {
      // Use flyctl CLI which has the auth context
      proc = Bun.spawn(['flyctl', 'ips', 'list', '--app', app, '--json'], {
        stdout: 'pipe', stderr: 'pipe',
      });
      await proc.exited;
      if (!proc.stdout || typeof proc.stdout === 'number') return null;
      const out = await new Response(proc.stdout).text();
      const parsed = JSON.parse(out);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed)) {
        return null;
      }
      const ips = parsed as Array<{ Address?: string; Type?: string }>;
      const v4 = ips.find(ip => ip.Type === 'shared_v4' || ip.Type === 'v4');
      return v4?.Address?.replace('/32', '') || null;
    } catch (e) {
      this.log.log(`[flyio] Resolve app IP failed: ${e instanceof Error ? e.message : e}`);
      // Fallback: allocate a shared IPv4 via CLI
      try {
        proc = Bun.spawn(['flyctl', 'ips', 'allocate-v4', '--shared', '--app', app, '--json'], {
          stdout: 'pipe', stderr: 'pipe',
        });
        await proc.exited;
        if (!proc.stdout || typeof proc.stdout === 'number') return null;
        const out = await new Response(proc.stdout).text();
        const parsed = JSON.parse(out);
        if (!parsed || typeof parsed !== 'object') {
          return null;
        }
        const data = parsed as { Address?: string };
        return data?.Address?.replace('/32', '') || null;
      } catch (e2) {
        this.log.log(`[flyio] Allocate IPv4 failed: ${e2 instanceof Error ? e2.message : e2}`);
        return null;
      }
    } finally {
      if (proc?.stdout && typeof proc.stdout !== 'number') void proc.stdout.cancel().catch(() => {});
      if (proc?.stderr && typeof proc.stderr !== 'number') void proc.stderr.cancel().catch(() => {});
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
    // Non-2xx means the machine didn't reach the desired state
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Wait for ${state} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    // Even on 200, verify the machine is actually in the expected state
    const machine = await this.getMachine(app, machineId, token);
    if (machine && machine.state !== state) {
      throw new Error(`Machine state is ${machine.state}, expected ${state}`);
    }
  }

  private async getMachine(app: string, machineId: string, token: string): Promise<FlyMachine | null> {
    try {
      const res = await fetch(`${FLY_API}/apps/${app}/machines/${machineId}`, {
        headers: this.headers(token),
        signal: AbortSignal.timeout(TIMEOUTS.read),
      });
      if (!res.ok) return null;
      return (await res.json()) as FlyMachine;
    } catch {
      return null;
    }
  }

  /** Return the image tag from the most recent successful Fly release. */
  private async getLatestReleaseImage(app: string, token: string): Promise<string | null> {
    const res = await fetch(`${FLY_API}/apps/${app}/releases?limit=1`, {
      headers: this.headers(token),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Array<{ image_ref?: string }>;
    const img = data[0]?.image_ref;
    return img || null;
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
  private orgSlugPromise: Promise<string> | null = null;
  private async resolveOrgSlug(token: string): Promise<string> {
    // Return cached value if available
    if (this.orgSlugCache) return this.orgSlugCache;
    // Return in-flight promise to avoid concurrent resolution (race condition fix)
    if (this.orgSlugPromise) return this.orgSlugPromise;
    // Start new resolution
    this.orgSlugPromise = this.resolveOrgSlugImpl(token);
    try {
      const result = await this.orgSlugPromise;
      this.orgSlugCache = result;
      return result;
    } finally {
      this.orgSlugPromise = null;
    }
  }

  private async resolveOrgSlugImpl(token: string): Promise<string> {
    try {
      const res = await fetch(`${FLY_API}/apps?org_slug=personal`, {
        headers: this.headers(token),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object' && Array.isArray(data.apps)) {
          const apps = data.apps as Array<{ organization?: { slug?: string } }>;
          const slug = apps[0]?.organization?.slug;
          if (slug && typeof slug === 'string') {
            return slug;
          }
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
