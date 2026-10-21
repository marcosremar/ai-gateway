import type { IncomingMessage } from 'http';
import { join } from 'path';
import { RailwayClient } from '../cpu-providers/railway-client';
import { activeWindow } from '../deployments/autoscale';
import { DECLARED_DEPLOYMENTS } from '../deployments/declared';
import { realMachinesAllowed } from '../deployments/real-machines';
import { readStateFile, writeStateFile } from '../deployments/state-file';
import type { WarmScheduleEntry } from '../deployments/types';
import { createCallsRoutes } from './http';
import { livekitBackend } from './livekit';
import parle from './parle.json';
import { railwayPower } from './railway-power';
import { CallsService, type Caller, type CallsBackend, type CallsState, type LivekitServer } from './service';

export { CallsService, CallsError, MAX_TTL_SECONDS, RETRY_AFTER_MS } from './service';
export type { Caller, CallPhase, CallServer, CallsBackend, CallsPower, CallsState, LivekitServer, RoomLoad, TokenGrant } from './service';
export { createCallsRoutes } from './http';
export { railwayPower, isRunning, redeployTarget } from './railway-power';
export type { RailwayDeployment } from './railway-power';

type Env = Record<string, string | undefined>;
export const CALLS_CONFIG = parle;
export const CALLS_TICK_MS = 60_000;

function serverOf(env: Env, prefix: string): LivekitServer | null {
  const url = env[`${prefix}_URL`]?.trim(), apiKey = env[`${prefix}_API_KEY`]?.trim(), apiSecret = env[`${prefix}_API_SECRET`]?.trim();
  return url && apiKey && apiSecret ? { url, apiKey, apiSecret } : null;
}

export function classOpenFor(app: string): (now: number) => boolean {
  const schedules = DECLARED_DEPLOYMENTS.filter(d => d.app === app).map(d => d.spec.warmSchedule as WarmScheduleEntry[] | undefined);
  return (now) => schedules.some(s => activeWindow(s, now) !== null);
}

export interface CreateCallsOptions {
  env: Env;
  stateDir: string;
  callerOf: (req: IncomingMessage) => Caller | null;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  backend?: CallsBackend;
}

export async function createCalls(opts: CreateCallsOptions) {
  const { env, log } = opts;
  const own = serverOf(env, 'LIVEKIT');
  if (!own) return null;
  const token = env.RAILWAY_API_TOKEN?.trim();
  const projectId = env.LIVEKIT_RAILWAY_PROJECT_ID?.trim() || env.RAILWAY_PROJECT_ID?.trim();
  const client = new RailwayClient();
  const power = realMachinesAllowed(env) && token && projectId
    ? railwayPower({ graphql: client.graphql.bind(client), token, projectId, environment: parle.environment, services: parle.services, log })
    : null;
  const path = join(opts.stateDir, 'calls.json');
  const stored = await readStateFile<Partial<CallsState>>(path).then(r => r.data ?? {}, () => ({}));
  const service = new CallsService({
    app: parle.app, own, cloud: serverOf(env, 'LIVEKIT_RESERVE'), backend: opts.backend ?? livekitBackend, power,
    classOpen: classOpenFor(parle.app), idleMinutes: parle.idleMinutes,
    cloudBudgetMinutes: Number(env.LIVEKIT_CLOUD_BUDGET_MINUTES) > 0 ? Number(env.LIVEKIT_CLOUD_BUDGET_MINUTES) : parle.cloudBudgetMinutes,
    state: stored, save: (s) => writeStateFile(path, JSON.stringify(s)), log,
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    service,
    power: power !== null,
    routes: createCallsRoutes(service, opts.callerOf),
    start() { timer ??= setInterval(() => { void service.tick(); }, CALLS_TICK_MS); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
