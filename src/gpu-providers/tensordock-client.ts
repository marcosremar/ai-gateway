import type { GpuInstance, GpuOffer, InstanceSpec, ListOffersOptions, ProviderCredentials } from './types';
import { AbstractGpuProvider, TIMEOUTS } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';

// Re-export buildCloudInit (and related helpers) from the dedicated module
// so that existing `import { buildCloudInit } from './tensordock-client'` and
// barrel re-exports from index.ts keep working.
export { buildCloudInit, b64, buildMonitorScript, buildEnvFlags, buildExportLines, getDefaultSshPubKey } from './tensordock-cloud-init';
export type { CloudInitSpec, DockerSetupPhase, GitCloneSetupPhase } from './tensordock-cloud-init';
import { buildCloudInit, getDefaultSshPubKey } from './tensordock-cloud-init';

export const TENSORDOCK_V2_BASE = 'https://dashboard.tensordock.com/api/v2';

/** Map frontend GPU names to TensorDock v2 GPU model IDs — single definition */
export const GPU_ID_MAP: Record<string, string> = {
  'RTX3090': 'geforcertx3090-pcie-24gb',
  'RTX4090': 'geforcertx4090-pcie-24gb',
  'rtx3090-pcie-24gb': 'geforcertx3090-pcie-24gb',
  'rtx4090-pcie-24gb': 'geforcertx4090-pcie-24gb',
  'geforcertx3090-pcie-24gb': 'geforcertx3090-pcie-24gb',
  'geforcertx4090-pcie-24gb': 'geforcertx4090-pcie-24gb',
  // NVIDIA-prefixed names (from gateway allowlist)
  'NVIDIA GeForce RTX 4090': 'geforcertx4090-pcie-24gb',
  'NVIDIA GeForce RTX 3090': 'geforcertx3090-pcie-24gb',
  'NVIDIA RTX A6000': 'rtxa6000-pcie-48gb',
  'NVIDIA L40S': 'l40s-pcie-48gb',
  'NVIDIA A40': 'a40-pcie-48gb',
  'NVIDIA A100-SXM4-80GB': 'a100-sxm4-80gb',
  'NVIDIA A100 80GB PCIe': 'a100-pcie-80gb',
  // Short names
  'A6000': 'rtxa6000-pcie-48gb',
  'L40S': 'l40s-pcie-48gb',
  'A40': 'a40-pcie-48gb',
};

/** GPU types to try in order of preference */
const GPU_FALLBACK = ['RTX3090', 'RTX4090'];

export interface HostnodeCandidate {
  id: string;
  price: number;
  ports: number[];
  city: string;
  maxVcpu: number;
  maxRam: number;
  tier: number;         // location tier (0=residential, 3-4=data center)
  uptimePct: number;    // historical uptime percentage
}

export interface SshKeyInfo {
  id: string;
  publicKey?: string;
}

/**
 * Finds the first SSH key in the account's secrets.
 * Returns both the secret ID and the raw public key content.
 */
export async function findSshKey(headers: Record<string, string>): Promise<SshKeyInfo | undefined> {
  try {
    const res = await fetch(`${TENSORDOCK_V2_BASE}/secrets`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const data = await res.json();
    const secrets = data.data?.secrets || data.secrets || data.data || [];
    if (!Array.isArray(secrets)) return undefined;
    const ssh = secrets.find(
      (s: { type?: string; attributes?: { type?: string } }) =>
        (s.type || '').toUpperCase() === 'SSHKEY' ||
        (s.attributes?.type || '').toUpperCase() === 'SSHKEY',
    );
    if (!ssh?.id) return undefined;

    // Try to fetch the raw public key content from the secret
    let publicKey: string | undefined;
    try {
      const detailRes = await fetch(`${TENSORDOCK_V2_BASE}/secrets/${ssh.id}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (detailRes.ok) {
        const detail = await detailRes.json();
        publicKey = detail.data?.attributes?.value || detail.data?.value || detail.value;
      }
    } catch { /* non-critical */ }

    return { id: ssh.id as string, publicKey };
  } catch {
    return undefined;
  }
}

/**
 * Finds best hostnodes for a given GPU model.
 * Sorts by tier (highest first), then uptime, then price.
 * This avoids tier-0 residential hosts that frequently reclaim GPUs (stoppeddisassociated).
 */
export async function findCheapestLocations(
  gpuId: string,
  headers: Record<string, string>,
  minPorts: number = 2,
): Promise<HostnodeCandidate[]> {
  const candidates: HostnodeCandidate[] = [];
  try {
    const res = await fetch(
      `${TENSORDOCK_V2_BASE}/hostnodes?gpu_model=${gpuId}&status=available`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return candidates;
    const data = await res.json();
    const allNodes = data.data?.hostnodes || data.hostnodes || [];
    for (const node of allNodes) {
      const gpus = node.available_resources?.gpus || [];
      const gpu = gpus.find(
        (g: { v0Name: string; availableCount: number; price_per_hr: number }) =>
          g.v0Name === gpuId && g.availableCount >= 1,
      );
      if (!gpu) continue;
      const ports = node.available_resources?.available_ports || [];
      if (ports.length < minPorts) continue;
      const locId = node.location_id || node.location?.uuid || node.id;
      const tier = node.location?.tier ?? 0;
      const uptimePct = node.uptime_percentage ?? 0;
      candidates.push({
        id: locId,
        price: gpu.price_per_hr,
        ports,
        city: node.location?.city || 'unknown',
        maxVcpu: node.available_resources?.max_vcpus_per_gpu || node.available_resources?.max_vcpus || 4,
        maxRam: node.available_resources?.max_ram_per_gpu || node.available_resources?.max_ram_gb || 16,
        tier,
        uptimePct,
      });
    }
    // Sort: highest tier first, then best uptime, then lowest price
    candidates.sort((a, b) => {
      if (b.tier !== a.tier) return b.tier - a.tier;           // higher tier first
      if (b.uptimePct !== a.uptimePct) return b.uptimePct - a.uptimePct; // better uptime first
      return a.price - b.price;                                 // cheaper first
    });
  } catch {
    // ignore
  }
  return candidates;
}

// ── V2 instance detail shape ────────────────────────────────────────────────

interface InstanceDetailV2 {
  ip: string;
  portForwards: Array<{ internal_port: number; external_port: number }>;
}

export interface TensordockClientOptions extends AbstractGpuProviderOptions {}

export class TensordockClient extends AbstractGpuProvider {
  readonly providerId = 'tensordock';
  readonly bootTimeSecs = 1200;

  constructor(opts?: TensordockClientOptions) {
    super(opts);
  }

  /** TensorDock v2 JSON headers (same as jsonHeaders from base). */
  private headers(apiKey: string): Record<string, string> {
    return this.jsonHeaders(apiKey);
  }

  /**
   * Fetches instance detail from the v2 API and returns IP + port forwards.
   */
  private async _getInstanceDetailV2(
    instanceId: string,
    apiKey: string,
  ): Promise<InstanceDetailV2 | null> {
    try {
      await this.rateLimiter.wait();
      const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances/${instanceId}`, {
        headers: this.headers(apiKey),
      }, TIMEOUTS.read);
      if (!res.ok) return null;
      const data = await res.json();
      const attrs = data.data?.attributes || data;
      const ip = (attrs.ip_address || attrs.ipAddress || '') as string;
      const portForwards = (attrs.port_forwards || attrs.portForwards || []) as Array<{
        internal_port: number;
        external_port: number;
      }>;
      return { ip, portForwards };
    } catch {
      return null;
    }
  }

  /**
   * Derives the best endpoint URL from v2 instance detail.
   * With dedicated IP: uses internal ports directly (all ports open).
   * With NAT: maps external_port → internal_port.
   */
  private _endpointFromDetail(detail: InstanceDetailV2): string {
    const { ip, portForwards } = detail;
    if (!ip) return '';
    // If port forwards exist, use mapped external ports
    if (portForwards.length > 0) {
      const apiPf = portForwards.find((p) => p.internal_port === 8000);
      if (apiPf) return `http://${ip}:${apiPf.external_port}`;
      const monPf = portForwards.find((p) => p.internal_port === 9090);
      if (monPf) return `http://${ip}:${monPf.external_port}`;
    }
    // Dedicated IP or no port forwards: use port directly
    return `http://${ip}:8000`;
  }

  async discoverInstance(
    credentials: ProviderCredentials,
    _gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    try {
      // Use v2 API via listInstances() — v0 API is deprecated
      const instances = await this.listInstances(credentials);
      if (instances.length === 0) return null;

      // Prefer a running instance, otherwise take the first one
      const running = instances.find(
        (inst) => inst.status.toLowerCase() === 'running',
      );
      return running ?? instances[0];
    } catch {
      return null;
    }
  }

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    userId?: string,
  ): Promise<GpuInstance> {
    const { apiKey, hfToken } = credentials;
    const gpuTypesToTry = spec.gpuTypes?.length ? spec.gpuTypes : GPU_FALLBACK;
    const headers = this.headers(apiKey);

    const sshKeyInfo = await findSshKey(headers);
    if (!sshKeyInfo) {
      throw new Error('Nenhuma SSH key encontrada na conta TensorDock. Crie uma em dashboard.tensordock.com > Secrets.');
    }

    // SSH public key for cloud-init injection: env var > TensorDock API > local file
    let localSshPubKey: string | undefined = getDefaultSshPubKey() || sshKeyInfo.publicKey;
    if (!localSshPubKey) {
      try {
        const fs = await import('fs');
        const os = await import('os');
        for (const name of ['id_ed25519.pub', 'id_rsa.pub']) {
          const p = `${os.homedir()}/.ssh/${name}`;
          if (fs.existsSync(p)) { localSshPubKey = fs.readFileSync(p, 'utf-8').trim(); break; }
        }
      } catch { /* non-critical */ }
    }

    for (const gpuShort of gpuTypesToTry) {
      const gpuId = GPU_ID_MAP[gpuShort] || gpuShort;
      let candidates = await findCheapestLocations(gpuId, headers, 3);
      // Filter by region (city name) if specified
      if (spec.region && candidates.length > 0) {
        const regionLower = spec.region.toLowerCase();
        candidates = candidates.filter(c => c.city.toLowerCase().includes(regionLower));
      }
      if (candidates.length === 0) {
        this.log.log(`[tensordock] ${gpuShort} unavailable, trying next...`);
        continue;
      }

      // Log top candidates with quality info
      this.log.log(`[tensordock] ${gpuShort}: ${candidates.length} candidates (top 3):`);
      for (const c of candidates.slice(0, 3)) {
        this.log.log(`  ${c.city} tier=${c.tier} uptime=${c.uptimePct.toFixed(1)}% $${c.price}/hr ports=${c.ports.length}`);
      }

      const instanceName = `parle-autoscale-${Date.now()}`;
      const cloudInit = buildCloudInit({
        hfRepoUrl: spec.hfRepoUrl,
        hfToken: hfToken || spec.hfToken,
        dockerImage: spec.dockerImage,
        sshPubKey: localSshPubKey,
        env: spec.env,
        bareMetal: spec.bareMetal,
      });

      for (const candidate of candidates.slice(0, 3)) {
        // Use dedicated IP to bypass fragile NAT port-forwarding on third-party hosts
        const v2Body = {
          data: {
            type: 'virtualmachine',
            attributes: {
              name: instanceName,
              type: 'virtualmachine',
              image: 'ubuntu2404',
              resources: {
                vcpu_count: Math.min(spec.vcpus ?? 4, candidate.maxVcpu),
                ram_gb: Math.min(spec.ramGb ?? 16, candidate.maxRam),
                storage_gb: spec.storageGb ?? 100,
                gpus: { [gpuId]: { count: spec.gpuCount ?? 1 } },
              },
              location_id: candidate.id,
              ssh_key: sshKeyInfo.id,
              port_forwards: [
                { external_port: candidate.ports[0] || 20000, internal_port: 22 },
                { external_port: candidate.ports[1] || 20001, internal_port: 9090 },
                { external_port: candidate.ports[2] || 20002, internal_port: 8000 },
              ],
              cloud_init: cloudInit,
            },
          },
        };

        try {
          await this.rateLimiter.wait();
          const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances`, {
            method: 'POST',
            headers,
            body: JSON.stringify(v2Body),
          }, TIMEOUTS.create);
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            this.log.warn(`[tensordock] create at ${candidate.city} failed HTTP ${res.status}: ${errBody.substring(0, 500)}`);
            this.emitError({
              operation: 'createInstance', message: `Create at ${candidate.city} failed: HTTP ${res.status} — ${errBody.substring(0, 300)}`,
              httpStatus: res.status, retryable: res.status >= 500,
            });
            continue;
          }
          const data = await res.json();
          if (data.error || (data.status && data.status >= 400)) {
            this.log.warn(`[tensordock] create at ${candidate.city} body error: ${JSON.stringify(data.error).substring(0, 300)}`);
            this.emitError({
              operation: 'createInstance', message: `Create at ${candidate.city} body error: ${JSON.stringify(data.error).substring(0, 200)}`,
              retryable: true,
            });
            continue;
          }

          const attrs = data.data?.attributes || data;
          const instanceId: string = data.data?.id || data.id;
          if (!instanceId) continue;

          let ip = (attrs.ip_address || attrs.ipAddress || '') as string;
          let pfs: Array<{ internal_port: number; external_port: number }> =
            attrs.port_forwards || attrs.portForwards || [];

          // Poll for IP if not in create response
          if (!ip) {
            for (let attempt = 0; attempt < 6; attempt++) {
              await new Promise((r) => setTimeout(r, 5000));
              const detail = await this._getInstanceDetailV2(instanceId, apiKey);
              if (detail) {
                ip = detail.ip;
                pfs = detail.portForwards;
                if (ip) break;
              }
            }
          }

          const apiPf = pfs.find((p) => p.internal_port === 8000);
          const monitorPf = pfs.find((p) => p.internal_port === 9090);
          const endpoint = ip && apiPf ? `http://${ip}:${apiPf.external_port}` : '';
          const monitorUrl = ip && monitorPf ? `http://${ip}:${monitorPf.external_port}` : '';

          // Persist to user settings via callback
          await this.persistInstance(userId, spec.machineKey || 'tensordockInstance', {
            instanceId,
            instanceName,
            endpoint,
            monitorUrl,
            ipAddress: ip,
            gpuType: gpuShort,
            status: attrs.status || 'creating',
            portForwards: pfs,
          });

          this.log.log(`[tensordock] Created ${instanceName} (${instanceId}) at ${candidate.city}`);
          return { instanceId, instanceName, endpoint, monitorUrl, ipAddress: ip, status: attrs.status || 'creating', gpuType: gpuShort, portForwards: pfs };
        } catch (e) {
          this.log.warn(`[tensordock] create at ${candidate.city} error: ${this.errMsg(e)}`);
          this.emitError({
            operation: 'createInstance', message: `Create at ${candidate.city}: ${this.errMsg(e)}`,
            retryable: true,
          });
        }
      }
    }

    this.emitError({
      operation: 'createInstance', message: 'All GPU types exhausted on TensorDock',
      errorCode: 'NO_GPU_AVAILABLE', retryable: false,
    });
    throw new Error('No GPUs available on TensorDock (all types exhausted)');
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey, authId } = credentials;
    const headers = this.headers(apiKey);

    // Try v2 first
    let v2Status = 0;
    let v2Body = '';
    try {
      await this.rateLimiter.wait();
      const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances/${instanceId}/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      }, TIMEOUTS.write);
      v2Status = res.status;
      if (res.ok) return;
      v2Body = await res.text().catch(() => '');
      const alreadyActive =
        v2Status === 409 ||
        v2Body.includes('already running') ||
        v2Body.includes('already started') ||
        v2Body.includes('must be stopped');
      if (alreadyActive) return;
      // 404 = instance deleted — no point trying v0
      if (v2Status === 404 || v2Body.toLowerCase().includes('not found')) {
        throw new Error(`Instância ${instanceId} não encontrada no TensorDock (deletada?). Reconfigure o tier.`);
      }
    } catch (err) {
      // Re-throw "not found" errors regardless of authId
      if (err instanceof Error && err.message.includes('não encontrada')) throw err;
      if (!authId) throw err;
    }

    // v0 fallback — only if v2 failed for a reason other than "not found" and we have authId
    if (authId) {
      const form = new URLSearchParams({ api_token: apiKey, server_id: instanceId });
      form.set('api_key', authId);
      const res = await fetch('https://marketplace.tensordock.com/api/v0/client/start/single', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const v0Body = await res.text().catch(() => '');
        if (v0Body.includes('already running') || v0Body.includes('already started')) return;

        // Extract meaningful error from API responses
        const v2Detail = v2Body.substring(0, 120).trim();
        const v0Detail = v0Body.substring(0, 120).trim();
        const details = [
          v2Detail && `v2: ${v2Detail}`,
          v0Detail && `v0: ${v0Detail}`,
        ].filter(Boolean).join('; ');

        // 400 from both APIs typically means GPU slot reclaimed or instance in unrecoverable state
        if (v2Status === 400 && res.status === 400) {
          throw new Error(
            `TensorDock: instância ${instanceId.substring(0, 8)} não pode ser iniciada (GPU slot provavelmente expirou). `
            + `Delete e re-crie a máquina.${details ? ` [${details}]` : ''}`,
          );
        }

        throw new Error(
          `TensorDock start falhou (v2: ${v2Status}, v0: ${res.status}).${details ? ` [${details}]` : ''} Verifique instanceId e credenciais.`,
        );
      }
    }
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    await this.rateLimiter.wait();
    const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances/${instanceId}/stop`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify({}),
    }, TIMEOUTS.write);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.emitError({
        operation: 'stopInstance', instanceId, message: `Stop failed: HTTP ${res.status}`,
        httpStatus: res.status, retryable: res.status >= 500,
      });
      throw new Error(`TensorDock stop failed: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    await this.rateLimiter.wait();
    const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances/${instanceId}`, {
      method: 'DELETE',
      headers: this.headers(apiKey),
    }, TIMEOUTS.write);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.emitError({
        operation: 'deleteInstance', instanceId, message: `Delete failed: HTTP ${res.status}`,
        httpStatus: res.status, retryable: res.status >= 500,
      });
      throw new Error(`TensorDock delete failed: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
  }

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const { apiKey } = credentials;
    const instances: GpuInstance[] = [];
    try {
      // v2 API only — v0 is deprecated
      await this.rateLimiter.wait();
      const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances`, {
        headers: this.headers(apiKey),
      }, TIMEOUTS.read);
      if (!res.ok) {
        this.log.warn(`[tensordock] v2 /instances returned HTTP ${res.status} (credentials may be invalid)`);
        this.emitError({
          operation: 'listInstances', message: `v2 /instances failed: HTTP ${res.status}`,
          httpStatus: res.status, retryable: res.status >= 500,
        });
        return [];
      }
      const data = (await res.json()) as Record<string, unknown>;
      const list = (data.data ?? []) as unknown[];
      if (!Array.isArray(list)) return [];
      for (const item of list) {
        const it = item as Record<string, unknown>;
        const attrs = ((it.attributes || it) as Record<string, unknown>);
        const ip = (attrs.ip_address || attrs.ipAddress || '') as string;
        const pfs = (attrs.port_forwards || attrs.portForwards || []) as Array<{ internal_port: number; external_port: number }>;
        const apiPf = pfs.find((p) => p.internal_port === 8000);
        const endpoint = ip && apiPf ? `http://${ip}:${apiPf.external_port}` : ip ? `http://${ip}:8000` : '';
        instances.push({
          instanceId: ((it.id || attrs.id) as string),
          instanceName: attrs.name as string | undefined,
          endpoint,
          status: String(attrs.status || 'unknown'),
          ipAddress: ip,
        });
      }
    } catch (err) {
      this.log.warn(`[tensordock] listInstances error: ${this.errMsg(err)}`);
      this.emitError({
        operation: 'listInstances', message: this.errMsg(err), retryable: true,
      });
    }
    return instances;
  }

  async getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    try {
      const { apiKey } = credentials;
      // v2 API only — v0 is deprecated
      await this.rateLimiter.wait();
      const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances/${instanceId}`, {
        headers: this.headers(apiKey),
      }, TIMEOUTS.read);
      if (res.status === 404) return null;
      if (!res.ok) return null;
      const data = await res.json();
      const attrs = data.data?.attributes || data.data || data;
      return String(attrs.status || 'unknown');
    } catch {
      return null;
    }
  }

  /** Re-resolve endpoint for an existing TensorDock instance using v2 API detail. */
  async resolveInstanceEndpoint(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const detail = await this._getInstanceDetailV2(instanceId, credentials.apiKey);
    if (!detail) return null;
    const endpoint = this._endpointFromDetail(detail);
    return endpoint || null;
  }

  /**
   * Derive the monitor URL (:9090) from v2 instance detail.
   */
  private _monitorUrlFromDetail(detail: InstanceDetailV2): string {
    const { ip, portForwards } = detail;
    if (!ip) return '';
    const monPf = portForwards.find((p) => p.internal_port === 9090);
    if (monPf) return `http://${ip}:${monPf.external_port}`;
    return '';
  }

  /**
   * Check health via the monitor endpoint on :9090.
   * Returns true if the app reports healthy, or if the monitor reports
   * a non-failed phase (keeping the boot timer alive during setup).
   */
  async checkHealth(instanceId: string, credentials: ProviderCredentials): Promise<boolean> {
    try {
      const detail = await this._getInstanceDetailV2(instanceId, credentials.apiKey);
      if (!detail) return false;
      const monitorUrl = this._monitorUrlFromDetail(detail);
      if (!monitorUrl) return false;

      const res = await this.fetchRaw(`${monitorUrl}/health`, {}, TIMEOUTS.read);
      if (!res.ok) return false;
      const data = await res.json() as {
        healthy?: boolean;
        phase?: string;
      };
      // App is actually serving traffic
      if (data.healthy === true) return true;
      // Monitor is running and setup is in progress (not failed) — keep boot alive
      if (data.phase && data.phase !== 'failed') return false;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get instance logs from the monitor debug endpoint (root /).
   * Returns JSON string with log tails, GPU info, and setup state.
   */
  async getInstanceLogs(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    try {
      const detail = await this._getInstanceDetailV2(instanceId, credentials.apiKey);
      if (!detail) return null;
      const monitorUrl = this._monitorUrlFromDetail(detail);
      if (!monitorUrl) return null;

      const res = await this.fetchRaw(monitorUrl, {}, TIMEOUTS.read);
      if (!res.ok) return null;
      const text = await res.text();
      return text;
    } catch {
      return null;
    }
  }

  /**
   * Check account balance via TensorDock v0 billing API.
   * Returns { balance, hourlyCost } or null if credentials are invalid / API fails.
   */
  async checkBalance(credentials: ProviderCredentials): Promise<TensordockBalance | null> {
    const { apiKey, authId } = credentials;
    if (!authId) return null;  // v0 requires both api_key (authId) and api_token (apiKey)
    try {
      const form = new URLSearchParams({ api_token: apiKey, api_key: authId });
      const res = await fetch('https://marketplace.tensordock.com/api/v0/billing/balance', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as { success?: boolean; balance?: number; hourly_cost?: number };
      if (!data.success) return null;
      return { balance: data.balance ?? 0, hourlyCost: data.hourly_cost ?? 0 };
    } catch {
      return null;
    }
  }

  /** List available GPU offers from TensorDock hostnodes. */
  async listOffers(options: ListOffersOptions, credentials: ProviderCredentials): Promise<GpuOffer[]> {
    const { apiKey } = credentials;
    const headers = this.headers(apiKey);
    const limit = options.limit ?? 100;

    // Map of canonical GPU IDs we know about
    const gpuIds: Array<{ short: string; id: string }> = [];
    if (options.gpuTypes?.length) {
      for (const t of options.gpuTypes) {
        const id = GPU_ID_MAP[t] || t;
        gpuIds.push({ short: t, id });
      }
    } else {
      // Query all known GPU types
      const seen = new Set<string>();
      for (const [short, id] of Object.entries(GPU_ID_MAP)) {
        if (seen.has(id)) continue;
        seen.add(id);
        gpuIds.push({ short, id });
      }
    }

    // Query all GPU types in parallel
    const results = await Promise.all(
      gpuIds.map(async ({ short, id }) => {
        try {
          const candidates = await findCheapestLocations(id, headers, 2);
          // Filter by region if specified
          let filtered = candidates;
          if (options.region) {
            const regionLower = options.region.toLowerCase();
            filtered = candidates.filter(c => c.city.toLowerCase().includes(regionLower));
          }
          return filtered.map(c => ({
            provider: 'tensordock' as const,
            gpuType: short,
            gpuName: short.includes('RTX') ? `NVIDIA GeForce ${short}` : short,
            available: 1,
            pricePerHr: c.price,
            region: c.city,
            vram: short.includes('3090') ? 24 : short.includes('4090') ? 24 : 0,
            offerId: c.id,
          }));
        } catch {
          return [];
        }
      }),
    );

    const offers: GpuOffer[] = results.flat();
    // Sort by tier desc (higher quality first), then price asc
    return offers
      .sort((a, b) => a.pricePerHr - b.pricePerHr)
      .slice(0, limit);
  }
}

export interface TensordockBalance {
  balance: number;
  hourlyCost: number;
}
