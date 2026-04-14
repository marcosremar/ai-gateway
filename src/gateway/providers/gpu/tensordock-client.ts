import type { GpuInstance, GpuOffer, InstanceSpec, ListOffersOptions, ProviderCredentials } from './types';
import { AbstractGpuProvider, TIMEOUTS } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';

// Re-export buildCloudInit (and related helpers) from the dedicated module
// so that existing `import { buildCloudInit } from './tensordock-client'` and
// barrel re-exports from index.ts keep working.
export { buildCloudInit, b64, buildMonitorScript, buildEnvFlags, buildExportLines, getDefaultSshPubKey } from './tensordock-cloud-init';
export type { CloudInitSpec, DockerSetupPhase, GitCloneSetupPhase } from './tensordock-cloud-init';
import { buildCloudInit, getDefaultSshPubKey } from './tensordock-cloud-init';

export const TENSORDOCK_V2_BASE = process.env.TENSORDOCK_API_BASE || 'https://dashboard.tensordock.com/api/v2';

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
 * Extracts the base64 key material from an SSH public key string for comparison.
 * Ignores the algorithm prefix and comment suffix so keys from different machines
 * with different comments still match if they share the same key material.
 */
function sshKeyBody(pubKey: string): string {
  return pubKey.trim().split(/\s+/)[1] || '';
}

/**
 * Creates a new SSHKEY secret in TensorDock.
 * Format discovered via API inspection: JSON:API with type="secret" and attributes.type="SSHKEY".
 *
 * @returns The new secret's ID, or undefined on failure.
 */
export async function createSshKeySecret(
  headers: Record<string, string>,
  name: string,
  publicKey: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(`${TENSORDOCK_V2_BASE}/secrets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: {
          type: 'secret',
          attributes: { type: 'SSHKEY', name, value: publicKey },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    return (data.data?.id as string | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Deletes a secret by ID.
 */
export async function deleteSecret(headers: Record<string, string>, secretId: string): Promise<void> {
  await fetch(`${TENSORDOCK_V2_BASE}/secrets/${secretId}`, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {/* best-effort */});
}

/**
 * Lists all SSH key secrets in the account.
 * Response shape: GET /api/v2/secrets → { data: { secrets: [...] } }
 * Each secret: { type: "SSHKEY", id: string, name: string }
 */
export async function listSshKeySecrets(
  headers: Record<string, string>,
): Promise<Array<{ id: string; name: string }>> {
  try {
    const res = await fetch(`${TENSORDOCK_V2_BASE}/secrets`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = await res.json();
    const secrets = data.data?.secrets || data.secrets || data.data || [];
    if (!Array.isArray(secrets)) return [];
    return secrets
      .filter((s: { type?: string }) => (s.type || '').toUpperCase() === 'SSHKEY')
      .map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }));
  } catch {
    return [];
  }
}

/**
 * Finds the SSH key secret whose value matches the local machine's public key.
 * If no match is found, auto-creates a new secret with the local key.
 *
 * This ensures the deployed VM uses the correct key for the current machine —
 * avoids the "Permission denied (publickey)" failure that occurs when TensorDock
 * picks the first SSHKEY in the list (e.g. id_rsa) which may not match id_ed25519.
 */
export async function findSshKey(headers: Record<string, string>): Promise<SshKeyInfo | undefined> {
  const localRaw = getDefaultSshPubKey();
  const localBody = localRaw ? sshKeyBody(localRaw) : undefined;

  try {
    const res = await fetch(`${TENSORDOCK_V2_BASE}/secrets`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const data = await res.json();
    const secrets = data.data?.secrets || data.secrets || data.data || [];
    if (!Array.isArray(secrets)) return undefined;

    const sshSecrets = secrets.filter(
      // TensorDock API returns type at the top level OR nested under attributes
      (s: { type?: string; attributes?: { type?: string } }) =>
        (s.type || s.attributes?.type || '').toUpperCase() === 'SSHKEY',
    );
    if (sshSecrets.length === 0) return undefined;

    // Fetch each key's value and find the one matching the local pubkey
    let bestId: string | undefined;
    let bestPublicKey: string | undefined;

    for (const ssh of sshSecrets) {
      if (!ssh?.id) continue;
      let publicKey: string | undefined;
      try {
        const detailRes = await fetch(`${TENSORDOCK_V2_BASE}/secrets/${ssh.id}`, {
          headers, signal: AbortSignal.timeout(10_000),
        });
        if (detailRes.ok) {
          const detail = await detailRes.json();
          publicKey = detail.data?.attributes?.value || detail.data?.value || detail.value;
        }
      } catch { /* non-critical */ }

      // Prefer the key whose body matches the local key
      if (localBody && publicKey && sshKeyBody(publicKey) === localBody) {
        return { id: ssh.id as string, publicKey };
      }

      // Keep track of first available as fallback
      if (!bestId) {
        bestId = ssh.id as string;
        bestPublicKey = publicKey;
      }
    }

    // No exact match — auto-create a secret with the local key
    if (localRaw) {
      const newId = await createSshKeySecret(
        headers,
        `ai-gateway-${Date.now()}`,
        localRaw,
      );
      if (newId) return { id: newId, publicKey: localRaw };
    }

    // Fall back to first SSHKEY if no local key is configured
    if (bestId) return { id: bestId, publicKey: bestPublicKey };
    return undefined;
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
  } catch (e) {
    console.warn(`[tensordock] Failed to fetch hostnode candidates: ${e instanceof Error ? e.message : e}`);
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
  /** TensorDock cold boot. Override via env var TENSORDOCK_BOOT_TIME_SECS. */
  readonly bootTimeSecs = parseInt(process.env.TENSORDOCK_BOOT_TIME_SECS || '1200', 10);

  constructor(opts?: TensordockClientOptions) {
    super(opts);
  }

  dispose(): void {
    // No timers to clean up currently
  }

  /**
   * Override fetchRaw with exponential backoff retry for timeout errors.
   * TensorDock API frequently times out; retries with 2s/4s/8s delays.
   */
  protected override async fetchRaw(url: string, init?: RequestInit, timeout = TIMEOUTS.read, traceId?: string): Promise<Response> {
    const MAX_RETRIES = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await super.fetchRaw(url, init, timeout, traceId);
      } catch (err) {
        lastErr = err;
        const isTimeout = err instanceof Error && (
          err.name === 'TimeoutError' ||
          err.message.includes('timed out') ||
          err.message.includes('The operation was aborted')
        );
        if (!isTimeout || attempt === MAX_RETRIES) throw err;
        const delayMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
        this.log.debug(`[tensordock] Request to ${url} timed out (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastErr; // unreachable but satisfies TypeScript
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
    } catch (e) {
      this.log.debug(`[tensordock] Failed to get network detail for ${instanceId}: ${this.errMsg(e)}`);
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
    } catch (e) {
      this.log.debug(`[tensordock] discoverInstance failed: ${this.errMsg(e)}`);
      return null;
    }
  }

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    userId?: string,
  ): Promise<GpuInstance> {
    // ── Preflight: account balance check ──────────────────────────────────
    await this._runPreflight(credentials);

    const { apiKey, hfToken } = credentials;
    const gpuTypesToTry = spec.gpuTypes?.length ? spec.gpuTypes : GPU_FALLBACK;
    const headers = this.headers(apiKey);

    const sshKeyInfo = await findSshKey(headers);
    if (!sshKeyInfo) {
      throw new Error('No SSH key found in TensorDock account. Create one at dashboard.tensordock.com > Secrets.');
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
      } catch (e) {
        this.log.debug(`[tensordock] Failed to read local SSH key: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Track per-GPU failure reasons for diagnostics
    const gpuFailures: Array<{ gpu: string; reason: string }> = [];

    for (const gpuShort of gpuTypesToTry) {
      const gpuId = GPU_ID_MAP[gpuShort] || gpuShort;
      let candidates = await findCheapestLocations(gpuId, headers, 3);
      // Filter by region (city name) if specified
      if (spec.region && candidates.length > 0) {
        const regionLower = spec.region.toLowerCase();
        candidates = candidates.filter(c => c.city.toLowerCase().includes(regionLower));
      }
      if (candidates.length === 0) {
        this.log.log(`[tensordock] ${gpuShort} (id=${gpuId}) unavailable, trying next...`);
        gpuFailures.push({ gpu: gpuShort, reason: `no candidates (gpuId=${gpuId})` });
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
        // TensorDock Narwhal OS images (validated 2026-04-09):
        //   ubuntu2204, ubuntu2404, ubuntu2404_ml_everything,
        //   ubuntu2404_ml_pytorch, ubuntu2404_ml_tensorflow, windows10
        // NOTE: 'ubuntu2404_nvidia_570' does NOT exist — Narwhal nodes ship
        // driver 565 baked into the host hypervisor. Driver version cannot be
        // changed from inside the guest VM. For driver 570+ use Vast.ai.
        // ml_pytorch image still ships driver 565 but includes CUDA/PyTorch
        // pre-installed, which is useful for snapgpu workloads.
        const needsMl = spec.dockerImage?.includes('snapgpu-runtime') ?? false;
        let osImage = needsMl ? 'ubuntu2404_ml_pytorch' : 'ubuntu2404';

        const v2Body = {
          data: {
            type: 'virtualmachine',
            attributes: {
              name: instanceName,
              type: 'virtualmachine',
              image: osImage,
              resources: {
                vcpu_count: Math.min(spec.vcpus ?? 4, candidate.maxVcpu),
                ram_gb: Math.min(spec.ramGb ?? 16, candidate.maxRam),
                storage_gb: Math.max(spec.storageGb ?? 100, (await import('./deploy-settings')).getMinDiskGb()),
                gpus: { [gpuId]: { count: spec.gpuCount ?? 1 } },
              },
              location_id: candidate.id,
              // Use ssh_key_id (reference to TensorDock secrets) if available,
              // otherwise fall back to the raw public key content.
              // The v2 API requires exactly one of ssh_key or ssh_key_id.
              ...(sshKeyInfo.id
                ? { ssh_key_id: sshKeyInfo.id }
                : { ssh_key: localSshPubKey }),
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
          let data = await res.json();
          if (data.error || (data.status && data.status >= 400)) {
            const errStr = JSON.stringify(data.error);
            this.log.warn(`[tensordock] create at ${candidate.city} body error: ${errStr.substring(0, 300)}`);
            // Non-retryable: insufficient balance
            if (errStr.includes('need at least') || errStr.includes('balance') || errStr.includes('insufficient')) {
              throw new Error(`TensorDock account balance insufficient: ${errStr.substring(0, 200)}`);
            }
            this.emitError({
              operation: 'createInstance', message: `Create at ${candidate.city} body error: ${errStr.substring(0, 200)}`,
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
          return {
            instanceId, instanceName, endpoint, monitorUrl, ipAddress: ip,
            status: attrs.status || 'creating', gpuType: gpuShort, portForwards: pfs,
            providerMeta: {
              provider: 'tensordock',
              hostnodeId: candidate.id,
              tier: candidate.tier,
              uptimePct: candidate.uptimePct,
              city: candidate.city,
              pricePerHr: candidate.price,
              // Machine specs (limited data from TensorDock)
              cpuCores: candidate.maxVcpu,
              ramGb: candidate.maxRam,
            },
          };
        } catch (e) {
          this.log.warn(`[tensordock] create at ${candidate.city} error: ${this.errMsg(e)}`);
          gpuFailures.push({ gpu: gpuShort, reason: `${candidate.city}: ${this.errMsg(e)}` });
          this.emitError({
            operation: 'createInstance', message: `Create at ${candidate.city}: ${this.errMsg(e)}`,
            retryable: true,
          });
        }
      }
    }

    const failSummary = gpuFailures.map(f => `${f.gpu} → ${f.reason}`).join(' | ');
    this.log.error(`[tensordock] All ${gpuTypesToTry.length} GPU types exhausted. Failures: ${failSummary}`);

    this.emitError({
      operation: 'createInstance', message: `All GPU types exhausted on TensorDock: ${failSummary}`,
      errorCode: 'NO_GPU_AVAILABLE', retryable: false,
    });
    throw new Error(`No GPUs available on TensorDock (all types exhausted). Tried ${gpuTypesToTry.length} types: ${failSummary}`);
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
        throw new Error(`TensorDock instance ${instanceId} not found (deleted or expired)`);
      }
    } catch (err) {
      // Re-throw "not found" errors regardless of authId
      if (err instanceof Error && err.message.includes('not found')) throw err;
      if (!authId) throw err;
    }

    // v0 fallback — only if v2 failed for a reason other than "not found" and we have authId
    if (authId) {
      const form = new URLSearchParams({ api_token: apiKey, server_id: instanceId });
      form.set('api_key', authId);
      const tdMarketBase = process.env.TENSORDOCK_MARKETPLACE_BASE || 'https://marketplace.tensordock.com/api/v0';
      const res = await fetch(`${tdMarketBase}/client/start/single`, {
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

  // ── Secrets management ────────────────────────────────────────────────────

  /** List SSH key secrets registered in the TensorDock account. */
  async listSshKeySecrets(credentials: ProviderCredentials): Promise<Array<{ id: string; name: string }>> {
    return listSshKeySecrets(this.headers(credentials.apiKey));
  }

  /**
   * Create a new SSHKEY secret.
   * Use this to register a machine's public key so future deploys can reference it by ID.
   * API format: POST /api/v2/secrets with JSON:API body (discovered via interface inspection).
   */
  async createSshKeySecret(credentials: ProviderCredentials, name: string, publicKey: string): Promise<string | undefined> {
    return createSshKeySecret(this.headers(credentials.apiKey), name, publicKey);
  }

  /** Delete a secret by ID. Secrets cannot be updated (PATCH → 405), only deleted + recreated. */
  async deleteSecret(credentials: ProviderCredentials, secretId: string): Promise<void> {
    return deleteSecret(this.headers(credentials.apiKey), secretId);
  }

  // ── Instance lifecycle ────────────────────────────────────────────────────

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
    if (!apiKey) {
      this.log.warn('[tensordock] listInstances: no apiKey provided');
      return [];
    }
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
      // API returns { data: [...] } (flat array, observed via inspection).
      // Docs show { data: { instances: [...] } } — handle both for robustness.
      let rawList: unknown = data.data ?? [];
      if (!Array.isArray(rawList)) {
        rawList = (rawList as Record<string, unknown>).instances ?? [];
      }
      const list = rawList as unknown[];
      for (const item of list) {
        const it = item as Record<string, unknown>;
        // Instance items use flat camelCase fields (ipAddress, portForwards, status)
        // matching the single-instance GET response format.
        const attrs = ((it.attributes || it) as Record<string, unknown>);
        const ip = (attrs.ip_address || attrs.ipAddress || '') as string;
        const pfs = (attrs.port_forwards || attrs.portForwards || []) as Array<{ internal_port: number; external_port: number }>;
        const apiPf = pfs.find((p) => p.internal_port === 8000);
        const sshPf = pfs.find((p) => p.internal_port === 22);
        const endpoint = ip && apiPf ? `http://${ip}:${apiPf.external_port}` : ip ? `http://${ip}:8000` : '';
        instances.push({
          instanceId: ((it.id || attrs.id) as string),
          instanceName: (it.name || attrs.name) as string | undefined,
          endpoint,
          status: String(it.status || attrs.status || 'unknown'),
          ipAddress: ip,
          sshPort: sshPf?.external_port,
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
    } catch (e) {
      this.log.debug(`[tensordock] getInstanceStatus(${instanceId}) failed: ${this.errMsg(e)}`);
      return null;
    }
  }

  /**
   * Full instance detail: status, IP, port forwards, derived endpoint and monitor URL.
   * Returns null if the instance is not found (404) or on any error.
   */
  async getInstanceDetail(instanceId: string, credentials: ProviderCredentials): Promise<TensordockInstanceDetail | null> {
    try {
      await this.rateLimiter.wait();
      const res = await this.fetchRaw(`${TENSORDOCK_V2_BASE}/instances/${instanceId}`, {
        headers: this.headers(credentials.apiKey),
      }, TIMEOUTS.read);
      if (res.status === 404) return null;
      if (!res.ok) return null;
      const data = await res.json();
      if (data.error || (data.status && data.status >= 400)) return null;
      const attrs = data.data?.attributes || data.data || data;
      const id = (data.data?.id || attrs.id || instanceId) as string;
      const status = String(attrs.status || 'unknown');
      const ip = (attrs.ipAddress || attrs.ip_address || '') as string;
      const portForwards: Array<{ internal_port: number; external_port: number }> =
        attrs.portForwards || attrs.port_forwards || [];
      const apiPf = portForwards.find(p => p.internal_port === 8000);
      const monitorPf = portForwards.find(p => p.internal_port === 9090);
      const endpoint = ip && apiPf ? `http://${ip}:${apiPf.external_port}` : ip ? `http://${ip}:8000` : '';
      const monitorUrl = ip && monitorPf ? `http://${ip}:${monitorPf.external_port}` : '';
      return { id, status, ip, portForwards, endpoint, monitorUrl };
    } catch (e) {
      this.log.debug(`[tensordock] getInstanceDetail(${instanceId}) failed: ${this.errMsg(e)}`);
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
    } catch (e) {
      this.log.debug(`[tensordock] Health check failed for ${instanceId}: ${this.errMsg(e)}`);
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
    } catch (e) {
      this.log.debug(`[tensordock] Failed to fetch logs for ${instanceId}: ${this.errMsg(e)}`);
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
      const tdMarketBase = process.env.TENSORDOCK_MARKETPLACE_BASE || 'https://marketplace.tensordock.com/api/v0';
      const res = await fetch(`${tdMarketBase}/billing/balance`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as { success?: boolean; balance?: number; hourly_cost?: number };
      if (!data.success) return null;
      return { balance: data.balance ?? 0, hourlyCost: data.hourly_cost ?? 0 };
    } catch (e) {
      this.log.debug(`[tensordock] Balance check failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * Preflight: check TensorDock balance before deploy.
   * Override of AbstractGpuProvider.preflight().
   *
   * TensorDock requires positive balance to launch — the API does return
   * "need at least $X" errors, but only after the deploy is in flight.
   * Catch it here and fail fast instead of burning a deploy attempt.
   */
  async preflight(credentials: ProviderCredentials): Promise<{
    canDeploy: boolean;
    blockReason: string | null;
    balance?: number;
    quota?: number;
  } | null> {
    const result = await this.checkBalance(credentials);
    if (!result) return null;  // API unreachable — proceed optimistically
    // $0.50 minimum — enough for ~2-3 hours on cheapest GPU
    if (result.balance < 0.5) {
      return {
        canDeploy: false,
        blockReason: `TensorDock balance too low: $${result.balance.toFixed(2)} (current spend rate $${result.hourlyCost.toFixed(2)}/hr). Add credit at dashboard.tensordock.com.`,
        balance: result.balance,
      };
    }
    return { canDeploy: true, blockReason: null, balance: result.balance };
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
          return filtered.map(c => {
            // Build canonical GPU name matching gateway allowlist format
            // Reverse-lookup: find the canonical NVIDIA name from GPU_ID_MAP
            const canonical = Object.entries(GPU_ID_MAP).find(
              ([k, v]) => v === id && k.startsWith('NVIDIA')
            );
            const gpuName = canonical ? canonical[0] : (short.includes('RTX') ? `NVIDIA GeForce ${short}` : short);
            const vramMap: Record<string, number> = { '3090': 24, '4090': 24, 'A6000': 48, 'A40': 48, 'L40S': 48, 'A100': 80 };
            const vram = Object.entries(vramMap).find(([k]) => short.includes(k))?.[1] ?? 0;
            return {
              provider: 'tensordock' as const,
              gpuType: short,
              gpuName,
              available: 1,
              pricePerHr: c.price,
              region: c.city,
              vram,
              offerId: c.id,
            };
          });
        } catch (e) {
          this.log.debug(`[tensordock] listOffers for GPU ${short} failed: ${e instanceof Error ? e.message : e}`);
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

export interface TensordockInstanceDetail {
  id: string;
  status: string;
  ip: string;
  portForwards: Array<{ internal_port: number; external_port: number }>;
  endpoint: string;
  monitorUrl: string;
}
