/**
 * Fake fetch for GatewayClient tests: routes by "METHOD url-prefix", records every call (url, method, headers, body).
 */

interface RecordedCall { url: string; method: string; headers: Record<string, string>; body: BodyInit | null | undefined; signal?: AbortSignal | null }

export type FakeHandler = (call: RecordedCall, n: number) => Response | Promise<Response>;

export function fakeFetch(routes: Record<string, FakeHandler>) {
  const calls: RecordedCall[] = [];
  const counts = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const call: RecordedCall = { url, method, headers, body: init.body, signal: init.signal };
    calls.push(call);
    const key = Object.keys(routes).filter(k => `${method} ${url}`.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) throw new TypeError(`fetch failed (no fake route for ${method} ${url})`);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return routes[key](call, n);
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A fetch that never answers until its signal aborts (then rejects like fetch does: with the signal's reason). */
export function hang(call: RecordedCall): Promise<Response> {
  return new Promise((_, reject) => {
    const s = call.signal;
    if (!s) return;
    if (s.aborted) reject(s.reason);
    s.addEventListener('abort', () => reject(s.reason), { once: true });
  });
}

export function connectionRefused(): never {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}

/** A body that delivers `chunks` one by one and then stays open (or closes when `close`). */
export function streamOf(chunks: Uint8Array[], close = true): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else if (close) controller.close();
      else return new Promise(() => {}); // stays open
      return undefined;
    },
  });
}

export function sse(events: unknown[]): string {
  return events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
}
