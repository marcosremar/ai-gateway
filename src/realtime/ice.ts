/**
 * ICE servers handed to a realtime session (docs/realtime.md § TURN).
 *
 *   REALTIME_STUN_URLS   comma list; unset = stun:stun.l.google.com:19302; empty = no STUN
 *   REALTIME_TURN_URLS   comma list, e.g. turn:203.0.113.7:3478?transport=udp,turns:turn.example.com:443?transport=tcp
 *   REALTIME_TURN_SECRET coturn `static-auth-secret` (`use-auth-secret`, the TURN REST API)
 *
 * Credentials are minted per session with the TURN REST scheme coturn implements
 * (draft-uberti-behave-turn-rest-00): username = `<expiry unix seconds>:<session id>`,
 * credential = base64(HMAC-SHA1(secret, username)). Without both URLs and secret no TURN server is offered.
 */
import { createHmac } from 'crypto';

export const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302'];

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  stun: string[];
  turn: string[];
  turnSecret: string | null;
}

const ICE_URL = /^(stun|stuns|turn|turns):[^\s,]+$/;

function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(u => u.trim()).filter(u => ICE_URL.test(u));
}

export function iceConfigFromEnv(env: Record<string, string | undefined>): IceConfig {
  const stun = env.REALTIME_STUN_URLS === undefined ? [...DEFAULT_STUN_URLS] : list(env.REALTIME_STUN_URLS);
  const turn = list(env.REALTIME_TURN_URLS).filter(u => u.startsWith('turn'));
  const secret = env.REALTIME_TURN_SECRET?.trim() || null;
  return { stun, turn, turnSecret: secret };
}

export function turnCredentials(secret: string, sessionId: string, expiresAtSeconds: number): { username: string; credential: string } {
  const username = `${expiresAtSeconds}:${sessionId}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64') };
}

export function iceServersFor(config: IceConfig, sessionId: string, expiresAtSeconds: number): IceServer[] {
  const out: IceServer[] = [];
  if (config.stun.length) out.push({ urls: [...config.stun] });
  if (config.turn.length && config.turnSecret) {
    out.push({ urls: [...config.turn], ...turnCredentials(config.turnSecret, sessionId, expiresAtSeconds) });
  }
  return out;
}
