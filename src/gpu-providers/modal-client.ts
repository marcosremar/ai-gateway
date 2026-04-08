/**
 * Modal AI GPU Provider Client
 *
 * Modal is a serverless platform — apps auto-scale to zero when idle.
 * Key behaviors:
 *   - "deployed" apps auto-wake on HTTP request (no manual start needed)
 *   - createInstance runs `modal deploy` to push a new app
 *   - Endpoint URL pattern: https://{workspace}--{appName}-{functionName}.modal.run
 *
 * Auth: apiKey = `{tokenId}:{tokenSecret}`
 * The Modal API uses protobuf, so we use the CLI as the primary interface.
 *
 * Advanced features:
 *   - Rolling deploy strategy (--strategy rolling) for zero-downtime
 *   - Deploy tagging (--tag) for version tracking and rollback
 *   - Named deployments (--name) and environment targeting (--env)
 *   - Dynamic autoscaler updates (min_containers, buffer_containers, max_containers)
 *   - Warmup probe on startInstance to pre-trigger snapshot restore
 *   - Proxy auth token support for endpoint protection
 */

import type { GpuInstance, GpuOffer, InstanceSpec, ListOffersOptions, ProviderCredentials } from './types';
import { AbstractGpuProvider } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';

let _execFileAsync: ((file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>) | null = null;
async function getExecFileAsync() {
  if (!_execFileAsync) {
    if (typeof window !== 'undefined') throw new Error('ModalClient is server-side only');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    _execFileAsync = promisify(execFile);
  }
  return _execFileAsync!;
}

function splitModalKey(apiKey: string): { tokenId: string; tokenSecret: string } {
  const [tokenId, tokenSecret] = apiKey.split(':');
  return { tokenId: tokenId || '', tokenSecret: tokenSecret || '' };
}

function buildModalEnv(apiKey: string): NodeJS.ProcessEnv {
  const { tokenId, tokenSecret } = splitModalKey(apiKey);

  const venvBin = process.env.VIRTUAL_ENV
    ? `${process.env.VIRTUAL_ENV}/bin`
    : `${process.cwd()}/.venv/bin`;
  const origPath = process.env.PATH || '/usr/bin:/bin';

  return {
    ...process.env,
    MODAL_TOKEN_ID: tokenId,
    MODAL_TOKEN_SECRET: tokenSecret,
    PATH: `${venvBin}:${origPath}`,
    TERM: 'dumb',
    NO_COLOR: '1',
    COLUMNS: '500',
  };
}

function buildEndpointUrl(workspace: string, appName: string, functionName = 'web'): string {
  return `https://${workspace}--${appName}-${functionName}.modal.run`;
}

/** Options for deploy via `modal deploy`. */
export interface ModalDeployOptions {
  /** Deploy strategy: 'rolling' (default, zero-downtime) or 'recreate'. */
  strategy?: 'rolling' | 'recreate';
  /** Tag this deployment with a version string (e.g. 'v1.2.3'). */
  tag?: string;
  /** Custom deployment name (overrides the app name in the .py file). */
  name?: string;
  /** Target Modal environment (e.g. 'dev', 'prod'). */
  env?: string;
}

/** Parameters for dynamic autoscaler updates (no redeploy needed). */
export interface ModalAutoscalerParams {
  /** Minimum number of warm containers (keeps containers always running). */
  minContainers?: number;
  /** Extra buffer containers while the function is active (for burst traffic). */
  bufferContainers?: number;
  /** Maximum number of containers (upper limit). */
  maxContainers?: number;
}

export interface ModalClientOptions extends AbstractGpuProviderOptions {
  /** Modal workspace name (e.g. "marcosremar"). Auto-detected from CLI if not provided. */
  workspace?: string;
  /** Default ASGI function name in deployed apps. Default: "web" */
  defaultFunctionName?: string;
  /** Proxy auth token — if set, endpoints require Modal-Key/Modal-Secret headers. */
  proxyAuthToken?: string;
}

export class ModalClient extends AbstractGpuProvider {
  readonly providerId = 'modal';
  /** Modal cold boot. With GPU snapshots + min_containers, ~5-10s.
   *  Override via env var MODAL_BOOT_TIME_SECS for slower images. */
  readonly bootTimeSecs = parseInt(process.env.MODAL_BOOT_TIME_SECS || '10', 10);

  private workspace: string | null;
  private defaultFunctionName: string;
  private workspacePromise: Promise<string> | null = null;
  private lastDeployedEndpoint: string | null = null;
  private proxyAuthToken: string | null;

  constructor(options?: ModalClientOptions) {
    super(options);
    this.workspace = options?.workspace ?? null;
    this.defaultFunctionName = options?.defaultFunctionName ?? 'web';
    this.proxyAuthToken = options?.proxyAuthToken ?? process.env.MODAL_PROXY_SECRET ?? null;
  }

  private async getWorkspace(credentials: ProviderCredentials): Promise<string> {
    if (this.workspace) return this.workspace;
    if (this.workspacePromise) return this.workspacePromise;

    this.workspacePromise = (async () => {
      try {
        const env = buildModalEnv(credentials.apiKey);
        const { stdout } = await (await getExecFileAsync())(
          'python3', ['-m', 'modal', 'profile', 'current'],
          { env, timeout: 10_000 },
        );
        this.workspace = stdout.trim();
        return this.workspace;
      } catch {
        const { tokenId } = splitModalKey(credentials.apiKey);
        this.workspace = tokenId.replace(/^ak-/, '');
        return this.workspace;
      }
    })();
    return this.workspacePromise;
  }

  async discoverInstance(
    credentials: ProviderCredentials,
    gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    const instances = await this.listInstances(credentials);
    const nameFilter = gpuTypes[0] ?? '';

    const candidates = nameFilter
      ? instances.filter(i => i.instanceName?.includes(nameFilter))
      : instances;

    const found = candidates.find(i => i.status === 'running')
      ?? candidates.find(i => i.status === 'deployed')
      ?? null;

    if (!found) return null;

    if (found.status === 'deployed' && found.endpoint) {
      return { ...found, status: 'running' };
    }
    return found;
  }

  /**
   * Deploy a Modal app via `modal deploy`.
   * spec.dockerImage should be the path to the modal .py file (e.g. "dockers/modal/babelcast.py")
   *
   * Supports rolling deploys (default), version tagging, named deploys, and environment targeting.
   */
  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    _userId?: string,
    deployOpts?: ModalDeployOptions,
  ): Promise<GpuInstance> {
    const deployFile = spec.dockerImage;
    if (!deployFile) {
      throw new Error('[modal] createInstance requires spec.dockerImage to be the path to a modal .py deploy file');
    }

    const env = buildModalEnv(credentials.apiKey);
    const args = ['-m', 'modal', 'deploy', deployFile];

    const strategy = deployOpts?.strategy ?? spec.env?.MODAL_DEPLOY_STRATEGY ?? 'rolling';
    args.push('--strategy', strategy);

    if (deployOpts?.tag) {
      args.push('--tag', deployOpts.tag);
    }
    if (deployOpts?.name) {
      args.push('--name', deployOpts.name);
    }
    if (deployOpts?.env) {
      args.push('--env', deployOpts.env);
    }

    try {
      const { stdout, stderr } = await (await getExecFileAsync())(
        'python3', args,
        { env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
      );

      const urlMatch = (stdout + stderr).match(/https:\/\/[^\s]+\.modal\.run/);
      const endpoint = urlMatch?.[0] ?? '';
      this.log.log(`[modal] deploy strategy=${strategy} tag=${deployOpts?.tag ?? '-'} stdout len=${stdout.length} stderr len=${stderr.length} urlMatch=${endpoint || '(none)'} deployFile=${deployFile}`);
      if (endpoint) this.lastDeployedEndpoint = endpoint;

      const workspace = await this.getWorkspace(credentials);

      const instances = await this.listInstances(credentials);
      const appName = deployFile.match(/(?:modal_)?(\w+)\.py/)?.[1] ?? 'unknown';
      const found =
        instances.find(i => i.instanceName?.includes(appName)) ??
        instances.find(i => i.status === 'deployed');

      return {
        instanceId: found?.instanceId ?? `modal-${appName}`,
        instanceName: found?.instanceName ?? appName,
        endpoint: endpoint || buildEndpointUrl(workspace, found?.instanceName ?? appName, this.defaultFunctionName),
        status: 'deployed',
      };
    } catch (err) {
      throw new Error(`[modal] deploy failed: ${this.errMsg(err).substring(0, 300)}`);
    }
  }

  /**
   * Start a Modal app by verifying it exists and triggering a warmup probe.
   * The warmup probe hits the endpoint to pre-trigger snapshot restore,
   * so the first real request doesn't pay the cold-start penalty.
   */
  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const status = await this.getInstanceStatus(instanceId, credentials);
    if (!status) {
      throw new Error(`[modal] app ${instanceId} not found — deploy first`);
    }
    if (status === 'stopped') {
      this.log.warn(`[modal] app ${instanceId} is stopped — may need re-deploy`);
    }

    // Warmup probe: hit the endpoint to trigger snapshot restore
    const endpoint = await this.resolveInstanceEndpoint(instanceId, credentials);
    if (endpoint) {
      await this.warmupProbe(endpoint);
    }
  }

  /**
   * Send a lightweight HTTP request to the endpoint to trigger
   * snapshot restore and container warmup before real traffic arrives.
   */
  private async warmupProbe(endpoint: string): Promise<void> {
    const healthPaths = ['/health', '/v1/models', '/'];
    for (const path of healthPaths) {
      try {
        const headers: Record<string, string> = {};
        if (this.proxyAuthToken) {
          const [key, secret] = this.proxyAuthToken.split(':');
          headers['Modal-Key'] = key;
          headers['Modal-Secret'] = secret || key;
        }
        const res = await fetch(`${endpoint}${path}`, {
          method: 'GET',
          signal: AbortSignal.timeout(30_000),
          headers,
        });
        if (res.ok || res.status === 404) {
          this.log.log(`[modal] warmup probe ${path} → ${res.status} (container warmed)`);
          return;
        }
      } catch {
        // Try next path
      }
    }
    this.log.warn(`[modal] warmup probe failed for ${endpoint} — first request may have cold start`);
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const env = buildModalEnv(credentials.apiKey);
    try {
      await (await getExecFileAsync())(
        'python3', ['-m', 'modal', 'app', 'stop', instanceId],
        { env, timeout: 30_000 },
      );
    } catch (err) {
      throw new Error(`[modal] stop failed for ${instanceId}: ${this.errMsg(err).substring(0, 300)}`);
    }
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.stopInstance(instanceId, credentials);
  }

  async getInstanceStatus(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const instances = await this.listInstances(credentials);
    const found = instances.find((i) => i.instanceId === instanceId);
    return found?.status ?? null;
  }

  async resolveInstanceEndpoint(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    if (this.lastDeployedEndpoint) return this.lastDeployedEndpoint;
    const instances = await this.listInstances(credentials);
    const found = instances.find((i) => i.instanceId === instanceId);
    return found?.endpoint || null;
  }

  /**
   * Dynamically update autoscaler settings without redeploying the app.
   * Uses a small Python script that calls Function.update_autoscaler().
   *
   * Settings revert to the decorator config on next deploy.
   */
  async updateAutoscaler(
    instanceId: string,
    credentials: ProviderCredentials,
    params: ModalAutoscalerParams,
  ): Promise<void> {
    const env = buildModalEnv(credentials.apiKey);

    const parts: string[] = [];
    if (params.minContainers !== undefined) parts.push(`min_containers=${params.minContainers}`);
    if (params.bufferContainers !== undefined) parts.push(`buffer_containers=${params.bufferContainers}`);
    if (params.maxContainers !== undefined) parts.push(`max_containers=${params.maxContainers}`);

    if (parts.length === 0) {
      this.log.warn('[modal] updateAutoscaler called with no parameters');
      return;
    }

    const script = `import modal; app = modal.App.lookup("${instanceId}"); fns = list(app.registered_functions); fn = fns[0] if fns else None; fn and fn.update_autoscaler(${parts.join(', ')}); print("autoscaler updated")`;

    try {
      const { stdout } = await (await getExecFileAsync())(
        'python3', ['-c', script],
        { env, timeout: 30_000 },
      );
      this.log.log(`[modal] autoscaler updated for ${instanceId}: ${parts.join(', ')} stdout=${stdout.trim()}`);
    } catch (err) {
      throw new Error(`[modal] updateAutoscaler failed for ${instanceId}: ${this.errMsg(err).substring(0, 300)}`);
    }
  }

  /**
   * Lists all deployed Modal apps using the CLI.
   * Now populates endpoint URLs using workspace + app name.
   */
  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const env = buildModalEnv(credentials.apiKey);
    const workspace = await this.getWorkspace(credentials);

    try {
      try {
        const { stdout: jsonOut } = await (await getExecFileAsync())(
          'python3', ['-m', 'modal', 'app', 'list', '--json'],
          { env, timeout: 30_000 },
        );
        const apps = JSON.parse(jsonOut) as Array<Record<string, unknown>>;
        if (Array.isArray(apps)) {
          return apps.map((app) => this.parseApp(app, workspace));
        }
      } catch {
        // --json not supported, fall through to table parsing
      }

      const { stdout } = await (await getExecFileAsync())(
        'python3', ['-m', 'modal', 'app', 'list'],
        { env, timeout: 30_000 },
      );

      return this.parseTableOutput(stdout, workspace);
    } catch (err) {
      this.log.warn('[modal] listInstances failed:', this.errMsg(err));
      return [];
    }
  }

  private parseApp(app: Record<string, unknown>, workspace: string): GpuInstance {
    const appId = (app['App ID'] ?? app.app_id ?? app.id ?? '') as string;
    const desc = (app['Description'] ?? app.description ?? app.name ?? '') as string;
    const tasks = parseInt(String(app['Tasks'] ?? app.tasks ?? '0'), 10) || 0;
    const state = (app['State'] ?? app.state ?? 'unknown') as string;
    const status = tasks > 0 ? 'running' : state;

    return {
      instanceId: appId,
      instanceName: desc,
      endpoint: status !== 'stopped' ? buildEndpointUrl(workspace, desc, this.defaultFunctionName) : '',
      status,
      gpuType: undefined,
    };
  }

  private parseTableOutput(output: string, workspace: string): GpuInstance[] {
    const results: GpuInstance[] = [];

    for (const line of output.split('\n')) {
      const match = line.match(/ap-[A-Za-z0-9]+/);
      if (!match) continue;

      const cells = line
        .split('│')
        .map((c) => c.trim())
        .filter(Boolean);

      if (cells.length < 4) continue;

      const appId = cells[0].trim();
      const description = cells[1]?.trim() || '';
      const state = cells[2]?.trim() || 'unknown';
      const tasks = parseInt(cells[3]?.trim() || '0', 10) || 0;

      if (!appId.startsWith('ap-')) continue;

      const status = tasks > 0 ? 'running' : state;

      results.push({
        instanceId: appId,
        instanceName: description,
        endpoint: status !== 'stopped' ? buildEndpointUrl(workspace, description, this.defaultFunctionName) : '',
        status,
        gpuType: undefined,
      });
    }

    return results;
  }

  /** List available GPU tiers with published Modal pricing (static). */
  async listOffers(options: ListOffersOptions, _credentials: ProviderCredentials): Promise<GpuOffer[]> {
    const staticGpus: Array<{ name: string; vram: number; price: number }> = [
      { name: 'NVIDIA T4', vram: 16, price: 0.59 },
      { name: 'NVIDIA L4', vram: 24, price: 0.80 },
      { name: 'NVIDIA A10G', vram: 24, price: 1.10 },
      { name: 'NVIDIA A100 40GB', vram: 40, price: 3.73 },
      { name: 'NVIDIA A100 80GB', vram: 80, price: 4.58 },
      { name: 'NVIDIA H100', vram: 80, price: 4.89 },
    ];

    const filterSet = options.gpuTypes?.length
      ? new Set(options.gpuTypes.map(t => t.toLowerCase()))
      : null;

    const offers: GpuOffer[] = [];
    for (const gpu of staticGpus) {
      if (filterSet) {
        const nameKey = gpu.name.toLowerCase().replace(/\s+/g, '');
        const matches = [...filterSet].some(f => nameKey.includes(f.toLowerCase().replace(/\s+/g, '')));
        if (!matches) continue;
      }
      offers.push({
        provider: 'modal',
        gpuType: gpu.name.replace('NVIDIA ', ''),
        gpuName: gpu.name,
        available: -1,
        pricePerHr: gpu.price,
        region: 'us',
        vram: gpu.vram,
      });
    }

    return offers.slice(0, options.limit ?? 100);
  }
}
