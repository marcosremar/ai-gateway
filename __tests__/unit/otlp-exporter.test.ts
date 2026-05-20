/**
 * OtlpExporter — unit tests covering OTLP HTTP/JSON encoding,
 * batch flush behavior, env-driven init, and SSRF/network failure paths.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  OtlpExporter,
  parseOtlpHeaders,
  spanToOtlp,
  initOtlpFromEnv,
  attachExporterToTracer,
  _resetOtlpForTests,
} from '../../src/platform/observability/otlp-exporter';
import { globalTracer } from '../../src/platform/observability/distributed-tracer';

interface FakeFetchCall { url: string; body: unknown; headers: Record<string, string> }

function fakeFetch(opts: { status?: number; throwError?: string } = {}): {
  fn: typeof fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers: init.headers as Record<string, string>,
    });
    if (opts.throwError) throw new Error(opts.throwError);
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('parseOtlpHeaders', () => {
  it('parses comma-separated k=v pairs', () => {
    expect(parseOtlpHeaders('authorization=Bearer xxx,x-tenant=acme'))
      .toEqual({ authorization: 'Bearer xxx', 'x-tenant': 'acme' });
  });
  it('returns empty object for undefined/empty', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders('')).toEqual({});
  });
  it('skips entries without =', () => {
    expect(parseOtlpHeaders('badentry,key=val')).toEqual({ key: 'val' });
  });
});

describe('spanToOtlp encoding', () => {
  it('encodes string/int/double/bool tags as typed values', () => {
    const span = globalTracer.startSpan('test_op');
    globalTracer.addTag(span.spanId, 'str_tag', 'hello');
    globalTracer.addTag(span.spanId, 'int_tag', 42);
    globalTracer.addTag(span.spanId, 'double_tag', 3.14);
    globalTracer.addTag(span.spanId, 'bool_tag', true);
    globalTracer.endSpan(span.spanId);
    const encoded = spanToOtlp(span);
    expect(encoded.name).toBe('test_op');
    expect(encoded.traceId).toBe(span.traceId);
    expect(encoded.spanId).toBe(span.spanId);
    const attrs = Object.fromEntries(encoded.attributes.map((a) => [a.key, a.value]));
    expect(attrs.str_tag).toEqual({ stringValue: 'hello' });
    expect(attrs.int_tag).toEqual({ intValue: '42' });
    expect(attrs.double_tag).toEqual({ doubleValue: 3.14 });
    expect(attrs.bool_tag).toEqual({ boolValue: true });
  });

  it('emits status=error when stage_failure event present', () => {
    const span = globalTracer.startSpan('failing_op');
    globalTracer.addEvent(span.spanId, 'stage_failure', { reason: 'timeout' });
    globalTracer.endSpan(span.spanId);
    expect(spanToOtlp(span).status?.code).toBe(2);
  });

  it('uses millisecond → nanosecond conversion for timestamps', () => {
    const span = globalTracer.startSpan('ts_op');
    globalTracer.endSpan(span.spanId);
    const encoded = spanToOtlp(span);
    expect(encoded.startTimeUnixNano).toBe(String(BigInt(span.startTime) * BigInt(1_000_000)));
    expect(BigInt(encoded.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(encoded.startTimeUnixNano));
  });
});

describe('OtlpExporter batching', () => {
  let exporter: OtlpExporter;
  let calls: FakeFetchCall[];

  beforeEach(() => {
    const fake = fakeFetch();
    calls = fake.calls;
    exporter = new OtlpExporter({
      endpoint: 'http://collector:4318',
      serviceName: 'test-svc',
      maxBatchSize: 3,
      fetch: fake.fn,
    });
  });

  it('appends /v1/traces to endpoint', async () => {
    const span = globalTracer.startSpan('a');
    globalTracer.endSpan(span.spanId);
    exporter.enqueue(span);
    await exporter.flush();
    expect(calls[0].url).toBe('http://collector:4318/v1/traces');
  });

  it('flushes pending spans on demand', async () => {
    for (let i = 0; i < 2; i++) {
      const s = globalTracer.startSpan(`op_${i}`);
      globalTracer.endSpan(s.spanId);
      exporter.enqueue(s);
    }
    const result = await exporter.flush();
    expect(result.exported).toBe(2);
    expect(calls.length).toBe(1);
  });

  it('auto-flushes when batch threshold reached', async () => {
    for (let i = 0; i < 3; i++) {
      const s = globalTracer.startSpan(`op_${i}`);
      globalTracer.endSpan(s.spanId);
      exporter.enqueue(s);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(1);
    const payload = calls[0].body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> };
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(3);
  });

  it('counts failures when collector returns 5xx', async () => {
    const fake = fakeFetch({ status: 503 });
    const exp = new OtlpExporter({ endpoint: 'http://collector:4318', fetch: fake.fn });
    const s = globalTracer.startSpan('fail_op');
    globalTracer.endSpan(s.spanId);
    exp.enqueue(s);
    const result = await exp.flush();
    expect(result.failed).toBe(1);
    expect(exp.stats().failed).toBe(1);
    expect(exp.stats().lastFailure?.message).toContain('503');
  });

  it('counts failures when fetch throws', async () => {
    const fake = fakeFetch({ throwError: 'ECONNREFUSED' });
    const exp = new OtlpExporter({ endpoint: 'http://collector:4318', fetch: fake.fn });
    const s = globalTracer.startSpan('throw_op');
    globalTracer.endSpan(s.spanId);
    exp.enqueue(s);
    const result = await exp.flush();
    expect(result.failed).toBe(1);
    expect(exp.stats().lastFailure?.message).toContain('ECONNREFUSED');
  });

  it('flush is no-op when queue is empty', async () => {
    const result = await exporter.flush();
    expect(result.exported).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('payload includes resource service.name', async () => {
    const s = globalTracer.startSpan('resource_test');
    globalTracer.endSpan(s.spanId);
    exporter.enqueue(s);
    await exporter.flush();
    const payload = calls[0].body as {
      resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> } }>;
    };
    const svcAttr = payload.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name');
    expect(svcAttr?.value.stringValue).toBe('test-svc');
  });

  it('strips trailing slashes from endpoint', () => {
    const exp = new OtlpExporter({ endpoint: 'http://collector:4318////', fetch: fakeFetch().fn });
    expect(exp.stats().endpoint).toBe('http://collector:4318/v1/traces');
  });

  it('throws when endpoint missing', () => {
    expect(() => new OtlpExporter({ endpoint: '' })).toThrow(/endpoint required/);
  });
});

describe('initOtlpFromEnv', () => {
  beforeEach(() => _resetOtlpForTests());

  it('returns null when OTEL_EXPORTER_OTLP_ENDPOINT not set', () => {
    expect(initOtlpFromEnv({})).toBeNull();
  });

  it('builds exporter from env vars', () => {
    const exp = initOtlpFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer test',
      OTEL_SERVICE_NAME: 'env-svc',
    } as NodeJS.ProcessEnv);
    expect(exp).not.toBeNull();
    expect(exp?.stats().endpoint).toBe('http://tempo:4318/v1/traces');
    exp?.stop();
  });

  it('is idempotent — returns same instance on repeat call', () => {
    const a = initOtlpFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318',
    } as NodeJS.ProcessEnv);
    const b = initOtlpFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318',
    } as NodeJS.ProcessEnv);
    expect(a).toBe(b);
    a?.stop();
  });
});

describe('attachExporterToTracer', () => {
  it('auto-enqueues spans when endSpan is called', () => {
    const fake = fakeFetch();
    const exp = new OtlpExporter({ endpoint: 'http://x:4318', fetch: fake.fn });
    attachExporterToTracer(exp);
    const span = globalTracer.startSpan('auto_enqueued');
    globalTracer.endSpan(span.spanId);
    expect(exp.stats().pending).toBeGreaterThan(0);
  });
});
