import type { IncomingMessage } from 'http';
import { join } from 'path';
import { DeploymentController } from '../../src/deployments/controller';
import { HttpReplicaProbe } from '../../src/deployments/http';
import { MemoryDeploymentStore } from '../../src/deployments/store';
import { ApiKeyRegistry } from '../../src/gateway/proxy/middleware/api-keys';
import { startProxy } from '../../src/gateway/proxy/server';
import { createRealtime } from '../../src/realtime';
import { createS2SRoute } from '../../src/s2s/route';
import { realtimeSinkToTelemetry, sessionResolverFrom, setGatewayTelemetrySink, telemetryFromEnv } from '../../src/telemetry';
import { freePort, LocalEdgeCloud } from './local-cloud';

const TURN_SECRET = 'e2e-turn-secret-0123456789';
const TURN_PORT = 3478;

export interface LocalStackOptions {
  python: string;
  work: string;
  keys: string[];
  deployment: string;
  maxSessions: number;
  maxTotalReplicas?: number;
  hostname?: string;
  realtimeEnv?: Record<string, string>;
  modelScript?: string;
  log: (line: string) => void;
}

export async function startLocalStack(o: LocalStackOptions) {
  const { log } = o;
  const lanIp = Bun.spawnSync(['ip', '-4', '-o', 'addr', 'show', 'scope', 'global']).stdout.toString().match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1] ?? '127.0.0.1';
  let coturn: ReturnType<typeof Bun.spawn> | null = null;
  const startCoturn = () => {
    coturn = Bun.spawn(['turnserver', '-n', `--listening-ip=${lanIp}`, `--relay-ip=${lanIp}`, `--listening-port=${TURN_PORT}`,
      '--min-port=49000', '--max-port=49400', '--use-auth-secret', `--static-auth-secret=${TURN_SECRET}`, '--realm=aigw-e2e',
      '--no-cli', '--no-tls', '--no-dtls', '--log-file=stdout', '--simple-log', '--fingerprint'], { stdout: 'pipe', stderr: 'pipe' });
  };
  const stopCoturn = () => { coturn?.kill('SIGKILL'); coturn = null; };

  const gwPort = await freePort();
  const gw = `http://127.0.0.1:${gwPort}`;
  const keyRegistry = new ApiKeyRegistry(o.keys.join(','));
  const userOfReq = (req: IncomingMessage) => keyRegistry.resolve(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))?.userId ?? null;
  const cloud = new LocalEdgeCloud({ python: o.python, gatewayUrl: () => gw, maxSessions: o.maxSessions, log, modelScript: o.modelScript });
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(2000), namespace: 'e2e', reconcileMs: 300,
    maxTotalReplicas: o.maxTotalReplicas ?? 6, log: (msg, data) => log(`controller ${msg} ${data ? JSON.stringify(data) : ''}`),
  });
  await controller.init();
  controller.start();

  let realtimeSessionOf: ((token: string) => { sid: string; app: string; dep: string; rep: string } | null) | null = null;
  const telemetry = telemetryFromEnv({ TELEMETRY_DIR: join(o.work, 'telemetry') }, {
    auth: {
      resolveAppKey: (token) => keyRegistry.resolve(token)?.userId ?? null,
      isMasterKey: () => false,
      deployment: (name) => {
        const replicaToken = controller.tokenOf(name);
        const app = controller.get(name)?.app;
        return replicaToken ? { replicaToken, ...(app ? { app } : {}) } : null;
      },
      replica: (id) => controller.replicaAuth(id) ?? null,
      resolveSessionToken: (token) => realtimeSessionOf?.(token) ?? null,
    },
    isAdminToken: (t) => keyRegistry.resolve(t)?.userId === 'admin',
    log: (msg, data) => log(`telemetry ${msg} ${data ? JSON.stringify(data) : ''}`),
  })!;
  await telemetry.start();
  setGatewayTelemetrySink((event) => telemetry.ingest.ingestOwn(event));

  const s2sRoute = createS2SRoute({
    controller, deployment: o.deployment,
    stagesFor: () => { throw new Error('no composed fallback in the e2e'); },
    log: (msg, data) => log(`s2s ${msg} ${data ? JSON.stringify(data) : ''}`),
  });
  const realtime = createRealtime({
    controller, defaultDeployment: o.deployment,
    env: {
      REALTIME_TURN_URLS: `turn:${lanIp}:${TURN_PORT}?transport=udp,turn:${lanIp}:${TURN_PORT}?transport=tcp`, REALTIME_TURN_SECRET: TURN_SECRET,
      ...o.realtimeEnv,
    },
    netProbeMs: 1_000,
    userOf: userOfReq,
    isAdmin: (u) => u === 'admin',
    telemetry: realtimeSinkToTelemetry(telemetry.ingest),
    pollMs: 0,
    log: (msg, data) => log(`realtime ${msg} ${data ? JSON.stringify(data) : ''}`),
  });
  realtimeSessionOf = sessionResolverFrom(realtime.service);
  const gateway = await startProxy({
    port: gwPort, hostname: o.hostname ?? '127.0.0.1', apiKeys: o.keys, providers: {},
    customRoutes: [{ method: 'POST', path: '/v1/s2s', handler: s2sRoute }, realtime.route, ...telemetry.adminRoutes],
    publicRoutes: telemetry.publicRoutes,
  });
  realtime.mount(gateway);

  async function stop(): Promise<void> {
    stopCoturn();
    controller.stop();
    realtime.stop();
    await cloud.closeAll();
    gateway.closeAllConnections?.();
    gateway.close();
    await telemetry.stop?.();
  }

  return { gw, gwPort, lanIp, cloud, controller, startCoturn, stopCoturn, stop };
}
