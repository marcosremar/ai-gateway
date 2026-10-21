import { AccessToken, EgressClient, RoomServiceClient } from 'livekit-server-sdk';
import type { CallsBackend, LivekitServer, RoomLoad, TokenGrant } from './service';

export const httpUrlOf = (url: string) => url.replace(/^ws(s?):\/\//, 'http$1://');

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export const livekitBackend: CallsBackend = {
  async probe(server: LivekitServer, timeoutMs: number): Promise<RoomLoad> {
    const host = httpUrlOf(server.url);
    const rooms = await within(new RoomServiceClient(host, server.apiKey, server.apiSecret).listRooms(), timeoutMs, 'listRooms');
    const egress = await within(new EgressClient(host, server.apiKey, server.apiSecret).listEgress({ active: true }), timeoutMs, 'listEgress')
      .then(list => list.length, () => 0);
    return { rooms: rooms.length, participants: rooms.reduce((n, r) => n + r.numParticipants, 0), egress };
  },

  async sign(server: LivekitServer, grant: TokenGrant): Promise<string> {
    const token = new AccessToken(server.apiKey, server.apiSecret, {
      identity: grant.identity, ttl: grant.ttlSeconds,
      ...(grant.name ? { name: grant.name } : {}), ...(grant.metadata ? { metadata: grant.metadata } : {}),
    });
    token.addGrant({ roomJoin: true, room: grant.room, canPublish: grant.canPublish, canSubscribe: grant.canSubscribe });
    return token.toJwt();
  },
};
