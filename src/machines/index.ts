import { homedir } from 'os';
import { join } from 'path';
import type { IncomingMessage } from 'http';
import { ScalewayClient } from '../cpu-providers/scaleway-client';
import { VastDeploymentBackend } from '../deployments/vast-backend';
import { RunpodMachineBackend, ScalewayMachineBackend, VastMachineBackend } from './backends';
import { MachineController } from './controller';
import { createMachineRoutes, jobReportRoute } from './http';
import { MachineStore } from './store';
import type { MachineBackend, MachineLimits, MachineProvider } from './types';

export { MachineController } from './controller';
export { createMachineRoutes, jobReportRoute } from './http';
export { MachineStore } from './store';
export { MachineError, parseMachineInput, parseJobInput } from './spec';
export { RunpodMachineBackend, ScalewayMachineBackend, VastMachineBackend, machineLabel, parseMachineLabel } from './backends';
export { reapMachines, ownedMachinesFromGateway } from './reaper';
export type * from './types';

type Env = Record<string, string | undefined>;

function num(raw: string | undefined, fallback: number, min = 0): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n >= min ? n : fallback;
}

export function machineLimitsFromEnv(env: Env): MachineLimits {
  return {
    maxHours: num(env.MACHINES_MAX_HOURS, 24, 0.1),
    maxLifetimeHours: num(env.MACHINES_MAX_LIFETIME_HOURS, 72, 0.1),
    defaultIdleMinutes: num(env.MACHINES_IDLE_MINUTES, 30, 5),
    maxUsdPerHour: num(env.MACHINES_MAX_USD_PER_HOUR, 2, 0.001),
    maxRunning: Math.floor(num(env.MACHINES_MAX_RUNNING, 20, 1)),
    ownerUsdPerDay: num(env.MACHINES_OWNER_USD_PER_DAY, 10),
    ownerUsdPerMonth: num(env.MACHINES_OWNER_USD_PER_MONTH, 150),
    holderUsdPerDay: num(env.MACHINES_HOLDER_USD_PER_DAY, 6),
    globalUsdPerDay: num(env.MACHINES_USD_PER_DAY, 20),
    createTimeoutMs: num(env.MACHINES_CREATE_TIMEOUT_MINUTES, 15, 1) * 60_000,
  };
}

export function machineBackendsFromEnv(env: Env, opts: { awaitVolumes?: boolean } = {}): Partial<Record<MachineProvider, MachineBackend>> {
  const scwSecret = () => (env.SCW_SECRET_KEY || env.SCALEWAY_SECRET_KEY || '').trim();
  const scwProject = () => env.SCW_DEFAULT_PROJECT_ID || env.SCW_PROJECT_ID || env.SCALEWAY_PROJECT_ID || undefined;
  const vastKey = env.VAST_API_KEY?.trim();
  return {
    ...(scwSecret() ? { scaleway: new ScalewayMachineBackend(new ScalewayClient(), scwSecret, scwProject, opts.awaitVolumes === true) } : {}),
    ...(vastKey ? { vast: new VastMachineBackend(new VastDeploymentBackend(vastKey)) } : {}),
    ...(env.RUNPOD_API_KEY?.trim() ? { runpod: new RunpodMachineBackend(() => (env.RUNPOD_API_KEY ?? '').trim()) } : {}),
  };
}

export function machinesFromEnv(env: Env, opts: {
  userOf: (req: IncomingMessage) => string | null;
  isAdmin: (req: IncomingMessage) => boolean;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  onRailway: boolean;
}) {
  if (env.MACHINES_ENABLED === '0') return null;
  const backends = machineBackendsFromEnv(env);
  if (!Object.keys(backends).length) return null;
  if (!env.DEPLOYMENTS_NAMESPACE?.trim() && !opts.onRailway) {
    opts.log?.('Machines disabled: set DEPLOYMENTS_NAMESPACE when running outside Railway');
    return null;
  }
  const controller = new MachineController({
    backends,
    store: MachineStore.inDir(env.DEPLOYMENTS_STATE_DIR || join(homedir(), '.ai-gateway')),
    namespace: env.DEPLOYMENTS_NAMESPACE || 'default',
    limits: machineLimitsFromEnv(env),
    publicUrl: env.AIGW_PUBLIC_URL?.trim() || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined),
    ...(opts.log ? { log: opts.log } : {}),
  });
  const allowedUsers = new Set((env.MACHINES_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean));
  const handler = createMachineRoutes({ controller, userOf: opts.userOf, isAdmin: opts.isAdmin, allowedUsers });
  return { controller, handler, reportRoute: jobReportRoute(controller) };
}
