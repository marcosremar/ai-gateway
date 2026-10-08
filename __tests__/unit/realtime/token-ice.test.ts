/**
 * Session token (src/realtime/token.ts) and TURN credentials (src/realtime/ice.ts), checked against the shared vectors
 * the replica-side implementation also uses (docs/realtime-token-vectors.json).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  decodeSessionConfig, deriveRealtimeKey, encodeSessionConfig, iceConfigFromEnv, iceServersFor, peekClaims,
  signSessionToken, turnCredentials, verifySessionToken,
} from '../../../src/realtime';

const vectors = JSON.parse(readFileSync(join(__dirname, '../../../docs/realtime-token-vectors.json'), 'utf8'));

describe('realtime session token', () => {
  it('derives the key and signs byte-exactly like the vectors', () => {
    const key = deriveRealtimeKey(vectors.replicaToken);
    expect(key.toString('hex')).toBe(vectors.derivedKeyHex);
    expect(encodeSessionConfig(vectors.config)).toBe(vectors.claims.cfg);
    expect(signSessionToken(vectors.claims, key)).toBe(vectors.token);
    expect(decodeSessionConfig(vectors.claims.cfg)).toEqual(vectors.config);
  });

  for (const c of vectors.cases as Array<{ name: string; token: string; nowSeconds: number; expect: string }>) {
    it(`vector "${c.name}" → ${c.expect}`, () => {
      const out = verifySessionToken(c.token, deriveRealtimeKey(vectors.replicaToken), c.nowSeconds);
      if (c.expect === 'valid') expect(out).toEqual({ claims: vectors.claims });
      else expect(out).toEqual({ error: c.expect });
    });
  }

  it('refuses a token whose header is not HS256 (alg confusion) and garbage', () => {
    const key = deriveRealtimeKey('k');
    const [, p, s] = signSessionToken({ ...vectors.claims }, key).split('.');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.${s}`;
    expect(verifySessionToken(none, key, vectors.claims.iat)).toEqual({ error: 'malformed' });
    expect(verifySessionToken('a.b', key, 0)).toEqual({ error: 'malformed' });
    expect(verifySessionToken('a.b.c!', key, 0)).toEqual({ error: 'malformed' });
    expect(peekClaims('x.y.z')).toBeNull();
  });
});

describe('TURN credentials and ICE servers', () => {
  it('matches the coturn REST scheme vector', () => {
    const t = vectors.turn;
    expect(turnCredentials(t.secret, t.sessionId, t.expiresAtSeconds)).toEqual({ username: t.username, credential: t.credential });
    expect(t.username).toBe(`${t.expiresAtSeconds}:${t.sessionId}`);
  });

  it('defaults to Google STUN, offers TURN only with URLs and a secret', () => {
    expect(iceServersFor(iceConfigFromEnv({}), 'rt_x', 100)).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
    expect(iceServersFor(iceConfigFromEnv({ REALTIME_TURN_URLS: 'turn:1.2.3.4:3478' }), 'rt_x', 100)).toHaveLength(1);
    const env = {
      REALTIME_STUN_URLS: '', REALTIME_TURN_SECRET: 's3cret',
      REALTIME_TURN_URLS: 'turn:1.2.3.4:3478?transport=udp, turns:turn.example.com:443?transport=tcp, http://bad',
    };
    const servers = iceServersFor(iceConfigFromEnv(env), 'rt_abc', 1700000000);
    expect(servers).toEqual([{
      urls: ['turn:1.2.3.4:3478?transport=udp', 'turns:turn.example.com:443?transport=tcp'],
      ...turnCredentials('s3cret', 'rt_abc', 1700000000),
    }]);
    expect(servers[0]!.username).toBe('1700000000:rt_abc');
  });
});
