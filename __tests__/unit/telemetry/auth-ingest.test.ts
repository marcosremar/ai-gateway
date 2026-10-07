import { describe, expect, it } from 'vitest';
import { authenticateTelemetry, edgeTelemetrySignature, isAuthFailure, type TelemetryPrincipal } from '../../../src/telemetry/auth';
import { TelemetryIngest, traceSampled } from '../../../src/telemetry/ingest';
import { TelemetryStore } from '../../../src/telemetry/store';
import { authDeps, DEP_TOKEN, ev, OTHER_TOKEN, sessionToken, TRACE } from './_helpers';

const bearer = (t: string) => `Bearer ${t}`;

describe('telemetry auth', () => {
  it('accepts an app key from a server and resolves the app', () => {
    expect(authenticateTelemetry({ authorization: bearer('app-key') }, authDeps())).toEqual({ kind: 'app', app: 'parle' });
  });

  it('refuses an app key sent by a browser (Origin / Sec-Fetch-Site)', () => {
    const viaOrigin = authenticateTelemetry({ authorization: bearer('app-key'), origin: 'https://parle.app' }, authDeps());
    const viaFetchMeta = authenticateTelemetry({ authorization: bearer('app-key'), secFetchSite: 'cross-site' }, authDeps());
    expect(viaOrigin).toMatchObject({ status: 403, code: 'browser_app_key' });
    expect(viaFetchMeta).toMatchObject({ status: 403, code: 'browser_app_key' });
  });

  it('never accepts the master (SANDBOX_TOKEN-style) key, even when it is also a client key', () => {
    expect(authenticateTelemetry({ authorization: bearer('sandbox-master') }, authDeps())).toMatchObject({ status: 403, code: 'master_key' });
  });

  it('refuses unknown keys and missing credentials', () => {
    expect(authenticateTelemetry({ authorization: bearer('nope') }, authDeps())).toMatchObject({ status: 401, code: 'invalid_key' });
    expect(authenticateTelemetry({}, authDeps())).toMatchObject({ status: 401, code: 'missing_credentials' });
  });

  it('accepts a valid realtime session token and takes sid/app/dep/rep from it', () => {
    const p = authenticateTelemetry({ authorization: bearer(sessionToken({ sid: 's-42', rep: 'r-1' })), origin: 'https://parle.app' }, authDeps());
    expect(p).toEqual({ kind: 'session', app: 'parle', sessionId: 's-42', deployment: 'speech', replicaId: 'r-1' });
  });

  it('accepts the session token in the body (sendBeacon cannot set headers)', () => {
    const p = authenticateTelemetry({ bodyToken: sessionToken({}) }, authDeps());
    expect(p).toMatchObject({ kind: 'session', sessionId: 'sess-1' });
  });

  it('refuses a session token signed with another deployment key, a tampered one and an unknown deployment', () => {
    expect(authenticateTelemetry({ authorization: bearer(sessionToken({}, OTHER_TOKEN)) }, authDeps()))
      .toMatchObject({ status: 401, code: 'bad_session_token' });
    const [h, , s] = sessionToken({}).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sid: 'x', app: 'evil', dep: 'speech', rep: 'r', iat: 1, exp: 9e9 })).toString('base64url')}.${s}`;
    expect(authenticateTelemetry({ authorization: bearer(forged) }, authDeps())).toMatchObject({ code: 'bad_session_token' });
    expect(authenticateTelemetry({ authorization: bearer(sessionToken({ dep: 'ghost' })) }, authDeps())).toMatchObject({ code: 'unknown_deployment' });
  });

  it('refuses an expired session token past the grace, accepts one within it', () => {
    const now = Math.floor(Date.now() / 1000);
    const late = sessionToken({ iat: now - 1000, exp: now - 300 });
    const justExpired = sessionToken({ iat: now - 700, exp: now - 30 });
    expect(authenticateTelemetry({ authorization: bearer(late) }, authDeps())).toMatchObject({ status: 401, code: 'session_expired' });
    expect(authenticateTelemetry({ authorization: bearer(justExpired) }, authDeps())).toMatchObject({ kind: 'session' });
    expect(authenticateTelemetry({ authorization: bearer(justExpired) }, authDeps({ sessionGraceSeconds: 0 }))).toMatchObject({ code: 'session_expired' });
  });

  it('edge signature test vector (shared with docker/aigw-edge/telemetry.py and docs/api/telemetry.md)', () => {
    expect(edgeTelemetrySignature('replica-secret')).toBe('523cc3e7d85def44143d386ac5a1c35acceb7ba3c83e09680cb6f1ada19967ad');
  });

  it('accepts the edge HMAC for its own replica and stamps deployment/replica', () => {
    const p = authenticateTelemetry({ authorization: bearer(edgeTelemetrySignature(DEP_TOKEN)), replica: 'r-1' }, authDeps());
    expect(p).toEqual({ kind: 'edge', deployment: 'speech', replicaId: 'r-1', app: 'parle' });
  });

  it('refuses a wrong HMAC, an unknown replica and a signature made for another deployment', () => {
    expect(authenticateTelemetry({ authorization: bearer('ab'.repeat(32)), replica: 'r-1' }, authDeps()))
      .toMatchObject({ status: 401, code: 'bad_edge_signature' });
    expect(authenticateTelemetry({ authorization: bearer(edgeTelemetrySignature(DEP_TOKEN)), replica: 'r-404' }, authDeps()))
      .toMatchObject({ status: 401, code: 'unknown_replica' });
    // r-9 belongs to `other`: the speech token's signature must not pass for it.
    expect(authenticateTelemetry({ authorization: bearer(edgeTelemetrySignature(DEP_TOKEN)), replica: 'r-9' }, authDeps()))
      .toMatchObject({ code: 'bad_edge_signature' });
    // The raw replica token itself is not the credential.
    expect(authenticateTelemetry({ authorization: bearer(DEP_TOKEN), replica: 'r-1' }, authDeps()))
      .toMatchObject({ code: 'bad_edge_signature' });
  });
});

function setup(opts: { ratePerMinute?: number; debugSample?: number; now?: () => number } = {}) {
  const store = new TelemetryStore({ now: opts.now });
  return { store, ingest: new TelemetryIngest(store, opts) };
}

const app: TelemetryPrincipal = { kind: 'app', app: 'parle' };
const session: TelemetryPrincipal = { kind: 'session', app: 'parle', sessionId: 's-1', deployment: 'speech', replicaId: 'r-1' };
const edge: TelemetryPrincipal = { kind: 'edge', deployment: 'speech', replicaId: 'r-1', app: 'parle' };
const bytes = (b: unknown) => Buffer.byteLength(JSON.stringify(b));

describe('telemetry ingest', () => {
  it('stores valid events and counts invalid ones without failing the batch', () => {
    const { store, ingest } = setup();
    const body = { events: [ev(), ev({ event: 'Not A Name' }), ev({ traceId: 'xyz' }), ev({ level: 'fatal' }), 42, ev({ attrs: { nested: { a: 1 } } })] };
    const r = ingest.ingest(app, body, bytes(body));
    expect(r).toMatchObject({ status: 200, accepted: 1, dropped: { invalid: 5, sampled: 0 } });
    expect(r.status === 200 && r.errors.map(e => e.index)).toEqual([1, 2, 3, 4, 5]);
    expect(store.size).toBe(1);
    expect(ingest.counters.invalid).toBe(5);
  });

  it('refuses batches over 100 events or 64 KB with 413, and a body without events with 400', () => {
    const { ingest } = setup();
    const many = { events: Array.from({ length: 101 }, () => ev()) };
    expect(ingest.ingest(app, many, bytes(many))).toMatchObject({ status: 413 });
    expect(ingest.ingest(app, { events: [] }, 64 * 1024 + 1)).toMatchObject({ status: 413 });
    expect(ingest.ingest(app, { nope: 1 }, 10)).toMatchObject({ status: 400 });
  });

  it('rate-limits per credential with Retry-After, independently per session', () => {
    let now = 1_000_000;
    const { ingest } = setup({ ratePerMinute: 10, now: () => now });
    const batch = { events: Array.from({ length: 8 }, () => ev()) };
    expect(ingest.ingest(session, batch, 100)).toMatchObject({ status: 200 });
    const limited = ingest.ingest(session, batch, 100);
    expect(limited).toMatchObject({ status: 429 });
    expect(limited.status === 429 && limited.retryAfterSec).toBeGreaterThan(0);
    expect(ingest.ingest({ ...session, sessionId: 's-2' } as TelemetryPrincipal, batch, 100)).toMatchObject({ status: 200 });
    now += 60_000; // bucket refilled
    expect(ingest.ingest(session, batch, 100)).toMatchObject({ status: 200 });
    expect(ingest.counters.rateLimited).toBe(1);
  });

  it('stamps identity from the credential, never from the body', () => {
    const { store, ingest } = setup();
    const lie = { sessionId: 'someone-else', deployment: 'evil', replicaId: 'r-x', source: 'gateway' };
    ingest.ingest(session, { events: [ev(lie)] }, 100);
    ingest.ingest(edge, { events: [ev({ ...lie, source: 'model' }), ev({ ...lie, source: 'browser', sessionId: 's-1' })] }, 100);
    const [fromBrowser, fromModel, fromEdge] = store.rows();
    expect(fromBrowser).toMatchObject({ source: 'browser', sessionId: 's-1', deployment: 'speech', replicaId: 'r-1', app: 'parle' });
    expect(fromModel).toMatchObject({ source: 'model', deployment: 'speech', replicaId: 'r-1', app: 'parle' });
    expect(fromEdge).toMatchObject({ source: 'edge', sessionId: 's-1' });
  });

  it('accepts source "app" from an app key (forced to browser for sessions) and single-segment names like "error"', () => {
    const { store, ingest } = setup();
    ingest.ingest(app, { events: [ev({ source: 'app', event: 'lesson.started' }), ev({ event: 'error', level: 'error' })] }, 100);
    ingest.ingest(session, { events: [ev({ source: 'app' })] }, 100);
    expect(store.rows().map(r => [r.source, r.event])).toEqual([['app', 'lesson.started'], ['browser', 'error'], ['browser', 'rt.ice.connected']]);
  });

  it('reserves source "gateway" to the gateway itself', () => {
    const { store, ingest } = setup();
    const r = ingest.ingest(app, { events: [ev({ source: 'gateway' })] }, 100);
    expect(r).toMatchObject({ accepted: 0, dropped: { invalid: 1 } });
    expect(store.size).toBe(0);
  });

  it('scrubs attrs on ingest and reports how many were removed', () => {
    const { store, ingest } = setup();
    const r = ingest.ingest(app, { events: [ev({ attrs: { transcript: 'bonjour', textLen: 7, code: 'ok' } })] }, 100);
    expect(r).toMatchObject({ redactedAttrs: 1 });
    expect(store.rows()[0]!.attrs).toEqual({ textLen: 7, code: 'ok' });
  });

  it('drops debug events by default and samples them per trace when TELEMETRY_DEBUG_SAMPLE > 0', () => {
    const { store, ingest } = setup();
    ingest.ingest(app, { events: [ev({ level: 'debug' })] }, 100);
    expect(store.size).toBe(0);
    expect(ingest.counters.sampledOut).toBe(1);
    const all = setup({ debugSample: 1 });
    all.ingest.ingest(app, { events: [ev({ level: 'debug' })] }, 100);
    expect(all.store.size).toBe(1);
    expect(traceSampled('00000000aaaaaaaaaaaaaaaaaaaaaaaa', 0.5)).toBe(true);
    expect(traceSampled('ffffffffaaaaaaaaaaaaaaaaaaaaaaaa', 0.5)).toBe(false);
  });

  it('keeps the source ts and the receive time, replacing an absurd clock', () => {
    const now = Date.now();
    const { store, ingest } = setup({ now: () => now });
    ingest.ingest(app, { events: [ev({ ts: now - 1500 }), ev({ ts: now + 3 * 86_400_000 })] }, 100);
    const [ok, absurd] = store.rows();
    expect(ok).toMatchObject({ ts: now - 1500, rxTs: now });
    expect(absurd).toMatchObject({ ts: now, rxTs: now, attrs: { clockReplaced: true } });
  });

  it('ingestOwn stores gateway events through the same schema and scrubber', () => {
    const { store, ingest } = setup();
    ingest.ingestOwn({ ts: Date.now(), source: 'gateway', level: 'info', event: 'route.served', traceId: TRACE, attrs: { prompt: 'hi', attempt: 0 } });
    ingest.ingestOwn({ ts: Date.now(), source: 'gateway', level: 'info', event: 'BAD', traceId: TRACE });
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]).toMatchObject({ source: 'gateway', attrs: { attempt: 0 } });
    expect(isAuthFailure({ status: 401, code: 'invalid_key', error: '' })).toBe(true);
  });
});
