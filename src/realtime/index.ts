/**
 * Realtime voice control plane (docs/realtime.md): admission and session tokens, signaling relay for WebRTC (browser ↔
 * GPU replica), WebSocket relay, TURN credentials, and the load report for the autoscaler.
 *
 * `createRealtime(opts)` gives what serve.ts mounts:
 *   - `route`  → customRoutes `POST /v1/realtime/sessions` (behind the proxy's API-key auth: the app's backend calls it);
 *   - `mount(server)` → the token-authenticated browser routes (signaling, WS upgrade), placed in front of the proxy's
 *     own `request`/`upgrade` listeners so they skip the API-key check (the browser never holds the gateway key).
 */
import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { Duplex } from 'stream';
import { RealtimeService, type RealtimeServiceOptions } from './service';
import { createSignalingHandler, isSignalingPath } from './signaling';
import { createWsRelay, WS_PATH, type UpstreamFactory } from './ws-relay';
import { iceConfigFromEnv } from './ice';

export { RealtimeService } from './service';
export type { RealtimeServiceOptions, RealtimeController, ResolvedSession } from './service';
export { createSignalingHandler, isSignalingPath } from './signaling';
export { createWsRelay, WS_PATH } from './ws-relay';
export { iceConfigFromEnv, iceServersFor, turnCredentials } from './ice';
export type { IceConfig, IceServer } from './ice';
export { reportExternalLoad, externalLoadOf, externalInflightEquivalent, distinctSessions, refusedSessions } from './external-load';
export {
  deriveRealtimeKey, signSessionToken, verifySessionToken, peekClaims, encodeSessionConfig, decodeSessionConfig,
  RT_KEY_INFO, RT_MAX_CFG_CHARS, RT_MAX_TTL_SECONDS,
} from './token';
export type { RealtimeClaims } from './token';
export { TRACE_ID_HEADER, childTraceparent, newTrace, parseTraceparent, traceOf } from './trace';
export type { GatewayTelemetryEvent, RealtimeTelemetrySink, Trace } from './trace';
export { orderTransports, pickReplica, sessionCharge, TRANSPORT_LADDER, REALTIME_REQUESTS_PER_MINUTE } from './admission';
export type { RealtimeTransportType } from './admission';

export interface CreateRealtimeOptions extends Omit<RealtimeServiceOptions, 'ice'> {
  env?: Record<string, string | undefined>;
  upstream?: UpstreamFactory;
}

const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function createRealtime(opts: CreateRealtimeOptions) {
  const env = opts.env ?? process.env;
  const service = new RealtimeService({
    ...opts,
    ice: iceConfigFromEnv(env),
    publicUrl: opts.publicUrl ?? (env.REALTIME_PUBLIC_URL?.trim() || undefined),
    ttlSeconds: opts.ttlSeconds ?? num(env.REALTIME_SESSION_TTL_SECONDS),
    requestsPerMinute: opts.requestsPerMinute ?? num(env.REALTIME_REQUESTS_PER_MINUTE),
  });
  const signaling = createSignalingHandler(service, { fetchImpl: opts.fetchImpl, log: opts.log });
  const relay = createWsRelay(service, { upstream: opts.upstream, log: opts.log });

  /** Puts the browser routes in front of the proxy's listeners (the proxy itself is not changed). */
  function mount(server: Server): void {
    const requestListeners = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
    server.removeAllListeners('request');
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (isSignalingPath(req.url)) {
        void signaling(req, res).catch((err) => {
          opts.log?.('realtime: signaling failed', { error: (err as Error).message });
          if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"internal error"}}'); }
        });
        return;
      }
      for (const l of requestListeners) l.call(server, req, res);
    });
    const upgradeListeners = server.listeners('upgrade') as Array<(req: IncomingMessage, socket: Duplex, head: Buffer) => void>;
    server.removeAllListeners('upgrade');
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if ((req.url ?? '').split('?')[0] === WS_PATH && relay.handleUpgrade(req, socket, head)) return;
      for (const l of upgradeListeners) l.call(server, req, socket, head);
    });
  }

  return {
    service,
    route: { method: 'POST', path: '/v1/realtime/sessions', handler: service.createSession },
    mount,
    relay,
    stop: () => service.stop(),
  };
}
