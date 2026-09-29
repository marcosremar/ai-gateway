/**
 * A request-body failure must never crash the gateway.
 *
 * invokeNodeStyleHandler pumps the Bun Request body into a PassThrough and
 * destroys it with the error when the pump fails (client disconnect, 413).
 * With no 'error' listener on the PassThrough — handlers that answer without
 * reading the body, e.g. /v1/gpu/terminate's 409 — the emit became an
 * unhandled 'error' event and took the whole process down (observed live:
 * "Unhandled error. AbortError: The connection was closed.").
 */
import { describe, it, expect, afterEach } from 'vitest';
import { invokeNodeStyleHandler } from '../../server/ws/http-api-server';

const unhandled: unknown[] = [];
const onUncaught = (err: unknown) => { unhandled.push(err); };

function brokenBodyRequest(): Request {
  const body = new ReadableStream({
    pull(controller) { controller.error(new DOMException('The connection was closed.', 'AbortError')); },
  });
  return new Request('http://localhost/v1/gpu/terminate', { method: 'POST', body, duplex: 'half' } as RequestInit);
}

describe('invokeNodeStyleHandler — body errors', () => {
  afterEach(() => { process.off('uncaughtException', onUncaught); unhandled.length = 0; });

  it('survives a client disconnect when the handler answered without reading the body', async () => {
    process.on('uncaughtException', onUncaught);
    const res = await invokeNodeStyleHandler(brokenBodyRequest(), (_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Deploy lock held' }));
    }, null, 1024);
    await new Promise(r => setTimeout(r, 50));
    expect(res.status).toBe(409);
    expect(unhandled).toEqual([]);
  });

  it('answers 413 for an oversized Content-Length without crashing', async () => {
    process.on('uncaughtException', onUncaught);
    const req = new Request('http://localhost/v1/x', {
      method: 'POST', body: 'x'.repeat(10), headers: { 'content-length': '999999' },
    });
    const res = await invokeNodeStyleHandler(req, () => { /* never answers */ }, null, 1024);
    await new Promise(r => setTimeout(r, 50));
    expect(res.status).toBe(413);
    expect(unhandled).toEqual([]);
  });
});
