import { createHmac } from 'crypto';
import type { TelemetryAuthDeps } from '../../../src/telemetry/auth';

export const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
export const DEP_TOKEN = 'replica-token-of-speech';
export const OTHER_TOKEN = 'replica-token-of-other';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** A realtime session token as src/realtime/token.ts signs it (HS256, key = HMAC(replicaToken, "aigw-rt-v1")). */
export function sessionToken(claims: { sid?: string; app?: string; dep?: string; rep?: string; iat?: number; exp?: number }, replicaToken = DEP_TOKEN): string {
  const now = Math.floor(Date.now() / 1000);
  const full = { sid: 'sess-1', app: 'parle', dep: 'speech', rep: 'r-1', cfg: '', iat: now, exp: now + 600, ...claims };
  const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(full)}`;
  const key = createHmac('sha256', replicaToken).update('aigw-rt-v1').digest();
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
}

export function authDeps(overrides: Partial<TelemetryAuthDeps> = {}): TelemetryAuthDeps {
  return {
    resolveAppKey: (t) => (t === 'app-key' ? 'parle' : t === 'admin-key' ? 'ops' : t === 'sandbox-master' ? 'sandbox' : null),
    isMasterKey: (t) => t === 'sandbox-master',
    replica: (id) => (id === 'r-1' ? { deployment: 'speech', replicaToken: DEP_TOKEN, app: 'parle' }
      : id === 'r-9' ? { deployment: 'other', replicaToken: OTHER_TOKEN } : null),
    ...overrides,
  };
}

export function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: Date.now(), source: 'browser', level: 'info', event: 'rt.ice.connected', traceId: TRACE, ...over };
}
