/**
 * The session descriptor: asking the app's backend for a session (it calls `POST /v1/realtime/sessions` with the app
 * key, server side) and reading what the browser may read of it (the config inside the token, the telemetry URL).
 */
import type { SessionDescriptor, SessionRefusal, SessionRequest } from './types';

export type SessionSource = string | ((req: SessionRequest & { traceparent: string }) => Promise<SessionDescriptor | SessionRefusal>);

export function isRefusal(v: SessionDescriptor | SessionRefusal): v is SessionRefusal {
  return (v as SessionRefusal).refused === true;
}

function validDescriptor(v: unknown): v is SessionDescriptor {
  const d = v as SessionDescriptor | null;
  return !!d && typeof d.sessionId === 'string' && typeof d.token === 'string' && Array.isArray(d.transports);
}

export async function requestSession(
  source: SessionSource, req: SessionRequest,
  opts: { traceparent: string; timeoutMs: number; fetchImpl: typeof fetch; init?: RequestInit },
): Promise<SessionDescriptor | SessionRefusal> {
  if (typeof source === 'function') {
    try { return await source({ ...req, traceparent: opts.traceparent }); } catch (err) {
      return { refused: true, status: 0, code: 'network', message: (err as Error).message };
    }
  }
  try {
    const headers = new Headers(opts.init?.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('traceparent', opts.traceparent);
    const res = await opts.fetchImpl(source, {
      ...opts.init, method: 'POST', headers, body: JSON.stringify(req), signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (res.ok && validDescriptor(body)) return body;
    const error = (body?.error ?? {}) as { code?: unknown; message?: unknown };
    const retry = Number(res.headers.get('retry-after'));
    return {
      refused: true, status: res.status, code: typeof error.code === 'string' ? error.code : `http_${res.status}`,
      message: typeof error.message === 'string' ? error.message : `session request answered HTTP ${res.status}`,
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
    };
  } catch (err) {
    return { refused: true, status: 0, code: 'network', message: (err as Error).message };
  }
}

function b64urlJson(text: string): unknown {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}

/** The session config carried by the token (`cfg` claim). Readable by design: the token is signed, not encrypted. */
export function configFromToken(token: string, byReference?: string): Record<string, unknown> | null {
  try {
    const claims = byReference ? { cfg: byReference } : b64urlJson(token.split('.')[1] ?? '') as { cfg?: unknown };
    if (typeof claims.cfg !== 'string') return null;
    const cfg = b64urlJson(claims.cfg);
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg as Record<string, unknown> : null;
  } catch { return null; }
}

/** Where telemetry goes: the descriptor's own URL, else the gateway origin of its offer/WS URLs. */
export function telemetryUrlOf(d: SessionDescriptor): string | null {
  if (d.telemetryUrl) return d.telemetryUrl;
  for (const t of d.transports) {
    const url = t.type === 'webrtc' ? t.offerUrl : t.type === 'ws' ? t.url : null;
    if (!url) continue;
    try {
      const u = new URL(url);
      return `${u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol}//${u.host}/v1/telemetry/events`;
    } catch { /* relative */ }
  }
  return null;
}
