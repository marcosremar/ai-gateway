/**
 * Railway provider — manage services / deployments for CPU workloads.
 *
 * API: https://backboard.railway.com/graphql/v2
 * Auth: Bearer RAILWAY_TOKEN or RAILWAY_API_TOKEN (account or project token).
 * Fallback: shells out to `railway api` using the local CLI login session.
 *
 * Env:
 *   RAILWAY_TOKEN / RAILWAY_API_TOKEN
 *   RAILWAY_PROJECT_ID          (required for list/create)
 *   RAILWAY_ENVIRONMENT_ID      (optional — auto-resolved from project)
 *   RAILWAY_SERVICE_PREFIX      (default: aigw-bot)
 */

import { AbstractGpuProvider, TIMEOUTS } from '../gpu-providers/abstract-provider';
import type { AbstractGpuProviderOptions } from '../gpu-providers/abstract-provider';
import type { GpuInstance, InstanceSpec, ProviderCredentials } from '../gpu-providers/types';
import { normalizeInstanceStatus } from '../gateway/providers/gpu/instance-status';

const RAILWAY_GQL = process.env.RAILWAY_API_BASE || 'https://backboard.railway.com/graphql/v2';
const DEFAULT_PREFIX = 'aigw-bot';

type GqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

export class RailwayClient extends AbstractGpuProvider {
  readonly providerId = 'railway';
  readonly bootTimeSecs = 45;

  constructor(opts?: AbstractGpuProviderOptions) {
    super(opts);
  }

  private token(credentials?: ProviderCredentials): string {
    return (
      credentials?.apiKey ||
      process.env.RAILWAY_TOKEN ||
      process.env.RAILWAY_API_TOKEN ||
      ''
    );
  }

  private projectId(): string {
    const id = process.env.RAILWAY_PROJECT_ID || '';
    if (!id) throw new Error('RAILWAY_PROJECT_ID required');
    return id;
  }

  private prefix(): string {
    return process.env.RAILWAY_SERVICE_PREFIX || DEFAULT_PREFIX;
  }

  /** Run a GraphQL operation via Bearer token or `railway api` CLI fallback. */
  async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
    credentials?: ProviderCredentials,
  ): Promise<T> {
    const token = this.token(credentials);
    if (token) {
      const body = await this.fetchJson<GqlResponse<T>>(
        RAILWAY_GQL,
        {
          method: 'POST',
          headers: this.jsonHeaders(token),
          body: JSON.stringify({ query, variables }),
        },
        TIMEOUTS.read,
        'railway',
      );
      if (body.errors?.length) {
        throw new Error(`Railway GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
      }
      if (!body.data) throw new Error('Railway GraphQL: empty data');
      return body.data;
    }

    // CLI fallback — uses the interactive `railway login` session.
    const qFile = `/tmp/aigw-railway-q-${Date.now()}.graphql`;
    const vFile = `/tmp/aigw-railway-v-${Date.now()}.json`;
    await Bun.write(qFile, query);
    await Bun.write(vFile, JSON.stringify(variables));
    try {
      const proc = Bun.spawn(
        ['railway', 'api', '--compact', '-f', qFile, '--variables', `@${vFile}`],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(
          `railway api failed (${exitCode}): ${stderr.slice(0, 400) || stdout.slice(0, 400)}`,
        );
      }
      const body = JSON.parse(stdout) as GqlResponse<T>;
      if (body.errors?.length) {
        throw new Error(`Railway GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
      }
      if (!body.data) throw new Error('Railway GraphQL: empty data');
      return body.data;
    } finally {
      try {
        if (await Bun.file(qFile).exists()) await Bun.write(qFile, '');
      } catch {
        /* ignore */
      }
    }
  }

  async resolveEnvironmentId(credentials?: ProviderCredentials): Promise<string> {
    if (process.env.RAILWAY_ENVIRONMENT_ID) return process.env.RAILWAY_ENVIRONMENT_ID;
    const data = await this.graphql<{
      project: { environments: { edges: Array<{ node: { id: string; name: string } }> } };
    }>(
      `query($id: String!) {
        project(id: $id) {
          environments { edges { node { id name } } }
        }
      }`,
      { id: this.projectId() },
      credentials,
    );
    const envs = data.project?.environments?.edges?.map((e) => e.node) ?? [];
    const prod = envs.find((e) => e.name.toLowerCase() === 'production') ?? envs[0];
    if (!prod) throw new Error('Railway: no environments on project');
    return prod.id;
  }

  async listProjects(credentials?: ProviderCredentials): Promise<Array<{ id: string; name: string }>> {
    const data = await this.graphql<{
      projects: { edges: Array<{ node: { id: string; name: string } }> };
    }>(
      `query {
        projects { edges { node { id name } } }
      }`,
      {},
      credentials,
    );
    return data.projects?.edges?.map((e) => e.node) ?? [];
  }

  async listInstances(credentials: ProviderCredentials): Promise<GpuInstance[]> {
    try {
      const envId = await this.resolveEnvironmentId(credentials);
      const data = await this.graphql<{
        project: {
          services: { edges: Array<{ node: { id: string; name: string } }> };
        };
      }>(
        `query($id: String!) {
          project(id: $id) {
            services { edges { node { id name } } }
          }
        }`,
        { id: this.projectId() },
        credentials,
      );
      const services = data.project?.services?.edges?.map((e) => e.node) ?? [];
      const prefix = this.prefix();
      const owned = services.filter((s) => s.name.startsWith(prefix) || s.name.includes('aigw'));
      const out: GpuInstance[] = [];
      for (const svc of owned.length ? owned : services) {
        const status = await this.getInstanceStatus(svc.id, credentials).catch(() => 'unknown');
        out.push({
          instanceId: svc.id,
          instanceName: svc.name,
          endpoint: '',
          status: normalizeInstanceStatus(status),
          providerMeta: { provider: 'railway', environmentId: envId, serviceName: svc.name },
        });
      }
      return out;
    } catch (err) {
      this.log.log(`[railway] listInstances failed: ${this.errMsg(err)}`);
      return [];
    }
  }

  async discoverInstance(
    credentials: ProviderCredentials,
    _gpuTypes: string[],
  ): Promise<GpuInstance | null> {
    const instances = await this.listInstances(credentials);
    return instances.find((i) => i.status === 'running') ?? instances[0] ?? null;
  }

  async createInstance(
    spec: InstanceSpec,
    credentials: ProviderCredentials,
  ): Promise<GpuInstance> {
    const image =
      spec.dockerImage ||
      process.env.BOT_DOCKER_IMAGE ||
      process.env.RAILWAY_BOT_IMAGE ||
      'ghcr.io/railwayapp/node:20-slim';
    const name = `${this.prefix()}-${Date.now()}`;
    const envId = await this.resolveEnvironmentId(credentials);

    const created = await this.graphql<{
      serviceCreate: { id: string; name: string };
    }>(
      `mutation($input: ServiceCreateInput!) {
        serviceCreate(input: $input) { id name }
      }`,
      {
        input: {
          projectId: this.projectId(),
          name,
          source: { image },
        },
      },
      credentials,
    );

    const serviceId = created.serviceCreate.id;
    this.log.log(`[railway] Service created: ${serviceId} (${name}) image=${image}`);

    // Trigger deploy into the environment
    try {
      await this.graphql(
        `mutation($environmentId: String!, $serviceId: String!) {
          serviceInstanceDeploy(environmentId: $environmentId, serviceId: $serviceId)
        }`,
        { environmentId: envId, serviceId },
        credentials,
      );
    } catch (err) {
      this.log.log(`[railway] deploy trigger: ${this.errMsg(err)}`);
    }

    return {
      instanceId: serviceId,
      instanceName: name,
      endpoint: '',
      status: normalizeInstanceStatus('starting'),
      providerMeta: {
        provider: 'railway',
        environmentId: envId,
        dockerImage: image,
        serviceName: name,
      },
    };
  }

  async startInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    const envId = await this.resolveEnvironmentId(credentials);
    await this.graphql(
      `mutation($environmentId: String!, $serviceId: String!) {
        serviceInstanceDeploy(environmentId: $environmentId, serviceId: $serviceId)
      }`,
      { environmentId: envId, serviceId: instanceId },
      credentials,
    );
    this.log.log(`[railway] Redeployed service ${instanceId}`);
  }

  async stopInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    // Railway has no soft-stop for image services — remove latest deployment if possible.
    const envId = await this.resolveEnvironmentId(credentials);
    try {
      await this.graphql(
        `mutation($environmentId: String!, $serviceId: String!) {
          serviceInstanceRemove(environmentId: $environmentId, serviceId: $serviceId)
        }`,
        { environmentId: envId, serviceId: instanceId },
        credentials,
      );
      this.log.log(`[railway] Removed service instance ${instanceId}`);
    } catch (err) {
      this.log.log(`[railway] stopInstance fallback note: ${this.errMsg(err)}`);
      throw err;
    }
  }

  async deleteInstance(instanceId: string, credentials: ProviderCredentials): Promise<void> {
    await this.graphql(
      `mutation($id: String!) { serviceDelete(id: $id) }`,
      { id: instanceId },
      credentials,
    );
    this.log.log(`[railway] Deleted service ${instanceId}`);
  }

  async getInstanceStatus(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<string | null> {
    const envId = await this.resolveEnvironmentId(credentials);
    try {
      const data = await this.graphql<{
        deployments: {
          edges: Array<{
            node: { id: string; status: string; staticUrl?: string | null };
          }>;
        };
      }>(
        `query($input: DeploymentListInput!) {
          deployments(input: $input) {
            edges { node { id status staticUrl } }
          }
        }`,
        { input: { serviceId: instanceId, environmentId: envId } },
        credentials,
      );
      const node = data.deployments?.edges?.[0]?.node;
      if (!node) return 'unknown';
      return normalizeInstanceStatus(node.status);
    } catch {
      return null;
    }
  }

  async resolveInstanceEndpoint(
    instanceId: string,
    credentials: ProviderCredentials,
  ): Promise<string | null> {
    const envId = await this.resolveEnvironmentId(credentials);
    try {
      const data = await this.graphql<{
        deployments: {
          edges: Array<{ node: { staticUrl?: string | null } }>;
        };
      }>(
        `query($input: DeploymentListInput!) {
          deployments(input: $input) {
            edges { node { staticUrl } }
          }
        }`,
        { input: { serviceId: instanceId, environmentId: envId } },
        credentials,
      );
      const url = data.deployments?.edges?.[0]?.node?.staticUrl;
      return url ? (url.startsWith('http') ? url : `https://${url}`) : null;
    } catch {
      return null;
    }
  }
}
