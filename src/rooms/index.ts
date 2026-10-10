// ── AI Gateway — Live subtitle rooms ─────────────────────────────────────────
// A presenter's app publishes each subtitle line (original + translations) and optional dubbed clips to a room;
// viewers follow on their phone at `<ROOMS_PUBLIC_BASE_URL>/<CODE>`. Contract: docs/rooms.md.
//
// `createRooms(opts)` gives what serve.ts mounts, the same way as src/realtime:
//   - `route`        → customRoutes `POST /v1/rooms` (behind the proxy's API-key auth);
//   - `mount(server)` → the public / token-authenticated routes and the viewer WebSocket, placed in front of the
//                       proxy's own `request`/`upgrade` listeners (the proxy itself is not changed).

import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { Duplex } from 'stream';
import { roomsConfigFromEnv, type RoomsConfig } from './config';
import { createRoomsHttp, type KeyUser } from './http';
import { RoomService } from './service';
import { FileRoomStore, MemoryRoomStore, type RoomStore } from './store';
import { createRoomWs } from './ws';

export { roomsConfigFromEnv, ROOMS_DEFAULTS } from './config';
export type { RoomsConfig } from './config';
export { RoomService, hashToken } from './service';
export { FileRoomStore, MemoryRoomStore, linesFromJsonl } from './store';
export type { RoomStore } from './store';
export type { PublicRoom, RoomLine, RoomMeta, RoomServerMessage } from './types';
export { CODE_ALPHABET, CODE_RE, normalizeCode } from './validate';

export interface CreateRoomsOptions {
  env?: Record<string, string | undefined>;
  /** Overrides on top of the env config (tests). */
  config?: Partial<RoomsConfig>;
  /** Default: files under the config dir; memory when the config dir is null. */
  store?: RoomStore;
  /** Resolves a bearer as a gateway key: its user and whether it is an admin (null = not a key). */
  keyUser: KeyUser;
  /** User of a request that passed the proxy's key auth. */
  userOf: (req: IncomingMessage) => string;
  now?: () => number;
  sweepIntervalMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export function createRooms(opts: CreateRoomsOptions) {
  const config: RoomsConfig = { ...roomsConfigFromEnv(opts.env ?? process.env), ...opts.config };
  const store = opts.store ?? (config.dir ? new FileRoomStore(config.dir, opts.log) : new MemoryRoomStore());
  const service = new RoomService({ config, store, now: opts.now, log: opts.log, sweepIntervalMs: opts.sweepIntervalMs });
  const http = createRoomsHttp({ service, keyUser: opts.keyUser, userOf: opts.userOf, log: opts.log });
  const ws = createRoomWs(service, opts.log);

  /** Puts the rooms routes in front of the proxy's listeners. */
  function mount(server: Server): void {
    const requestListeners = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
    server.removeAllListeners('request');
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      let handled = false;
      try { handled = http.handle(req, res); } catch (err) {
        opts.log?.('rooms: routing failed', { error: err instanceof Error ? err.message : String(err) });
      }
      if (handled) return;
      for (const l of requestListeners) l.call(server, req, res);
    });
    const upgradeListeners = server.listeners('upgrade') as Array<(req: IncomingMessage, socket: Duplex, head: Buffer) => void>;
    server.removeAllListeners('upgrade');
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (ws.handleUpgrade(req, socket, head)) return;
      for (const l of upgradeListeners) l.call(server, req, socket, head);
    });
  }

  return {
    config,
    service,
    route: { method: 'POST', path: '/v1/rooms', handler: http.create },
    mount,
    stop: () => service.stop(),
  };
}
