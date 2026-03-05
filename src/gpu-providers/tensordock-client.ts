import type { GpuInstance, InstanceSpec, ProviderCredentials } from './types';
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
 * Finds cheapest hostnodes for a given GPU model — single implementation.
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
      candidates.push({
        id: locId,
        price: gpu.price_per_hr,
        ports,
        city: node.location?.city || 'unknown',
        maxVcpu: node.available_resources?.max_vcpus_per_gpu || node.available_resources?.max_vcpus || 4,
        maxRam: node.available_resources?.max_ram_per_gpu || node.available_resources?.max_ram_gb || 16,
      });
    }
    candidates.sort((a, b) => a.price - b.price);
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
    const { apiKey, authId } = credentials;
    try {
      const form = new URLSearchParams({ api_token: apiKey });
      if (authId) form.set('api_key', authId);
      const res = await fetch('https://marketplace.tensordock.com/api/v0/client/list', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const vms = (data.virtualmachines ?? data.servers ?? {}) as Record<string, Record<string, unknown>>;
      const entries = Object.entries(vms);
      if (entries.length === 0) return null;

      const [id, vm] =
        entries.find(([, v]) => String(v.status).toLowerCase() === 'running') ?? entries[0];
      const ip = (vm.ip_address || '') as string;
      const pfObj = vm.port_forwards as Record<string, string> | undefined;
      let endpoint = '';
      if (ip && pfObj && typeof pfObj === 'object' && !Array.isArray(pfObj)) {
        const apiPort = Object.entries(pfObj).find(([, v]) => String(v) === '8000')?.[0];
        if (apiPort) {
          endpoint = `http://${ip}:${apiPort}`;
        } else {
          const monPort = Object.entries(pfObj).find(([, v]) => String(v) === '9090')?.[0];
          endpoint = monPort ? `http://${ip}:${monPort}` : ip ? `http://${ip}:8000` : '';
        }
      }

      // If v0 didn't give usable endpoint, try v2 detail
      if (!endpoint) {
        const detail = await this._getInstanceDetailV2(id, apiKey);
        endpoint = detail ? this._endpointFromDetail(detail) : '';
      }

      return { instanceId: id, endpoint, status: String(vm.status || 'unknown'), ipAddress: ip };
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
      const candidates = await findCheapestLocations(gpuId, headers, 3);
      if (candidates.length === 0) {
        this.log.log(`[tensordock] ${gpuShort} unavailable, trying next...`);
        continue;
      }

      const instanceName = `parle-autoscale-${Date.now()}`;
      const cloudInit = buildCloudInit({
        hfRepoUrl: spec.hfRepoUrl,
        hfToken: hfToken || spec.hfToken,
        dockerImage: spec.dockerImage,
        sshPubKey: localSshPubKey,
        env: spec.env,
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
          const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances`, {
            method: 'POST',
            headers,
            body: JSON.stringify(v2Body),
          }, TIMEOUTS.create);
          if (!res.ok) {
            this.log.warn(`[tensordock] create at ${candidate.city} failed HTTP ${res.status}`);
            continue;
          }
          const data = await res.json();
          if (data.error || (data.status && data.status >= 400)) {
            this.log.warn(`[tensordock] create at ${candidate.city} body error: ${JSON.stringify(data.error).substring(0, 300)}`);
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
        }
      }
    }

    throw new Error('Nenhum GPU disponível no TensorDock (todos os tipos esgotados)');
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey, authId } = credentials;
    const headers = this.headers(apiKey);

    // Try v2 first
    let v2Status = 0;
    let v2Body = '';
    try {
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
    const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances/${instanceId}/stop`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify({}),
    }, TIMEOUTS.write);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`TensorDock stop failed: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const { apiKey } = credentials;
    const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances/${instanceId}`, {
      method: 'DELETE',
      headers: this.headers(apiKey),
    }, TIMEOUTS.write);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`TensorDock delete failed: HTTP ${res.status} ${body.substring(0, 300)}`);
    }
  }

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const { apiKey, authId } = credentials;
    const instances: GpuInstance[] = [];
    try {
      // Try v0 marketplace list (returns all VMs for the account)
      if (authId) {
        const form = new URLSearchParams({ api_token: apiKey });
        form.set('api_key', authId);
        const res = await fetch('https://marketplace.tensordock.com/api/v0/client/list', {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          this.log.warn(`[tensordock] v0 list failed: HTTP ${res.status} (credentials may be invalid)`);
        } else {
          const data = (await res.json()) as Record<string, unknown>;
          const vms = (data.virtualmachines ?? data.servers ?? {}) as Record<string, Record<string, unknown>>;
          // v0 returned OK
          for (const [id, vm] of Object.entries(vms)) {
            const ip = (vm.ip_address || '') as string;
            const pfObj = vm.port_forwards as Record<string, string> | undefined;
            let endpoint = '';
            if (ip && pfObj && typeof pfObj === 'object') {
              const apiPort = Object.entries(pfObj).find(([, v]) => String(v) === '8000')?.[0];
              endpoint = apiPort ? `http://${ip}:${apiPort}` : `http://${ip}:8000`;
            }
            instances.push({
              instanceId: id,
              instanceName: vm.name as string | undefined,
              endpoint,
              status: String(vm.status || 'unknown'),
              ipAddress: ip,
            });
          }
          // If v0 found instances, return them
          if (instances.length > 0) return instances;
          // Otherwise fall through to v2 (v0 may not see v2-created instances)
        }
      }
      // v2 list (always try — catches instances created via v2 API)
      const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances`, {
        headers: this.headers(apiKey),
      }, TIMEOUTS.read);
      if (!res.ok) {
        this.log.warn(`[tensordock] v2 /instances returned HTTP ${res.status} (credentials may be invalid)`);
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
    }
    return instances;
  }

  async getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    try {
      const { apiKey, authId } = credentials;
      // Try v0 list first (faster, returns all instances at once)
      if (authId) {
        const form = new URLSearchParams({ api_token: apiKey });
        form.set('api_key', authId);
        const res = await fetch('https://marketplace.tensordock.com/api/v0/client/list', {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          const servers = (data.virtualmachines ?? data.servers ?? {}) as Record<string, unknown>;
          if (instanceId in servers) {
            const vm = servers[instanceId] as Record<string, unknown>;
            return String(vm.status || 'unknown');
          }
          return null; // not found
        }
      }
      // v2 fallback
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
}
