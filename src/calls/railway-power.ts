import type { ProviderCredentials } from '../gpu-providers/types';
import type { CallsPower } from './service';

type Graphql = <T>(query: string, variables: Record<string, unknown>, credentials?: ProviderCredentials) => Promise<T>;

export interface RailwayDeployment { id: string; status: string; deploymentStopped: boolean; meta?: { imageDigest?: string } | null }

export interface RailwayPowerOptions {
  graphql: Graphql;
  token: string;
  projectId: string;
  environment: string;
  services: string[];
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const RUNNING = new Set(['SUCCESS', 'DEPLOYING', 'INITIALIZING', 'BUILDING', 'QUEUED', 'WAITING']);

export function isRunning(d: RailwayDeployment | undefined): boolean {
  return Boolean(d && !d.deploymentStopped && RUNNING.has(d.status));
}

export function redeployTarget(list: RailwayDeployment[]): RailwayDeployment | null {
  return list.find(d => d.meta?.imageDigest) ?? list[0] ?? null;
}

export function railwayPower(opts: RailwayPowerOptions): CallsPower & { deployments(service: string): Promise<RailwayDeployment[]> } {
  const credentials = { apiKey: opts.token };
  const gql = <T>(query: string, variables: Record<string, unknown>) => opts.graphql<T>(query, variables, credentials);
  let ids: Promise<{ environmentId: string; services: Map<string, string> }> | null = null;

  const resolve = () => (ids ??= gql<{ project: { environments: { edges: Array<{ node: { id: string; name: string } }> }; services: { edges: Array<{ node: { id: string; name: string } }> } } }>(
    'query($id: String!) { project(id: $id) { environments { edges { node { id name } } } services { edges { node { id name } } } } }',
    { id: opts.projectId },
  ).then(({ project }) => {
    const environmentId = project.environments.edges.find(e => e.node.name === opts.environment)?.node.id;
    if (!environmentId) throw new Error(`Railway: no environment '${opts.environment}' in project ${opts.projectId}`);
    const services = new Map(project.services.edges.map(e => [e.node.name, e.node.id]));
    const missing = opts.services.filter(s => !services.has(s));
    if (missing.length) throw new Error(`Railway: no service ${missing.join(', ')} in project ${opts.projectId}`);
    return { environmentId, services };
  }).catch((err: unknown) => { ids = null; throw err; }));

  async function deployments(service: string): Promise<RailwayDeployment[]> {
    const { environmentId, services } = await resolve();
    const data = await gql<{ deployments: { edges: Array<{ node: RailwayDeployment }> } }>(
      'query($input: DeploymentListInput!) { deployments(input: $input, first: 5) { edges { node { id status deploymentStopped meta } } } }',
      { input: { serviceId: services.get(service), environmentId } },
    );
    return data.deployments.edges.map(e => e.node);
  }

  return {
    deployments,
    async start() {
      const started: string[] = [];
      for (const service of opts.services) {
        const list = await deployments(service);
        if (isRunning(list[0])) continue;
        const target = redeployTarget(list);
        if (!target) throw new Error(`Railway: ${service} has no deployment to redeploy`);
        await gql('mutation($id: String!) { deploymentRedeploy(id: $id, usePreviousImageTag: true) { id } }', { id: target.id });
        opts.log?.('calls.railway.redeploy', { service, from: target.id });
        started.push(service);
      }
      return started;
    },
    async stop() {
      const stopped: string[] = [];
      for (const service of [...opts.services].reverse()) {
        for (const d of (await deployments(service)).filter(isRunning)) {
          await gql('mutation($id: String!) { deploymentStop(id: $id) }', { id: d.id });
          opts.log?.('calls.railway.stop', { service, deployment: d.id });
          if (!stopped.includes(service)) stopped.push(service);
        }
      }
      return stopped;
    },
  };
}
