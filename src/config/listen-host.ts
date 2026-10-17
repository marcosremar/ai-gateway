import { onRailway } from '../deployments/real-machines';

/** Every interface: what a container needs, so its platform's proxy (Railway, a Docker port) reaches the gateway. */
export const ALL_INTERFACES = '0.0.0.0';
/** This machine only: the default of a gateway that runs on a dev's computer. */
export const LOOPBACK = '127.0.0.1';

/**
 * Where `serve.ts` listens.
 *
 * - **On Railway** (the published gateway): every interface, as always — `GATEWAY_HOST` is not read there, so no
 *   service variable can change what production listens on.
 * - **Elsewhere:** `GATEWAY_HOST` when set (a host setting: the dev API never changes it), else this machine only. A
 *   gateway on a dev's Mac used to listen on `0.0.0.0` with no client key (QA parle 16/10/2026): open mode answers a
 *   remote caller 401 on the model routes, but any machine of the same network reached the port, `/health` and the
 *   self-authenticated routes, one slip away from the models and local links of the Mac. A container off Railway sets
 *   `GATEWAY_HOST=0.0.0.0` (both Dockerfiles do), and so does a dev who wants the LAN in.
 */
export function listenHost(env: Record<string, string | undefined>): string {
  if (onRailway(env)) return ALL_INTERFACES;
  return env.GATEWAY_HOST?.trim() || LOOPBACK;
}
