/**
 * Fault bench: the real gateway (`serve.ts` under Bun) against a fake OpenRouter/Groq that fails on purpose.
 *
 *   bun scripts/fault-bench/run.ts            # every scenario
 *   bun scripts/fault-bench/run.ts 8 11 18    # only these items (research numbering)
 *
 * Nothing leaves the machine: fake keys, fake upstream on 127.0.0.1, proxy env pointing at a closed port.
 * Prints one line per check and, at the end, a JSON summary (item, verdict, evidence).
 */

import { startFakeUpstream, type FakeUpstream, type LoggedRequest } from './fake-upstream';
import { FAKE_KEYS, startGateway, type RunningGateway } from './gateway';

type Verdict = 'PASS' | 'FAIL' | 'N/A' | 'INFO';
interface Result { item: string; check: string; verdict: Verdict; evidence: string }
const results: Result[] = [];
const record = (item: string, check: string, verdict: Verdict, evidence: string) => {
  results.push({ item, check, verdict, evidence });
  console.log(`[${verdict}] ${item} ${check} — ${evidence}`);
};

const AUTH = { authorization: `Bearer ${FAKE_KEYS.GATEWAY_KEY}` };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.now();

interface SseResult {
  status: number;
  headers: Headers;
  text: string;
  content: string;
  done: boolean;
  errors: unknown[];
  finish: string[];
  firstByteMs: number | null;
  totalMs: number;
  cut: string | null;
}

async function chatSse(gw: RunningGateway, body: Record<string, unknown>, signal?: AbortSignal): Promise<SseResult> {
  const t0 = now();
  let firstByteMs: number | null = null;
  let text = '';
  let cut: string | null = null;
  const res = await fetch(`${gw.url}/v1/chat/completions`, {
    method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 't-llm', messages: prompt(), stream: true, ...body }), signal,
  });
  const dec = new TextDecoder();
  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstByteMs === null) firstByteMs = now() - t0;
        text += dec.decode(value, { stream: true });
      }
    } catch (err) { cut = (err as Error).message; }
  }
  const content: string[] = [];
  const errors: unknown[] = [];
  const finish: string[] = [];
  let done = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { done = true; continue; }
    try {
      const j = JSON.parse(data) as { error?: unknown; choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
      if (j.error) errors.push(j.error);
      for (const c of j.choices ?? []) {
        if (c.delta?.content) content.push(c.delta.content);
        if (c.finish_reason) finish.push(c.finish_reason);
      }
    } catch { errors.push(`unparseable: ${data.slice(0, 80)}`); }
  }
  return { status: res.status, headers: res.headers, text, content: content.join(''), done, errors, finish, firstByteMs, totalMs: now() - t0, cut };
}

let uniq = 0;
/** Every request gets its own prompt: identical in-flight requests are coalesced by the gateway (one upstream call). */
const prompt = () => [{ role: 'user', content: `oi ${++uniq}` }];

async function chatJson(gw: RunningGateway, body: Record<string, unknown> = {}, signal?: AbortSignal) {
  const t0 = now();
  const res = await fetch(`${gw.url}/v1/chat/completions`, {
    method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 't-llm', messages: prompt(), ...body }), signal,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, ms: now() - t0 };
}

function wav(seconds = 1, seed = 1): Uint8Array {
  const samples = 16000 * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((i * seed) / 10) * 8000), 44 + i * 2);
  return new Uint8Array(buf);
}

/** iPhone-style AAC in MP4 container: only the `ftyp` box matters for format sniffing. */
function mp4(bytes = 20_000): Uint8Array {
  const buf = Buffer.alloc(bytes, 3);
  buf.writeUInt32BE(24, 0); buf.write('ftypM4A ', 4); buf.write('isomiso2', 12);
  return new Uint8Array(buf);
}

async function stt(gw: RunningGateway, audio: Uint8Array, opts: { language?: string; filename?: string; type?: string; signal?: AbortSignal; model?: string } = {}) {
  const form = new FormData();
  form.set('file', new Blob([audio], { type: opts.type ?? 'audio/wav' }), opts.filename ?? 'turn.wav');
  form.set('model', opts.model ?? 't-stt');
  if (opts.language) form.set('language', opts.language);
  const t0 = now();
  const res = await fetch(`${gw.url}/v1/audio/transcriptions`, { method: 'POST', headers: AUTH, body: form, signal: opts.signal });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, ms: now() - t0 };
}

async function tts(gw: RunningGateway, signal?: AbortSignal) {
  const t0 = now();
  const res = await fetch(`${gw.url}/v1/audio/speech`, {
    method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 't-tts', input: 'Olá, tudo bem?', voice: 'alloy', response_format: 'mp3' }), signal,
  });
  const body = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes: body.length, ms: now() - t0, text: res.ok ? '' : new TextDecoder().decode(body) };
}

async function health(gw: RunningGateway): Promise<Record<string, { links: Array<{ target: string; state: string }> }>> {
  const res = await fetch(`${gw.url}/health`);
  const j = await res.json() as { stages?: { chat?: Record<string, { links: Array<{ target: string; state: string }> }> } };
  return j.stages?.chat ?? {};
}

const linkStates = async (gw: RunningGateway, model = 't-llm') =>
  ((await health(gw))[model]?.links ?? []).map(l => `${l.target}=${l.state}`).join(', ');

const calls = (fake: FakeUpstream, pred: (r: LoggedRequest) => boolean = () => true) => fake.log().filter(pred).length;
const byModel = (fake: FakeUpstream) => {
  const out: Record<string, number> = {};
  for (const r of fake.log()) out[r.model ?? `${r.tag}${r.path}`] = (out[r.model ?? `${r.tag}${r.path}`] ?? 0) + 1;
  return JSON.stringify(out);
};

async function withGateway(fake: FakeUpstream, env: Record<string, string>, fn: (gw: RunningGateway) => Promise<void>): Promise<RunningGateway> {
  fake.reset();
  const gw = await startGateway(fake.url, env);
  try { await fn(gw); } finally { await gw.stop(); }
  return gw;
}

// ─────────────────────────────────────────────────────────────────────────────

const scenarios: Record<string, (fake: FakeUpstream) => Promise<void>> = {
  async 1(fake) {
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults({ a: { kind: 'sse-error', deltas: 2, style: 'openrouter' } });
      const r = await chatSse(gw, {});
      const ok = r.errors.length > 0 && !r.done && !r.finish.includes('stop');
      record('1', 'OpenRouter in-band error after 2 deltas (HTTP 200)', ok ? 'PASS' : 'FAIL',
        `status=${r.status} content=${JSON.stringify(r.content)} errors=${JSON.stringify(r.errors)} finish=${JSON.stringify(r.finish)} [DONE]=${r.done}`);
      fake.reset();
      fake.setFaults({ a: { kind: 'sse-error', deltas: 2, style: 'anthropic' } });
      const r2 = await chatSse(gw, {});
      record('1', 'Anthropic-style `event: error` after 2 deltas', r2.errors.length > 0 && !r2.done ? 'PASS' : 'FAIL',
        `content=${JSON.stringify(r2.content)} errors=${JSON.stringify(r2.errors)} finish=${JSON.stringify(r2.finish)} [DONE]=${r2.done}`);
      fake.reset();
      fake.setFaults({ a: { kind: 'sse-error', deltas: 0, style: 'openrouter' } });
      const r3 = await chatSse(gw, {});
      record('1', 'in-band error before the first token → fallback', r3.content.length > 0 && r3.done && r3.headers.get('x-gateway-fallback-from') === 'openrouter:a' ? 'PASS' : 'FAIL',
        `served=${r3.headers.get('x-gateway-provider')} fallback=${r3.headers.get('x-gateway-fallback')} content=${JSON.stringify(r3.content)} upstream=${byModel(fake)}`);
      // Breaker: 6 mid-stream errors in a row, then is openrouter still "ready"?
      fake.reset();
      fake.setFaults({ a: { kind: 'sse-error', deltas: 2, style: 'openrouter' } });
      for (let i = 0; i < 6; i++) await chatSse(gw, {});
      const links = await linkStates(gw);
      record('1', 'breaker after 6 mid-stream errors (threshold 5)', /openrouter:a=circuit_open/.test(links) ? 'PASS' : 'FAIL', `links: ${links}`);
    });
  },

  async 2(fake) {
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults({ a: { kind: 'sse-keepalive', forMs: 3000, everyMs: 500 } });
      const r = await chatSse(gw, {});
      record('2', 'keep-alive comments 3 s then tokens', r.content === 'Olá depois da espera' && r.done && r.errors.length === 0 ? 'PASS' : 'FAIL',
        `content=${JSON.stringify(r.content)} errors=${r.errors.length} firstByte=${Math.round(r.firstByteMs ?? -1)}ms total=${Math.round(r.totalMs)}ms served=${r.headers.get('x-gateway-provider')}`);
      fake.reset();
      fake.setFaults({ a: { kind: 'sse-keepalive', forMs: 20_000, everyMs: 1000 } });
      const r2 = await chatSse(gw, {});
      record('2', 'keep-alive comments 20 s then tokens (stage budget 8 s)', r2.errors.length === 0 ? 'INFO' : 'FAIL',
        `status=${r2.status} served=${r2.headers.get('x-gateway-provider')} fallback=${r2.headers.get('x-gateway-fallback')} content=${JSON.stringify(r2.content)} total=${Math.round(r2.totalMs)}ms upstream=${byModel(fake)} — comments did not count as first byte`);
    });
  },

  async 3(fake) {
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults({ a: { kind: 'sse-split' } });
      const r = await chatSse(gw, {});
      const want = 'Não, não é assim — ção';
      record('3', 'UTF-8 split across chunks + data line split mid-JSON', r.content === want && r.errors.length === 0 ? 'PASS' : 'FAIL',
        `got=${JSON.stringify(r.content)} want=${JSON.stringify(want)} errors=${r.errors.length}`);
      fake.reset();
      fake.setFaults({ a: { kind: 'sse-split' } });
      const j = await chatJson(gw, {});
      // Non-streamed request against a streamed-split upstream is not a shape OpenRouter sends; covered by the stream case.
      void j;
    });
  },

  async 5(fake) {
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults({ a: { kind: 'stall-mid', deltas: 2, silentMs: 12_000 } });
      const r = await chatSse(gw, {});
      const complete = r.content.endsWith('fim.') && r.done;
      record('5', 'chat SSE: upstream silent 12 s mid-stream', complete ? 'PASS' : 'FAIL',
        `content=${JSON.stringify(r.content)} finish=${JSON.stringify(r.finish)} [DONE]=${r.done} errors=${JSON.stringify(r.errors)} total=${Math.round(r.totalMs)}ms cut=${r.cut}`);
      fake.reset();
      fake.setFaults({ a: { kind: 'stall-mid', deltas: 2, silentMs: 70_000 } });
      const r2 = await chatSse(gw, {});
      const aLog = fake.log().find(x => x.model === 'a');
      record('5', 'chat SSE: upstream silent 70 s mid-stream', !r2.done && r2.errors.length > 0 ? 'PASS' : 'FAIL',
        `content=${JSON.stringify(r2.content)} [DONE]=${r2.done} finish=${JSON.stringify(r2.finish)} errors=${JSON.stringify(r2.errors)} total=${Math.round(r2.totalMs)}ms upstreamAborted=${aLog?.aborted} after ${aLog?.abortedAt ? Math.round(aLog.abortedAt - aLog.startedAt) : '-'}ms`);
    });
    // Bun idleTimeout: a response that takes 12 s to start (stage budget raised to 20 s).
    await withGateway(fake, { GATEWAY_CHAT_BUDGET_MS: '20000', GATEWAY_TTS_BUDGET_MS: '20000' }, async (gw) => {
      fake.setFaults({ a: { kind: 'ok', delayMs: 12_000 } });
      let r: Awaited<ReturnType<typeof chatJson>> | { status: number; ms: number; text: string } ;
      try { r = await chatJson(gw, {}); } catch (err) { r = { status: 0, ms: 0, text: String(err) }; }
      record('5', 'non-streamed chat answered after 12 s of silence (Bun idleTimeout 10 s?)', r.status === 200 ? 'PASS' : 'FAIL',
        `status=${r.status} ms=${Math.round(r.ms)} body=${r.text.slice(0, 120)}`);
      fake.reset();
      fake.setFaults({ a: { kind: 'stall-mid', deltas: 2, silentMs: 12_000 } });
      const r2 = await chatSse(gw, {});
      record('5', 'chat SSE silent 12 s mid-stream with 20 s budget', r2.content.endsWith('fim.') && r2.done ? 'PASS' : 'FAIL',
        `content=${JSON.stringify(r2.content)} [DONE]=${r2.done} total=${Math.round(r2.totalMs)}ms cut=${r2.cut}`);
    });
  },

  async 6(fake) {
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults({ a: { kind: 'close-mid', deltas: 3 } });
      const r = await chatSse(gw, {});
      record('6', 'upstream destroys TCP after 3 deltas (no [DONE])', !r.done && r.errors.length > 0 ? 'PASS' : 'FAIL',
        `content=${JSON.stringify(r.content)} finish=${JSON.stringify(r.finish)} [DONE]=${r.done} errors=${JSON.stringify(r.errors)}`);
      fake.reset();
      fake.setFaults({ a: { kind: 'end-mid', deltas: 3 } });
      const r2 = await chatSse(gw, {});
      record('6', 'upstream ends cleanly after 3 deltas, no finish_reason, no [DONE]', !r2.done && r2.errors.length > 0 ? 'PASS' : 'FAIL',
        `content=${JSON.stringify(r2.content)} finish=${JSON.stringify(r2.finish)} [DONE]=${r2.done} errors=${JSON.stringify(r2.errors)}`);
      fake.reset();
      fake.setFaults({ a: { kind: 'close-mid', deltas: 0 } });
      const r3 = await chatJson(gw, {});
      record('6', 'non-streamed: TCP closed mid-body → next provider', r3.status === 200 && r3.headers.get('x-gateway-fallback-from') === 'openrouter:a' ? 'PASS' : 'FAIL',
        `status=${r3.status} served=${r3.headers.get('x-gateway-provider')} upstream=${byModel(fake)}`);
    });
  },

  async 7(fake) {
    await withGateway(fake, {}, async (gw) => {
      for (const kind of ['no-answer', 'headers-stall'] as const) {
        fake.reset();
        fake.setFaults({ a: { kind }, b: { kind }, c: { kind }, 'llama-3.3-70b-versatile': { kind }, 'meta-llama/llama-3.3-70b-instruct': { kind } });
        const r = await chatJson(gw, {});
        const within = r.ms <= 8_000 * 1.1 && r.ms >= 8_000 * 0.9;
        record('7', `non-streamed chat, all upstreams ${kind} (budget 8 s)`, within && r.status === 503 ? 'PASS' : 'FAIL',
          `status=${r.status} ms=${Math.round(r.ms)} upstream=${byModel(fake)} aborted=${fake.log().filter(x => x.aborted).length}/${fake.log().length}`);
        fake.reset();
        fake.setFaults({ a: { kind }, b: { kind }, c: { kind }, 'llama-3.3-70b-versatile': { kind }, 'meta-llama/llama-3.3-70b-instruct': { kind } });
        const s = await chatSse(gw, {});
        record('7', `streamed chat, all upstreams ${kind}`, s.totalMs <= 8_800 && s.status === 503 ? 'PASS' : 'FAIL',
          `status=${s.status} ms=${Math.round(s.totalMs)} upstream=${byModel(fake)}`);
      }
      fake.reset();
      fake.setFaults({ 'or:transcriptions': { kind: 'no-answer' }, 'groq:transcriptions': { kind: 'no-answer' } });
      const s = await stt(gw, wav());
      record('7', 'STT, all upstreams no-answer', s.ms <= 8_800 && s.status === 503 ? 'PASS' : 'FAIL', `status=${s.status} ms=${Math.round(s.ms)} upstream=${calls(fake)}`);
      fake.reset();
      fake.setFaults({ ta: { kind: 'headers-stall' }, tc: { kind: 'headers-stall' } });
      const t = await tts(gw);
      record('7', 'TTS, all upstreams headers-then-stall', t.ms <= 8_800 && t.status === 503 ? 'PASS' : 'FAIL', `status=${t.status} ms=${Math.round(t.ms)} upstream=${calls(fake)}`);
    });
  },

  async 8(fake) {
    const all503 = { kind: 'status' as const, status: 503 };
    const faults = { a: all503, b: all503, c: all503, 'llama-3.3-70b-versatile': all503, 'meta-llama/llama-3.3-70b-instruct': all503 };
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults(faults);
      const r = await chatJson(gw, {});
      const n = calls(fake);
      // Bound: 5 targets × (1 call + the route's one 5xx retry) = 10.
      record('8', 'non-streamed chat, every provider 503: upstream calls for ONE request', n <= 10 ? 'PASS' : 'FAIL',
        `status=${r.status} ms=${Math.round(r.ms)} calls=${n} per model=${byModel(fake)} (chain has 5 targets)`);
    });
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults(faults);
      const r = await chatSse(gw, {});
      const n = calls(fake);
      record('8', 'streamed chat, every provider 503: upstream calls for ONE request', n <= 5 ? 'PASS' : 'FAIL',
        `status=${r.status} ms=${Math.round(r.totalMs)} calls=${n} per model=${byModel(fake)}`);
    });
    await withGateway(fake, { MAX_CONCURRENT_PER_USER: '100' }, async (gw) => {
      fake.setFaults(faults);
      const t0 = now();
      const rs = await Promise.all(Array.from({ length: 50 }, () => chatJson(gw, {})));
      const n = calls(fake);
      record('8', '50 concurrent non-streamed, every provider 503', n <= 50 * 10 ? 'PASS' : 'FAIL',
        `calls=${n} (${(n / 50).toFixed(1)}/request) statuses=${[...new Set(rs.map(x => x.status))]} wall=${Math.round(now() - t0)}ms links: ${await linkStates(gw)}`);
    });
    // Through the SDK: GatewayClient with directFallback, fake plan → the fake upstream.
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults(faults);
      const { GatewayClient } = await import('../../sdk/node/gateway-client');
      const plan = {
        app: 'bench', ttlSeconds: 300,
        providers: { openrouter: { baseUrl: `${fake.url}/or`, apiKey: FAKE_KEYS.OPENROUTER_API_KEY } },
        routes: { chat: { 't-llm': [{ provider: 'openrouter', model: 'a' }, { provider: 'openrouter', model: 'b' }] } },
      };
      const f: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/v1/apps/bench/fallback')) return new Response(JSON.stringify(plan), { headers: { 'content-type': 'application/json' } });
        return fetch(input, init);
      }) as typeof fetch;
      const client = new GatewayClient({ baseUrl: gw.url, apiKey: FAKE_KEYS.GATEWAY_KEY, fetch: f, directFallback: { app: 'bench' } });
      await client.refreshFallbackPlan();
      let err = '';
      try { await client.chat({ model: 't-llm', messages: [{ role: 'user', content: 'oi' }] }); } catch (e) { err = (e as Error).message.slice(0, 120); }
      const n = calls(fake);
      record('8', 'SDK GatewayClient(directFallback) → gateway 503: upstream calls for ONE request', n <= 10 ? 'PASS' : 'FAIL',
        `calls=${n} per model=${byModel(fake)} error=${err}`);
    });
  },

  async 9(fake) {
    await withGateway(fake, { MAX_CONCURRENT_PER_USER: '100' }, async (gw) => {
      fake.setFaults({ a: { kind: 'status', status: 429, headers: { 'retry-after': '5' }, body: { error: { message: 'Rate limit exceeded', code: 429 } } } });
      const t0 = now();
      const rs = await Promise.all(Array.from({ length: 30 }, () => chatJson(gw, {})));
      const log = fake.log();
      const aCalls = log.filter(x => x.model === 'a');
      // A retry of `a` sooner than 5 s after the first 429 the gateway saw.
      const first = Math.min(...aCalls.map(x => x.startedAt));
      const early = aCalls.filter(x => x.startedAt - first > 50 && x.startedAt - first < 5000).length;
      const late = aCalls.filter(x => x.startedAt - first >= 5000).length;
      const lat = rs.map(x => x.ms).sort((x, y) => x - y);
      record('9', '429 retry-after 5 on a, 30 concurrent', early === 0 && late === 0 && lat[lat.length - 1] < 2000 && rs.every(x => x.status === 200) ? 'PASS' : 'FAIL',
        `a calls=${aCalls.length} (retried <5 s: ${early}, retried ≥5 s: ${late}) b calls=${log.filter(x => x.model === 'b').length} statuses=${[...new Set(rs.map(x => x.status))]} p50=${Math.round(lat[15])}ms max=${Math.round(lat[29])}ms wall=${Math.round(now() - t0)}ms`);
    });
  },

  async 11(fake) {
    const cases: Array<{ code: number; label: string; body?: unknown; neutral?: boolean }> = [
      { code: 401, label: '401 invalid key' },
      { code: 402, label: '402 credits' },
      { code: 403, label: '403 moderation', neutral: true, body: { error: { code: 403, message: 'Your chosen model requires moderation and your input was flagged', metadata: { reasons: ['violence'], flagged_input: 'oi', provider_name: 'OpenAI', model_slug: 'a' } } } },
      { code: 408, label: '408 timeout' },
      { code: 429, label: '429 rate limit' },
      { code: 502, label: '502 bad gateway' },
      { code: 503, label: '503 no provider' },
    ];
    for (const c of cases) {
      await withGateway(fake, {}, async (gw) => {
        fake.setFaults({ a: { kind: 'status', status: c.code, body: c.body } });
        // A flagged prompt is flagged by every OpenRouter model: b refuses it too, groq:c answers.
        if (c.neutral) fake.setFaults({ b: { kind: 'status', status: c.code, body: c.body } });
        const r = await chatJson(gw, {});
        const aCalls = calls(fake, x => x.model === 'a');
        const fb = r.headers.get('x-gateway-fallback');
        // Six of them in a row: is the shared `openrouter` breaker (model b too) open?
        for (let i = 0; i < 6; i++) await chatJson(gw, {});
        const states = await linkStates(gw);
        const bOpen = /openrouter:b=circuit_open/.test(states);
        const immediate = r.status === 200 && aCalls === 1 && r.ms < 1000;
        const verdict = immediate && (c.neutral ? !/openrouter:\w=circuit_open/.test(states) : true) ? 'PASS' : 'FAIL';
        void bOpen;
        record('11', c.label, verdict,
          `status=${r.status} ms=${Math.round(r.ms)} a calls(1st request)=${aCalls} fallback=${fb} served=${r.headers.get('x-gateway-provider')}; after 7: ${states}`);
      });
    }
    await withGateway(fake, {}, async (gw) => {
      for (let i = 0; i < 10; i++) {
        await fetch(`${gw.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify({ model: 't-llm', messages: [{ role: 'user', content: 'x' }] }) });
      }
      record('11', 'client 401 (bad gateway key) ×10', calls(fake) === 0 && !/circuit_open/.test(await linkStates(gw)) ? 'PASS' : 'FAIL',
        `upstream calls=${calls(fake)} links: ${await linkStates(gw)}`);
    });
  },

  async 12(fake) {
    const all503 = { kind: 'status' as const, status: 503 };
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults({ a: all503, b: all503, c: all503, 'llama-3.3-70b-versatile': all503, 'meta-llama/llama-3.3-70b-instruct': all503 });
      for (let i = 0; i < 8; i++) await chatJson(gw, {});
      const opened = await linkStates(gw);
      const tOpen = now();
      fake.reset(); // heal everything
      let firstOk: number | null = null;
      let tries = 0;
      while (now() - tOpen < 45_000) {
        tries++;
        const r = await chatJson(gw, {});
        if (r.status === 200) { firstOk = now() - tOpen; break; }
        await sleep(1000);
      }
      record('12', 'all breakers open, upstream heals: time to first 200', firstOk !== null && firstOk <= 32_000 ? 'PASS' : 'FAIL',
        `opened: ${opened}; first 200 after ${firstOk === null ? 'never' : `${Math.round(firstOk)}ms`} (${tries} tries, reset 30 s)`);
    });
    await withGateway(fake, {}, async (gw) => {
      fake.setFaults({ a: all503, b: all503, c: all503, 'llama-3.3-70b-versatile': all503, 'meta-llama/llama-3.3-70b-instruct': all503 });
      for (let i = 0; i < 8; i++) await chatJson(gw, {});
      await sleep(30_500);
      fake.reset();
      fake.setFaults({ a: { kind: 'ok', delayMs: 1500 }, c: { kind: 'ok', delayMs: 1500 } });
      const rs = await Promise.all(Array.from({ length: 100 }, () => chatJson(gw, {})));
      const n = calls(fake);
      record('13', 'half-open, 100 concurrent: probes reaching the upstream', n <= 4 ? 'PASS' : 'FAIL',
        `upstream calls=${n} per model=${byModel(fake)} 200s=${rs.filter(r => r.status === 200).length} 503s=${rs.filter(r => r.status === 503).length}`);
    });
  },

  async 14(fake) {
    await withGateway(fake, { MAX_CONCURRENT_PER_USER: '2' }, async (gw) => {
      const t0 = now();
      for (let i = 0; i < 200; i++) {
        const mode = i % 4;
        fake.reset();
        try {
          if (mode === 0) { // client abort mid-stream
            fake.setFaults({ a: { kind: 'stall-mid', deltas: 1, silentMs: 3000 } });
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 60);
            await chatSse(gw, {}, ac.signal).catch(() => {});
          } else if (mode === 1) { // gateway-side timeout (upstreams never answer, budget 8 s → shortened via abort at 100 ms)
            fake.setFaults({ a: { kind: 'no-answer' } });
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 100);
            await chatJson(gw, {}, ac.signal).catch(() => {});
          } else if (mode === 2) { // mid-stream error
            fake.setFaults({ a: { kind: 'sse-error', deltas: 1, style: 'openrouter' } });
            await chatSse(gw, {});
          } else { // upstream reset
            fake.setFaults({ a: { kind: 'close-mid', deltas: 1 } });
            await chatSse(gw, {});
          }
        } catch { /* expected */ }
      }
      await sleep(300);
      fake.reset();
      const rs = await Promise.all([chatJson(gw, {}), chatJson(gw, {})]);
      record('14', 'limit=2, 200 abort/timeout/error/reset cycles, then 2 concurrent', rs.every(r => r.status === 200) ? 'PASS' : 'FAIL',
        `statuses=${rs.map(r => r.status)} bodies=${rs.map(r => r.status === 200 ? 'ok' : r.text.slice(0, 80))} wall=${Math.round(now() - t0)}ms`);
    });
  },

  async 16(fake) {
    const bodies: string[] = [];
    const gwRun = await withGateway(fake, {}, async (gw) => {
      const all = (f: object) => ({ a: f, b: f, c: f, 'llama-3.3-70b-versatile': f, 'meta-llama/llama-3.3-70b-instruct': f });
      fake.setFaults(all({ kind: 'status', status: 401, body: { error: { message: `Incorrect API key provided: ${FAKE_KEYS.OPENROUTER_API_KEY}`, code: 401 } } }));
      bodies.push((await chatJson(gw, {})).text);
      fake.reset();
      fake.setFaults(all({ kind: 'status', status: 404, body: { error: { message: `No endpoints for key ${FAKE_KEYS.GROQ_API_KEY}` } } }));
      bodies.push((await chatJson(gw, {})).text, (await chatSse(gw, {})).text);
      fake.reset();
      fake.setFaults(all({ kind: 'no-answer' }));
      bodies.push((await chatJson(gw, {})).text);
      fake.setFaults({ 'or:transcriptions': { kind: 'status', status: 401, body: { error: { message: `bad key ${FAKE_KEYS.OPENROUTER_API_KEY}` } } }, 'groq:transcriptions': { kind: 'status', status: 401, body: { error: { message: `bad key ${FAKE_KEYS.GROQ_API_KEY}` } } } });
      bodies.push((await stt(gw, wav())).text);
    });
    // DNS failure: providers pointed at an unresolvable host.
    const gw2Out = await (async () => {
      fake.reset();
      const gw = await startGateway(fake.url, { OPENROUTER_API_BASE: 'http://openrouter.fault-bench.invalid/api/v1', GROQ_API_BASE: 'http://groq.fault-bench.invalid/v1', NO_PROXY: '127.0.0.1,localhost,.invalid', no_proxy: '127.0.0.1,localhost,.invalid' });
      try { bodies.push((await chatJson(gw, {})).text, (await chatSse(gw, {})).text, (await stt(gw, wav())).text); } finally { await gw.stop(); }
      return gw.output();
    })();
    const keys = [FAKE_KEYS.OPENROUTER_API_KEY, FAKE_KEYS.GROQ_API_KEY];
    const inLogs = keys.filter(k => gwRun.output().includes(k) || gw2Out.includes(k));
    const inBodies = keys.filter(k => bodies.some(b => b.includes(k)));
    record('16', 'provider key values in gateway stdout/stderr and client error bodies (401/404/timeout/DNS)', inLogs.length + inBodies.length === 0 ? 'PASS' : 'FAIL',
      `keys in logs=${inLogs.length} in bodies=${inBodies.length}; sample body: ${bodies[0]?.slice(0, 160)}`);
  },

  async 18(fake) {
    let gw!: RunningGateway;
    {
      const check = async (label: string, run: (signal: AbortSignal) => Promise<unknown>, pred: (r: LoggedRequest) => boolean) => {
        fake.reset();
        gw = await startGateway(fake.url, { MAX_CONCURRENT_PER_USER: '1' });
        await prepare();
        const ac = new AbortController();
        const sentAt = Date.now();
        setTimeout(() => ac.abort(), 500);
        await run(ac.signal).catch(() => {});
        const deadline = Date.now() + 6000;
        let seen: LoggedRequest | undefined;
        while (Date.now() < deadline) {
          seen = fake.log().find(x => pred(x) && x.aborted);
          if (seen) break;
          await sleep(50);
        }
        const target = fake.log().find(pred);
        const lag = seen?.abortedAt ? seen.abortedAt - (sentAt + 500) : null;
        // Slot freed? (limit = 1)
        fake.reset();
        const after = await chatJson(gw, {});
        record('18', label, lag !== null && lag <= 1000 && after.status === 200 ? 'PASS' : 'FAIL',
          `upstream saw abort ${lag === null ? `never (within 6 s; upstream ${target ? (target.endedAt ? 'finished normally' : 'still open') : 'not called'})` : `${lag}ms after the client`}; next request (limit 1) status=${after.status}`);
        await gw.stop();
      };
      let prepare: () => Promise<void> = async () => {};
      prepare = async () => { fake.setFaults({ a: { kind: 'ok', chunkGapMs: 1000, chunks: Array.from({ length: 6 }, (_, i) => `t${i} `) } }); };
      await check('chat SSE: client aborts 500 ms after sending', s => chatSse(gw, {}, s), r => r.model === 'a');
      prepare = async () => { fake.setFaults({ a: { kind: 'ok', delayMs: 5000 } }); };
      await check('chat (non-streamed): client aborts 500 ms after sending', s => chatJson(gw, {}, s), r => r.model === 'a');
      prepare = async () => { fake.setFaults({ ta: { kind: 'stall-mid', deltas: 1, silentMs: 5000 } }); };
      await check('TTS: client aborts 500 ms after sending', s => tts(gw, s), r => r.model === 'ta');
      prepare = async () => { fake.setFaults({ 'or:transcriptions': { kind: 'ok', delayMs: 5000 } }); };
      await check('STT: client aborts 500 ms after sending', s => stt(gw, wav(), { signal: s }), r => r.path === '/audio/transcriptions');
      prepare = async () => { fake.setFaults({ a: { kind: 'ok', chunkGapMs: 1000, chunks: Array.from({ length: 6 }, (_, i) => `Frase ${i}. `) } }); };
      await check('s2s (composed): client aborts 500 ms after sending', async (s) => {
        const form = new FormData();
        form.set('file', new Blob([wav()], { type: 'audio/wav' }), 'turn.wav');
        form.set('config', JSON.stringify({ language: 'pt' }));
        const res = await fetch(`${gw.url}/v1/s2s?format=ndjson`, { method: 'POST', headers: AUTH, body: form, signal: s });
        await res.text();
      }, r => r.model === 'a');
    }
  },

  async 21(fake) {
    await withGateway(fake, {}, async (gw) => {
      const post = async (path: string, size: number, chunked: boolean, contentType = 'multipart/form-data; boundary=XyZ') => {
        const head = Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="model"\r\n\r\nt-stt\r\n--XyZ\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n');
        const tail = Buffer.from('\r\n--XyZ--\r\n');
        const total = head.length + size + tail.length;
        const t0 = now();
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(ctl) {
            if (sent === 0) { ctl.enqueue(head); sent += head.length; return; }
            const left = head.length + size - sent;
            if (left > 0) { const n = Math.min(left, 1 << 20); ctl.enqueue(new Uint8Array(n).fill(1)); sent += n; return; }
            ctl.enqueue(tail); ctl.close();
          },
        });
        try {
          const res = await fetch(`${gw.url}${path}`, {
            method: 'POST', body: chunked ? body : await new Response(body).arrayBuffer(),
            headers: { ...AUTH, 'content-type': contentType, ...(chunked ? {} : { 'content-length': String(total) }) },
            // @ts-expect-error Bun/undici streaming upload
            duplex: 'half',
          });
          return { status: res.status, text: (await res.text()).slice(0, 140), ms: Math.round(now() - t0) };
        } catch (err) {
          return { status: 0, text: String((err as Error).message).slice(0, 140), ms: Math.round(now() - t0) };
        }
      };
      const rows: string[] = [];
      for (const [path, label] of [['/v1/audio/transcriptions', 'STT'], ['/v1/s2s', 's2s']] as const) {
        for (const [size, name] of [[0, '0 B'], [26 * 1024 * 1024, '26 MB'], [200 * 1024 * 1024, '200 MB']] as const) {
          for (const chunked of [false, true]) {
            const r = await post(path, size, chunked);
            rows.push(`${label} ${name} ${chunked ? 'chunked' : 'length'} → ${r.status} in ${r.ms}ms: ${r.text}`);
          }
        }
      }
      const r200 = rows.filter(x => x.includes('200 MB'));
      const bad = r200.filter(x => !/→ 413/.test(x));
      const has401 = rows.some(x => / → 401 /.test(x));
      record('21', 'body size matrix (0 / 26 MB / 200 MB × length / chunked)', bad.length === 0 && !has401 ? 'PASS' : 'FAIL', rows.join(' | '));
    });
  },

  async 23(fake) {
    await withGateway(fake, {}, async (gw) => {
      const audio = wav(1, 7);
      fake.setFaults({ 'or:transcriptions': [{ kind: 'empty', shape: 'content' }, { kind: 'ok', text: 'bom dia' }] });
      const r1 = await stt(gw, audio, { language: 'pt' });
      const r2 = await stt(gw, audio, { language: 'pt' });
      record('23', '200 with text "" then real text (same audio)', !(r2.headers.get('x-cache') === 'HIT' && JSON.parse(r2.text).text === '') ? 'PASS' : 'FAIL',
        `1st=${r1.text} cache=${r1.headers.get('x-cache')} provider=${r1.headers.get('x-gateway-provider')}; 2nd=${r2.text} cache=${r2.headers.get('x-cache')}`);
      fake.reset();
      fake.setFaults({ 'or:transcriptions': { kind: 'ok', text: 'bom dia' } });
      const audio2 = wav(1, 9);
      await stt(gw, audio2, { language: 'pt' });
      fake.setFaults({ 'or:transcriptions': { kind: 'ok', text: 'bonjour' } });
      const fr = await stt(gw, audio2, { language: 'fr' });
      record('23', 'same audio, language pt then fr', fr.headers.get('x-cache') === 'MISS' && JSON.parse(fr.text).text === 'bonjour' ? 'PASS' : 'FAIL',
        `fr → ${fr.text} cache=${fr.headers.get('x-cache')}`);
      fake.reset();
      const audio3 = wav(1, 11);
      fake.setFaults({ 'or:transcriptions': { kind: 'status', status: 503 }, 'groq:transcriptions': { kind: 'ok', text: 'resposta do fallback' } });
      const f1 = await stt(gw, audio3, { language: 'pt' });
      fake.reset();
      fake.setFaults({ 'or:transcriptions': { kind: 'ok', text: 'resposta do primário' } });
      const f2 = await stt(gw, audio3, { language: 'pt' });
      record('23', 'fallback-provider result reused for the next identical request', f2.headers.get('x-cache') !== 'HIT' ? 'PASS' : 'FAIL',
        `1st via ${f1.headers.get('x-gateway-provider')} (fallback=${f1.headers.get('x-gateway-fallback')}); 2nd cache=${f2.headers.get('x-cache')} text=${f2.text}`);
      fake.reset();
      const audio4 = wav(1, 13);
      fake.setFaults({ 'or:transcriptions': { kind: 'status', status: 503 }, 'groq:transcriptions': { kind: 'status', status: 503 } });
      const e1 = await stt(gw, audio4);
      fake.reset();
      const e2 = await stt(gw, audio4);
      record('23', 'error never cached', e1.status === 503 && e2.status === 200 && e2.headers.get('x-cache') === 'MISS' ? 'PASS' : 'FAIL',
        `1st=${e1.status}; 2nd=${e2.status} cache=${e2.headers.get('x-cache')}`);
    });
  },

  async 24(fake) {
    await withGateway(fake, {}, async (gw) => {
      const audio = wav(3, 5);
      fake.setFaults({ 'or:transcriptions': { kind: 'status', status: 502, readBody: 'half' } });
      const r = await stt(gw, audio, { language: 'pt' });
      const log = fake.log().filter(x => x.path === '/audio/transcriptions');
      const second = log.find(x => x.tag === 'groq');
      const expected = new Bun.CryptoHasher('sha256').update(audio).digest('hex');
      record('24', 'primary reads 50 % then 502 → secondary gets the same file', r.status === 200 && second?.fileSha256 === expected ? 'PASS' : 'FAIL',
        `status=${r.status} served=${r.headers.get('x-gateway-provider')} primary read ${log[0]?.bodyBytes}B; secondary file sha ${second?.fileSha256 === expected ? 'identical' : `DIFFERENT (${second?.fileSha256?.slice(0, 12)} vs ${expected.slice(0, 12)})`}`);
      fake.reset();
      const m4a = mp4();
      const r2 = await stt(gw, m4a, { filename: 'blob', type: 'audio/mp4' });
      const got = fake.log().find(x => x.path === '/audio/transcriptions');
      record('24', 'iPhone audio/mp4, filename without extension', r2.status === 200 && /m4a|mp4/.test(`${got?.fileName}`) && got?.fileType === 'audio/mp4' ? 'PASS' : 'FAIL',
        `status=${r2.status} upstream filename=${got?.fileName} type=${got?.fileType} sha=${got?.fileSha256 === new Bun.CryptoHasher('sha256').update(m4a).digest('hex') ? 'identical' : 'different'}`);
    });
  },

  async 26(fake) {
    await withGateway(fake, {}, async (gw) => {
      for (const shape of ['content', 'choices'] as const) {
        fake.reset();
        fake.setFaults({ a: { kind: 'empty', shape } });
        const r = await chatJson(gw, {});
        const content = r.status === 200 ? (JSON.parse(r.text) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content : '';
        record('26', `non-streamed empty 200 (${shape === 'content' ? 'content:"" finish_reason:length' : 'choices:[]'})`,
          r.status === 200 && content.length > 0 && r.headers.get('x-gateway-fallback') === 'empty' ? 'PASS' : 'FAIL',
          `status=${r.status} fallback=${r.headers.get('x-gateway-fallback')} served=${r.headers.get('x-gateway-provider')} content=${JSON.stringify(content)}`);
        fake.reset();
        fake.setFaults({ a: { kind: 'empty', shape } });
        const s = await chatSse(gw, {});
        record('26', `streamed empty 200 (${shape})`, s.content.length > 0 && s.done ? 'PASS' : 'FAIL',
          `status=${s.status} fallback=${s.headers.get('x-gateway-fallback')} served=${s.headers.get('x-gateway-provider')} content=${JSON.stringify(s.content)}`);
      }
    });
  },

  async '29a'(fake) {
    fake.reset();
    const gw = await startGateway(fake.url, {});
    const { GatewayClient } = await import('../../sdk/node/gateway-client');
    const plan = {
      app: 'bench', ttlSeconds: 300,
      providers: { openrouter: { baseUrl: `${fake.url}/or`, apiKey: FAKE_KEYS.OPENROUTER_API_KEY } },
      routes: { chat: { 't-llm': [{ provider: 'openrouter', model: 'direct-a' }] } },
    };
    const f: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/v1/apps/bench/fallback')) return new Response(JSON.stringify(plan), { headers: { 'content-type': 'application/json' } });
      return fetch(input, init);
    }) as typeof fetch;
    const client = new GatewayClient({ baseUrl: gw.url, apiKey: FAKE_KEYS.GATEWAY_KEY, fetch: f, directFallback: { app: 'bench' } });
    await client.refreshFallbackPlan();
    fake.setFaults({ a: { kind: 'ok', chunkGapMs: 400, chunks: Array.from({ length: 10 }, (_, i) => `p${i} `) } });
    const stream = await client.chatStream({ model: 't-llm', messages: [{ role: 'user', content: 'oi' }] });
    const got: string[] = [];
    let midErr = '';
    const killAt = now();
    setTimeout(() => gw.proc.kill('SIGKILL'), 1200);
    try { for await (const d of stream) got.push(d); } catch (err) { midErr = `${(err as Error).name}: ${(err as Error).message.slice(0, 100)}`; }
    const brokenAfter = Math.round(now() - killAt);
    record('29a', 'gateway killed mid-stream: the delivered part is not replayed, the break is reported', midErr !== '' ? 'PASS' : 'FAIL',
      `received ${got.length} deltas (${JSON.stringify(got.join(''))}) then ${midErr || 'NO ERROR — the stream looked complete'} after ${brokenAfter}ms`);
    const t0 = now();
    let text = '';
    let served = '';
    try {
      const s2 = await client.chatStream({ model: 't-llm', messages: [{ role: 'user', content: 'de novo' }] });
      for await (const d of s2) text += d;
      served = s2.served.provider ?? '';
    } catch (err) { text = `ERR ${(err as Error).message}`; }
    const ms = Math.round(now() - t0);
    const directCalls = fake.log().filter(x => x.model === 'direct-a');
    record('29a', 'next call with the gateway down goes direct to the fake OpenRouter', served.startsWith('openrouter-direct') && text.length > 0 && ms < 2000 ? 'PASS' : 'FAIL',
      `served=${served} in ${ms}ms text=${JSON.stringify(text.slice(0, 60))} direct calls=${directCalls.length} state=${JSON.stringify(client.gatewayState())}`);
    await gw.stop();
  },
};

// Item 10 (hedging) and the in-process checks run without serve.ts: cloud targets get no hedge from MODEL_ROUTES
// (`hedgeAfterMs` is set only on deployment links), so the routing core is driven directly over real HTTP.
scenarios['10'] = async (fake) => {
  fake.reset();
  const { runTargets } = await import('../../src/gateway/proxy/provider-routing');
  const { CircuitBreakerRegistry } = await import('../../src/gateway/providers/cloud/circuit-breaker');
  const { OpenAICompatLLMProvider } = await import('../../src/gateway/providers/cloud/openai-compat/openai-compat-llm');
  process.env.FAULT_BENCH_KEY = 'sk-fake-hedge-0123456789';
  const p = new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: `${fake.url}/or`, envKey: 'FAULT_BENCH_KEY' });
  fake.setFaults({ 'h-primary': { kind: 'ok', delayMs: 3000, text: 'primary' }, 'h-secondary': { kind: 'ok', delayMs: 1500, text: 'secondary' } });
  const t0 = now();
  const out = await runTargets(
    [{ providerId: 'p1', provider: p, model: 'h-primary', hedgeAfterMs: 1000 }, { providerId: 'p2', provider: p, model: 'h-secondary' }],
    (t, signal) => t.provider.chat({ model: t.model!, messages: [{ role: 'user', content: 'x' }], signal }),
    { stage: 'llm', timeoutMs: 15_000, budgetMs: 8_000, breakers: new CircuitBreakerRegistry() },
  );
  const ms = Math.round(now() - t0);
  await sleep(300);
  const prim = fake.log().find(x => x.model === 'h-primary');
  const sec = fake.log().find(x => x.model === 'h-secondary');
  record('10', 'hedge at 1 s: primary 3 s vs secondary 1.5 s', out.result.content === 'secondary' && prim?.aborted === true ? 'PASS' : 'FAIL',
    `winner=${out.target.providerId} content=${out.result.content} in ${ms}ms (expected ≈2500); secondary started at +${sec ? sec.startedAt - (prim?.startedAt ?? 0) : '-'}ms; primary aborted=${prim?.aborted} at +${prim?.abortedAt ? prim.abortedAt - prim.startedAt : '-'}ms; upstream calls=${fake.log().length}`);
};

const ORDER = ['1', '2', '3', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '18', '21', '23', '24', '26', '29a'];

console.log(`bun ${Bun.version}`);
const fake = await startFakeUpstream();
const wanted = process.argv.slice(2);
for (const id of ORDER) {
  if (wanted.length && !wanted.includes(id) && !(id === '12' && wanted.includes('13'))) continue;
  const t0 = now();
  try { await scenarios[id](fake); } catch (err) { record(id, 'scenario crashed', 'FAIL', String((err as Error).stack ?? err).slice(0, 400)); }
  console.log(`   (item ${id}: ${Math.round((now() - t0) / 1000)} s)`);
}
// Connections left open on purpose (no-answer faults) must not hold the exit.
await Promise.race([fake.close(), sleep(2000)]);
console.log('\nJSON ' + JSON.stringify(results));
process.exit(0);
