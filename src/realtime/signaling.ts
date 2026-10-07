/**
 * Browser-facing realtime routes, authenticated by the SESSION token (never the gateway key, which the browser does
 * not have):
 *
 *   POST   /v1/realtime/sessions/:id/offer   {sdp, type?:"offer"} → replica POST /__aigw/rt/offer → {sdp, type:"answer", sessionId}
 *   POST   /v1/realtime/sessions/:id/ice     {candidate}          → replica POST /__aigw/rt/ice (trickle; optional)
 *   DELETE /v1/realtime/sessions/:id                               → replica DELETE /__aigw/rt/session/:edgeId
 *
 * Token: `Authorization: Bearer <token>` (or `token` in the JSON body). Its `sid` must be the `:id` of the path. The
 * replica is called with the deployment's `X-Aigw-Token`, which never leaves the gateway. CORS is open (`*`, no
 * credentials): the bearer token is the only authority, cookies play no part.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { readJsonBody, sendJson, type RealtimeService, type ResolvedSession } from './service';
import { TRACE_ID_HEADER, childTraceparent, echoTrace, traceOf, type Trace } from './trace';

const PATH = /^\/v1\/realtime\/sessions\/(rt_[A-Za-z0-9]{8,64})(?:\/(offer|ice))?$/;
const MAX_SIGNAL_BODY = 64 * 1024;
const SIGNAL_TIMEOUT_MS = 8_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, traceparent',
  'Access-Control-Expose-Headers': TRACE_ID_HEADER,
  'Access-Control-Max-Age': '600',
};

const fail = (res: ServerResponse, status: number, code: string, message: string) =>
  sendJson(res, status, { error: { message, type: 'realtime_error', code } }, CORS);

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? m[1]! : null;
}

export interface SignalingOptions {
  fetchImpl?: typeof fetch;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/** Whether a request is one of the token-authenticated routes (the mount sends it here before the key auth). */
export function isSignalingPath(url: string | undefined): boolean {
  return PATH.test((url ?? '').split('?')[0]!);
}

export function createSignalingHandler(service: RealtimeService, opts: SignalingOptions = {}) {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});

  async function authorize(req: IncomingMessage, res: ServerResponse, id: string, body: Record<string, unknown>): Promise<ResolvedSession | null> {
    const token = bearer(req) ?? (typeof body.token === 'string' ? body.token : null);
    if (!token) { fail(res, 401, 'invalid_token', 'missing session token (Authorization: Bearer <token>)'); return null; }
    const resolved = service.resolveToken(token);
    if ('status' in resolved) { fail(res, resolved.status, resolved.code, resolved.message); return null; }
    if (resolved.claims.sid !== id) { fail(res, 403, 'forbidden', 'session token does not belong to this session'); return null; }
    return resolved;
  }

  async function forward(s: ResolvedSession, trace: Trace, method: string, path: string, payload?: unknown): Promise<Response> {
    return f(`${s.base}${path}`, {
      method,
      headers: { 'X-Aigw-Token': s.replicaToken, traceparent: childTraceparent(trace), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
    });
  }

  /** Answers the request and returns true when it is a signaling route; false = not ours. */
  return async function handleSignaling(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const m = PATH.exec((req.url ?? '').split('?')[0]!);
    if (!m) return false;
    const [, id, action] = m as unknown as [string, string, 'offer' | 'ice' | undefined];
    const method = (req.method ?? 'GET').toUpperCase();
    const trace = traceOf(req);
    echoTrace(res, trace);
    const started = Date.now();
    if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
    const allowed = action ? method === 'POST' : method === 'DELETE';
    if (!allowed) { fail(res, 405, 'method_not_allowed', 'method not allowed'); return true; }

    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      try { body = await readJsonBody(req, MAX_SIGNAL_BODY); } catch (err) {
        fail(res, (err as { status?: number }).status ?? 400, 'invalid_request', `bad request: ${(err as Error).message}`);
        return true;
      }
    }
    const session = await authorize(req, res, id, body);
    if (!session) {
      service.emit(trace, 'rt.signal.refused', { level: 'warn', sessionId: id, attrs: { action: action ?? 'delete', status: res.statusCode } });
      return true;
    }

    try {
      if (action === 'offer') {
        if (typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0')) { fail(res, 400, 'invalid_request', '"sdp" must be an SDP offer'); return true; }
        const token = bearer(req) ?? String(body.token);
        const upstream = await forward(session, trace, 'POST', '/__aigw/rt/offer', { sdp: body.sdp, type: 'offer', token });
        const answer = await upstream.json().catch(() => null) as { sdp?: unknown; type?: unknown; sessionId?: unknown } | null;
        if (!upstream.ok || !answer || typeof answer.sdp !== 'string') {
          const status = upstream.status === 409 || upstream.status === 429 || upstream.status === 503 ? 503 : 502;
          log('realtime: offer refused by the replica', { sid: id, replica: session.replicaId, status: upstream.status });
          service.emit(trace, 'rt.signal.offer', { level: 'warn', sessionId: id, durMs: Date.now() - started, attrs: { ok: false, edgeStatus: upstream.status, replica: session.replicaId } });
          fail(res, status, status === 503 ? 'saturated' : 'edge_error', `the replica refused the offer (HTTP ${upstream.status})`);
          return true;
        }
        const edgeId = typeof answer.sessionId === 'string' && answer.sessionId ? answer.sessionId : id;
        service.settle(id, edgeId);
        service.emit(trace, 'rt.signal.offer', { sessionId: id, durMs: Date.now() - started, attrs: { ok: true, replica: session.replicaId, sdpBytes: answer.sdp.length } });
        sendJson(res, 200, { sdp: answer.sdp, type: 'answer', sessionId: id }, CORS);
        return true;
      }
      if (action === 'ice') {
        if (body.candidate === undefined) { fail(res, 400, 'invalid_request', '"candidate" is required'); return true; }
        const upstream = await forward(session, trace, 'POST', '/__aigw/rt/ice', { sessionId: session.edgeSessionId, candidate: body.candidate });
        res.writeHead(upstream.ok ? 204 : 502, CORS);
        res.end();
        return true;
      }
      const upstream = await forward(session, trace, 'DELETE', `/__aigw/rt/session/${encodeURIComponent(session.edgeSessionId)}`);
      service.forget(id);
      service.emit(trace, 'rt.session.deleted', { sessionId: id, attrs: { edgeStatus: upstream.status } });
      res.writeHead(upstream.ok || upstream.status === 404 ? 204 : 502, CORS);
      res.end();
      return true;
    } catch (err) {
      log('realtime: replica unreachable', { sid: id, replica: session.replicaId, error: (err as Error).message });
      service.emit(trace, 'error', { level: 'error', sessionId: id, attrs: { code: 'edge_unreachable', action: action ?? 'delete' } });
      fail(res, 502, 'edge_unreachable', 'the replica of this session did not answer');
      return true;
    }
  };
}
