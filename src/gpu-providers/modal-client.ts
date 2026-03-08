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
 */

import type { GpuInstance, InstanceSpec, ProviderCredentials } from './types';
import { AbstractGpuProvider } from './abstract-provider';
import type { AbstractGpuProviderOptions } from './abstract-provider';

// Lazy-load child_process to avoid breaking browser bundles (Next.js client-side).
// Uses execFile (no shell) to prevent command injection.
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
  return {
    ...process.env,
    MODAL_TOKEN_ID: tokenId,
    MODAL_TOKEN_SECRET: tokenSecret,
    TERM: 'dumb',
    NO_COLOR: '1',
    COLUMNS: '500',
  };
}

/**
 * Build the Modal web endpoint URL.
 * Pattern: https://{workspace}--{appName}-{functionName}.modal.run
 */
function buildEndpointUrl(workspace: string, appName: string, functionName = 'web'): string {
  return `https://${workspace}--${appName}-${functionName}.modal.run`;
}

export interface ModalClientOptions extends AbstractGpuProviderOptions {
  /** Modal workspace name (e.g. "marcosremar"). Auto-detected from CLI if not provided. */
  workspace?: string;
  /** Default ASGI function name in deployed apps. Default: "web" */
  defaultFunctionName?: string;
}

export class ModalClient extends AbstractGpuProvider {
  readonly providerId = 'modal';
  readonly bootTimeSecs = 60; // Modal cold starts are fast (~10-60s)

  private workspace: string | null;
  private defaultFunctionName: string;
  private workspacePromise: Promise<string> | null = null;

  constructor(options?: ModalClientOptions) {
    super(options);
    this.workspace = options?.workspace ?? null;
    this.defaultFunctionName = options?.defaultFunctionName ?? 'web';
  }

  /** Resolve workspace name from CLI profile if not provided */
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
        // Fallback: extract from token ID prefix
        const { tokenId } = splitModalKey(credentials.apiKey);
        this.workspace = tokenId.replace(/^ak-/, '');
        return this.workspace;
      }
    })();
    return this.workspacePromise;
  }

  /**
   * Discover a running or deployed Modal app.
   * gpuTypes[0] can optionally be an app name filter (e.g. "parle-ultralight").
   * Priority: running (active tasks) > deployed (auto-wake ready).
   *
   * "deployed" apps are normalized to status "running" because Modal auto-wakes
   * them on HTTP request — the autoscaler engine treats them as usable.
   */
  async discoverInstance(
    credentials: ProviderCredentials,
    gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    const instances = await this.listInstances(credentials);
    const nameFilter = gpuTypes[0] ?? '';

    // If a name filter is provided, narrow results
    const candidates = nameFilter
      ? instances.filter(i => i.instanceName?.includes(nameFilter))
      : instances;

    // Prefer running (has active tasks) > deployed (auto-wake)
    const found = candidates.find(i => i.status === 'running')
      ?? candidates.find(i => i.status === 'deployed')
      ?? null;

    if (!found) return null;

    // Normalize "deployed" to "running" — Modal auto-wakes on request,
    // so from the autoscaler's perspective a deployed app is usable.
    if (found.status === 'deployed' && found.endpoint) {
      return { ...found, status: 'running' };
    }
    return found;
  }

  /**
   * Deploy a Modal app via `modal deploy`.
   * spec.dockerImage should be the path to the modal .py file (e.g. "spaces/parle-s2s-ultralight/modal_ultralight.py")
   */
  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
    _userId?: string,
  ): Promise<GpuInstance> {
    const deployFile = spec.dockerImage;
    if (!deployFile) {
      throw new Error('[modal] createInstance requires spec.dockerImage to be the path to a modal .py deploy file');
    }

    const env = buildModalEnv(credentials.apiKey);

    try {
      const { stdout, stderr } = await (await getExecFileAsync())(
        'python3', ['-m', 'modal', 'deploy', deployFile],
        { env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
      );

      // Parse the endpoint URL from deploy output
      // Example: "Created web function web => https://marcosremar--parle-ultralight-web.modal.run"
      const urlMatch = (stdout + stderr).match(/https:\/\/[^\s]+\.modal\.run/);
      const endpoint = urlMatch?.[0] ?? '';

      // Parse app name from output or file
      const workspace = await this.getWorkspace(credentials);

      // Get the app ID from listing — match by name first, then status
      const instances = await this.listInstances(credentials);
      const appName = deployFile.match(/modal_(\w+)\.py/)?.[1] ?? 'unknown';
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
   * Modal apps auto-start on invocation. "starting" just means hitting the endpoint
   * to trigger a cold start. We verify with a health check.
   */
  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    // For Modal, the app auto-wakes on request. We just verify it exists.
    const status = await this.getInstanceStatus(instanceId, credentials);
    if (!status) {
      throw new Error(`[modal] app ${instanceId} not found — deploy first`);
    }
    // If stopped, it means the deployment was removed. If deployed, it will auto-wake.
    if (status === 'stopped') {
      this.log.warn(`[modal] app ${instanceId} is stopped — may need re-deploy`);
    }
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

  /** Re-resolve endpoint for a Modal app by looking it up in the app list. */
  async resolveInstanceEndpoint(instanceId: string, credentials: ProviderCredentials): Promise<string | null> {
    const instances = await this.listInstances(credentials);
    const found = instances.find((i) => i.instanceId === instanceId);
    return found?.endpoint || null;
  }

  /**
   * Lists all deployed Modal apps using the CLI.
   * Now populates endpoint URLs using workspace + app name.
   */
  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    const env = buildModalEnv(credentials.apiKey);
    const workspace = await this.getWorkspace(credentials);

    try {
      // Try JSON output first (newer modal CLI versions)
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

  /**
   * Parse table output from `modal app list` (uses Unicode box-drawing characters).
   */
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
}
