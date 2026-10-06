import { describe, expect, it } from 'vitest';
import { isInternalSubrequest, SUBREQUEST_HEADER, SUBREQUEST_TOKEN } from '../../../src/gateway/proxy/internal-subrequest';
import { loopbackStages } from '../../../src/s2s/loopback-stages';

// Regression (06/10/2026): 16 simultaneous composite turns answered 429 — each stage of a turn took another of the
// caller's 20 concurrency slots. The loopback stages are marked and the marker only counts from loopback.
describe('internal sub-requests', () => {
  it('the composite stages carry the per-process marker', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ text: 'oi' }), { status: 200 });
    }) as typeof fetch;
    const stages = loopbackStages({ baseUrl: 'http://127.0.0.1:1', authorization: 'Bearer k', fetchImpl, models: { stt: 'app-stt' } });
    await stages.transcribe(new Uint8Array([1]), 'audio/wav', { language: 'pt' } as never, new AbortController().signal);
    expect(headers[SUBREQUEST_HEADER]).toBe(SUBREQUEST_TOKEN);
    expect(headers.Authorization).toBe('Bearer k');
  });

  it('honoured only with the right token and from loopback', () => {
    expect(isInternalSubrequest(SUBREQUEST_TOKEN, '127.0.0.1')).toBe(true);
    expect(isInternalSubrequest(SUBREQUEST_TOKEN, '::ffff:127.0.0.1')).toBe(true);
    expect(isInternalSubrequest(SUBREQUEST_TOKEN, '10.0.0.5')).toBe(false);
    expect(isInternalSubrequest('guess', '127.0.0.1')).toBe(false);
    expect(isInternalSubrequest(undefined, '127.0.0.1')).toBe(false);
  });
});
