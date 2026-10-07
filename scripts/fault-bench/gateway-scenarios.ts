/**
 * Fault bench, gateway scenarios (2026-10-07): the real `serve.ts` (gateway.ts) against the fake upstream.
 *
 *   S2  OpenRouter and Groq both down (no deployment either): clean 503s with reasons, fast, no retry storm;
 *       then the Node SDK with the gateway itself down — keyless plan, no plan, hanging gateway, minted key.
 *   S3  the gateway process dies (SIGKILL) / is stopped (SIGTERM) with streams and s2s turns in flight; SDK after restart.
 *   S4  slow readers (backpressure) and 500 mid-stream disconnects: slots, upstream aborts, memory.
 *   S5  compressed soak with random faults (5 % 5xx, 2 % timeouts, 1 % mid-stream drops).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { FakeUpstream } from './fake-upstream';
import { FAKE_KEYS, fakeKey, startGateway, type RunningGateway } from './gateway';
import type { Record_ } from './deployment-scenarios';

const AUTH = { authorization: `Bearer ${FAKE_KEYS.GATEWAY_KEY}` };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const now = () => performance.now();
let uniq = 0;
const prompt = (tag = 'oi') => [{ role: 'user', content: `${tag} ${++uniq} ${Date.now()}` }];

function wav(seconds = 1, seed = 1): Uint8Array {
  const samples = 16000 * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((i * seed) / 10) * 8000), 44 + i * 2);
  return new Uint8Array(buf);
}

interface Outcome { status: number; text: string; ms: number; error: string | null; headers: Headers | null }

/** Any request, body read to the end (or until it breaks); never throws. */
async function call(url: string, init: RequestInit & { readGapMs?: number } = {}): Promise<Outcome> {
  const t0 = now();
  try {
    const res = await fetch(url, init);
    let text = '';
    let error: string | null = null;
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += dec.decode(value, { stream: true });
          if (init.readGapMs) await sleep(init.readGapMs);
        }
      } catch (err) { error = (err as Error).message || String(err); }
    }
    return { status: res.status, text, ms: now() - t0, error, headers: res.headers };
  } catch (err) {
    return { status: 0, text: '', ms: now() - t0, error: (err as Error).message || String(err), headers: null };
  }
}

const json = (body: unknown) => ({ method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chatSse = (gw: RunningGateway, signal?: AbortSignal, extra: RequestInit & { readGapMs?: number } = {}) =>
  call(`${gw.url}/v1/chat/completions`, { ...json({ model: 't-llm', messages: prompt(), stream: true }), signal, ...extra });
const chatJson = (gw: RunningGateway, signal?: AbortSignal) => call(`${gw.url}/v1/chat/completions`, { ...json({ model: 't-llm', messages: prompt() }), signal });
const tts = (gw: RunningGateway, signal?: AbortSignal) =>
  call(`${gw.url}/v1/audio/speech`, { ...json({ model: 't-tts', input: `Olá ${++uniq}`, voice: 'alloy', response_format: 'mp3' }), signal });
function stt(gw: RunningGateway, audio = wav(1, ++uniq), signal?: AbortSignal) {
  const form = new FormData();
  form.set('file', new Blob([audio], { type: 'audio/wav' }), 'turn.wav');
  form.set('model', 't-stt');
  form.set('language', 'pt');
  return call(`${gw.url}/v1/audio/transcriptions`, { method: 'POST', headers: AUTH, body: form, signal });
}
function s2s(gw: RunningGateway, signal?: AbortSignal, readGapMs?: number) {
  const form = new FormData();
  form.set('file', new Blob([wav(1, ++uniq)], { type: 'audio/wav' }), 'turn.wav');
  form.set('config', JSON.stringify({ language: 'pt' }));
  return call(`${gw.url}/v1/s2s?format=ndjson`, { method: 'POST', headers: AUTH, body: form, signal, readGapMs });
}

const errMsg = (o: Outcome) => { try { return (JSON.parse(o.text) as { error?: { message?: string } }).error?.message ?? o.text.slice(0, 200); } catch { return o.text.slice(0, 200); } };

/** Process view of the gateway: RSS (MB), open fds, and its own active-connection count. */
async function procStats(gw: RunningGateway) {
  const pid = gw.proc.pid!;
  let rssMb = -1;
  let fds = -1;
  try { rssMb = Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024); } catch { /* gone */ }
  try { fds = readdirSync(`/proc/${pid}/fd`).length; } catch { /* gone */ }
  let active = -1;
  try { active = ((await (await fetch(`${gw.url}/health`)).json()) as { connections?: { active?: number } }).connections?.active ?? -1; } catch { /* down */ }
  return { rssMb, fds, active };
}

const ALL_CHAT = ['a', 'b', 'c', 'llama-3.3-70b-versatile', 'meta-llama/llama-3.3-70b-instruct'];

// ── S2 ──────────────────────────────────────────────────────────────────────

export async function scenario2(fake: FakeUpstream, record: Record_): Promise<void> {
  fake.reset();
  const gw = await startGateway(fake.url, {});
  try {
    const down = { kind: 'status', status: 503 } as const;
    const setDown = () => fake.setFaults({
      ...Object.fromEntries(ALL_CHAT.map(m => [m, down])), 'or:transcriptions': down, 'groq:transcriptions': down, ta: down, tc: down,
    });
    setDown();
    for (const [label, run] of [['chat', () => chatJson(gw)], ['chat stream', () => chatSse(gw)], ['STT', () => stt(gw)], ['TTS', () => tts(gw)], ['s2s', () => s2s(gw)]] as const) {
      fake.reset(); setDown();
      const o = await run();
      const upstream = fake.log().length;
      const msg = errMsg(o);
      const named = /openrouter/.test(msg) && /groq/.test(msg);
      record('S2', `${label}: everything down → 503 with reasons, within budget, no retry storm`,
        o.status === 503 && named && o.ms < 9000 && upstream <= 12 ? 'PASS' : 'FAIL',
        `status=${o.status} in ${Math.round(o.ms)}ms, upstream calls=${upstream}; message: ${msg.slice(0, 260)}`);
    }
    // 30 concurrent while everything is down: the breakers open, the calls do not multiply.
    fake.reset(); setDown();
    const t0 = now();
    const many = await Promise.all(Array.from({ length: 30 }, () => chatJson(gw)));
    const ms = many.map(o => o.ms).sort((a, b) => a - b);
    record('S2', '30 concurrent chats with everything down: all 503, upstream calls bounded', many.every(o => o.status === 503) && fake.log().length <= 30 * 10 ? 'PASS' : 'FAIL',
      `statuses=${[...new Set(many.map(o => o.status))]} upstream calls=${fake.log().length} (${(fake.log().length / 30).toFixed(1)}/req) p50=${Math.round(ms[15])}ms max=${Math.round(ms[29])}ms wall=${Math.round(now() - t0)}ms`);
    fake.reset(); setDown();
    const later = await Promise.all(Array.from({ length: 10 }, () => chatJson(gw)));
    record('S2', 'next 10 with the breakers open: fast 503, (almost) no upstream call', later.every(o => o.status === 503) ? 'PASS' : 'FAIL',
      `max=${Math.round(Math.max(...later.map(o => o.ms)))}ms upstream calls=${fake.log().length}; message: ${errMsg(later[0]).slice(0, 200)}`);
  } finally { await gw.stop(); }
  await scenario2Sdk(fake, record);
}

/** The Node SDK when the gateway itself is down (or hangs). */
async function scenario2Sdk(fake: FakeUpstream, record: Record_): Promise<void> {
  const { GatewayClient } = await import('../../sdk/node/gateway-client');
  fake.reset();
  // A port that refuses connections: the gateway process is gone.
  const gone = await startGateway(fake.url, {});
  const deadUrl = gone.url;
  await gone.stop();
  const plan = (providers: Record<string, unknown>, routes: Record<string, unknown>) => ({
    app: 'bench', issuedAt: new Date().toISOString(), ttlSeconds: 3600, providers, openrouter: providers.openrouter ?? null,
    routes: { stt: {}, chat: {}, tts: {}, ...routes },
  });
  const keyless = plan({}, {});
  const minted = plan(
    { openrouter: { baseUrl: `${fake.url}/or`, apiKey: fakeKey('minted'), keyKind: 'provisioned', expiresAt: null, limitUsd: 5 } },
    {
      chat: { 't-llm': [{ provider: 'openrouter', model: 'direct-a' }] },
      stt: { 't-stt': [{ provider: 'openrouter', model: 'openai/whisper-direct' }] },
      tts: { 't-tts': [{ provider: 'openrouter', model: 'direct-tts', voice: 'alloy' }] },
    },
  );
  /** fetch that serves the plan (as the gateway would have before it went down) and passes everything else through. */
  const withPlan = (p: unknown | null): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (p && String(input).includes('/v1/apps/bench/fallback')) return Response.json(p);
    return fetch(input, init);
  }) as typeof fetch;
  const ops = (c: InstanceType<typeof GatewayClient>) => ({
    chat: () => c.chat({ model: 't-llm', messages: prompt() }),
    chatStream: async () => { const s = await c.chatStream({ model: 't-llm', messages: prompt() }); let t = ''; for await (const d of s) t += d; return t; },
    transcribe: () => c.transcribe({ model: 't-stt', file: wav(1, 7), filename: 'a.wav', language: 'pt' }),
    speech: async () => { const r = await c.speech({ model: 't-tts', input: 'oi', voice: 'alloy' }); return new Uint8Array(await new Response(r.body).arrayBuffer()).length; },
    s2s: async () => { const s = await c.s2s({ file: wav(1, 9), config: { language: 'pt' } }); let frames = 0; for await (const frame of s) frames += frame ? 1 : 0; return `${frames} frames`; },
  });
  const timeIt = async (fn: () => Promise<unknown>) => {
    const t0 = now();
    try { const v = await fn(); return { ms: Math.round(now() - t0), ok: true, out: JSON.stringify(v).slice(0, 120), code: '', msg: '' }; } catch (err) {
      const e = err as { code?: string; message?: string };
      return { ms: Math.round(now() - t0), ok: false, out: '', code: e.code ?? 'error', msg: (e.message ?? String(err)).slice(0, 220) };
    }
  };

  // (a) keyless plan cached (no OPENROUTER_PROVISIONING_KEY): 5 rounds of every call.
  {
    const c = new GatewayClient({ baseUrl: deadUrl, apiKey: FAKE_KEYS.GATEWAY_KEY, fetch: withPlan(keyless), directFallback: { app: 'bench' } });
    await c.refreshFallbackPlan();
    const rows: string[] = [];
    let worst = 0;
    let clear = true;
    for (let round = 0; round < 5; round++) {
      for (const [name, fn] of Object.entries(ops(c))) {
        const r = await timeIt(fn);
        worst = Math.max(worst, r.ms);
        if (r.ok) clear = false;
        if (round === 0 || round === 4) rows.push(`${name}#${round}: ${r.ms}ms ${r.code} «${r.msg.slice(0, 110)}»`);
      }
    }
    const lastMsgs = rows.filter(r => r.includes('#4'));
    const explains = lastMsgs.every(r => /direct|fallback|no provider key|keyless|unreachable/i.test(r));
    record('S2-SDK', 'gateway down + keyless plan: every call fails fast (< 2 s) with a clear error', !clear || worst >= 2000 ? 'FAIL' : explains ? 'PASS' : 'FAIL',
      `worst=${worst}ms; ${rows.join(' | ')}; state=${JSON.stringify(c.gatewayState())}`);
  }
  // (b) no plan at all (the gateway went down before the client fetched one).
  {
    const c = new GatewayClient({ baseUrl: deadUrl, apiKey: FAKE_KEYS.GATEWAY_KEY, directFallback: { app: 'bench' } });
    const rs = [] as Array<Awaited<ReturnType<typeof timeIt>>>;
    for (let i = 0; i < 4; i++) rs.push(await timeIt(ops(c).chat));
    record('S2-SDK', 'gateway down + no plan cached: fails fast every call', rs.every(r => !r.ok && r.ms < 2000) ? 'PASS' : 'FAIL',
      rs.map(r => `${r.ms}ms ${r.code} «${r.msg.slice(0, 90)}»`).join(' | '));
  }
  // (c) the gateway accepts TCP and never answers (hung process / dead edge), keyless plan.
  {
    const hang = createServer(() => { /* accept, never answer */ });
    await new Promise<void>(r => hang.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(hang.address() as { port: number }).port}`;
    const c = new GatewayClient({ baseUrl: url, apiKey: FAKE_KEYS.GATEWAY_KEY, fetch: withPlan(keyless), directFallback: { app: 'bench' }, timeoutMs: { chat: 3000, health: 1000 } });
    await c.refreshFallbackPlan();
    const rs = [] as Array<Awaited<ReturnType<typeof timeIt>>>;
    for (let i = 0; i < 5; i++) rs.push(await timeIt(ops(c).chat));
    record('S2-SDK', 'hung gateway (accepts, never answers) + keyless plan: bounded by the call timeout (3 s here), never hangs',
      rs.every(r => !r.ok && r.ms < 3500) ? 'PASS' : 'FAIL', rs.map(r => `${r.ms}ms ${r.code}`).join(' | '));
    const c2 = new GatewayClient({ baseUrl: url, apiKey: FAKE_KEYS.GATEWAY_KEY, directFallback: { app: 'bench' }, timeoutMs: { chat: 3000, health: 1000 } });
    const r2 = await timeIt(ops(c2).chat);
    record('S2-SDK', 'hung gateway + no plan: the plan fetch adds at most its own timeout', !r2.ok && r2.ms < 3000 + 1000 + 500 ? 'PASS' : 'FAIL',
      `${r2.ms}ms ${r2.code} «${r2.msg.slice(0, 100)}»`);
    hang.close();
  }
  // (d) minted key: direct fallback serves chat / stream / STT (filtered) / TTS.
  {
    fake.reset();
    fake.setFaults({ 'or:transcriptions': { kind: 'ok', text: 'Legendas pela comunidade Amara.org' } });
    const c = new GatewayClient({ baseUrl: deadUrl, apiKey: FAKE_KEYS.GATEWAY_KEY, fetch: withPlan(minted), directFallback: { app: 'bench' } });
    await c.refreshFallbackPlan();
    const o = ops(c);
    const chat = await timeIt(async () => { const r = await o.chat(); return { content: (r as { choices: Array<{ message: { content: string } }> }).choices[0].message.content, served: r.served.provider }; });
    const stream = await timeIt(o.chatStream);
    const tr = await timeIt(async () => { const r = await o.transcribe(); return { text: r.text, filtered: (r as { filtered?: unknown }).filtered, served: r.served.provider }; });
    const sp = await timeIt(o.speech);
    const sttReq = fake.log().find(x => x.path === '/audio/transcriptions');
    const ok = chat.ok && stream.ok && tr.ok && sp.ok && /"text":""/.test(tr.out) && /filtered/.test(tr.out) && /direct/.test(chat.out);
    record('S2-SDK', 'gateway down + minted key: direct fallback serves chat/stream/STT/TTS; STT hallucination filtered in the SDK', ok ? 'PASS' : 'FAIL',
      `chat ${chat.ms}ms ${chat.out || chat.msg} | stream ${stream.ms}ms ${stream.out || stream.msg} | stt ${tr.ms}ms ${tr.out || tr.msg} (upstream got model=${sttReq?.model}) | tts ${sp.ms}ms ${sp.out || sp.msg}`);
  }
}

// ── S3: the gateway dies / stops with work in flight ────────────────────────

export async function scenario3Gateway(fake: FakeUpstream, record: Record_): Promise<void> {
  const slow = { kind: 'ok', chunkGapMs: 300, chunks: Array.from({ length: 20 }, (_, i) => `Parte ${i}. `) } as const;
  for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
    fake.reset();
    fake.setFaults({ a: slow });
    const gw = await startGateway(fake.url, {});
    try {
      const started = now();
      let killedAt = 0;
      const runs = [
        ...Array.from({ length: 10 }, () => chatSse(gw).then(o => ({ kind: 'sse', o, end: now() }))),
        ...Array.from({ length: 5 }, () => s2s(gw).then(o => ({ kind: 's2s', o, end: now() }))),
      ];
      await sleep(1500);
      killedAt = now();
      gw.proc.kill(signal);
      const exited = new Promise<number>(r => gw.proc.once('exit', () => r(now())));
      await sleep(300);
      const during = await chatJson(gw);
      const done = await Promise.all(runs);
      const exitAt = await Promise.race([exited, sleep(30_000).then(() => -1)]);
      const describe = (x: typeof done[number]) => {
        const complete = x.kind === 'sse' ? x.o.text.includes('[DONE]') : /"type":"done"/.test(x.o.text) && !/"partial":true/.test(x.o.text);
        const inband = x.kind === 'sse' ? /"error"/.test(x.o.text) : /"type":"error"/.test(x.o.text);
        return { complete, inband, cut: x.o.error !== null, after: Math.round(x.end - killedAt) };
      };
      const ds = done.map(describe);
      const silentClean = ds.filter(d => !d.complete && !d.cut && !d.inband).length;
      const summary = (kind: string) => {
        const xs = done.map((x, i) => ({ x, d: ds[i] })).filter(({ x }) => x.kind === kind);
        return `${kind}: complete=${xs.filter(({ d }) => d.complete).length}/${xs.length} cut(error)=${xs.filter(({ d }) => d.cut).length} in-band error=${xs.filter(({ d }) => d.inband).length} ended +${Math.min(...xs.map(({ d }) => d.after))}…+${Math.max(...xs.map(({ d }) => d.after))}ms after the ${signal}`;
      };
      if (signal === 'SIGKILL') {
        record('S3', 'SIGKILL with 10 SSE + 5 s2s in flight: every client sees a broken stream at once (never a clean, truncated end)',
          silentClean === 0 && ds.every(d => !d.complete && d.after < 1000) ? 'PASS' : 'FAIL',
          `${summary('sse')}; ${summary('s2s')}; truncated-but-clean=${silentClean}; new request after the kill: status=${during.status} (${during.error?.slice(0, 60)})`);
      } else {
        record('S3', 'SIGTERM with 10 SSE + 5 s2s in flight: in-flight streams drain to completion, new requests refused, process exits',
          ds.every(d => d.complete) && during.status !== 200 && exitAt > 0 ? 'PASS' : 'FAIL',
          `${summary('sse')}; ${summary('s2s')}; request during drain: status=${during.status} ${during.error ?? ''}; exited ${exitAt > 0 ? `${Math.round(exitAt - killedAt)}ms after SIGTERM` : 'NOT within 30 s'} (started ${Math.round(killedAt - started)}ms in)`);
      }
    } finally { await gw.stop(); }
  }

  // SDK across a restart on the same port: what the app sees while down, and how soon it recovers.
  const { GatewayClient } = await import('../../sdk/node/gateway-client');
  fake.reset();
  const gw1 = await startGateway(fake.url, {});
  const port = gw1.port;
  const keyless = { app: 'bench', issuedAt: new Date().toISOString(), ttlSeconds: 3600, providers: {}, openrouter: null, routes: { stt: {}, chat: {}, tts: {} } };
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes('/v1/apps/bench/fallback') ? Response.json(keyless) : fetch(input, init))) as typeof fetch;
  for (const mode of ['plain', 'directFallback(keyless)'] as const) {
    const c = new GatewayClient({ baseUrl: gw1.url, apiKey: FAKE_KEYS.GATEWAY_KEY, fetch: f, ...(mode === 'plain' ? {} : { directFallback: { app: 'bench' } }) });
    await c.refreshFallbackPlan();
    let gw: RunningGateway = mode === 'plain' ? gw1 : await startGateway(fake.url, { PORT: String(port) });
    const ok1 = await c.chat({ model: 't-llm', messages: prompt() }).then(() => true, () => false);
    await gw.stop();
    const whileDown: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t0 = now();
      const r = await c.chat({ model: 't-llm', messages: prompt() }).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
      whileDown.push(`${r}/${Math.round(now() - t0)}ms`);
    }
    gw = await startGateway(fake.url, { PORT: String(port) });
    const back = now();
    let firstOk = -1;
    const attempts: string[] = [];
    while (now() - back < 40_000) {
      const r = await c.chat({ model: 't-llm', messages: prompt() }).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
      attempts.push(r);
      if (r === 'ok') { firstOk = Math.round(now() - back); break; }
      await sleep(500);
    }
    record('S3-SDK', `SDK (${mode}) across a restart: fast failures while down, first success soon after the gateway is back (< 2 s)`,
      ok1 && firstOk >= 0 && firstOk < 2000 ? 'PASS' : 'FAIL',
      `before=${ok1 ? 'ok' : 'fail'}; while down: ${whileDown.join(', ')}; after restart: first success ${firstOk >= 0 ? `+${firstOk}ms` : 'NEVER in 40 s'} after ${attempts.length} calls (${[...new Set(attempts)].join('/')}); state=${JSON.stringify(c.gatewayState())}`);
    await gw.stop();
  }
}

// ── S4: slow and vanishing clients ──────────────────────────────────────────

export async function scenario4(fake: FakeUpstream, record: Record_): Promise<void> {
  fake.reset();
  const gw = await startGateway(fake.url, {});
  try {
    // Slow readers: the answer must arrive whole; how much the gateway buffers is reported.
    fake.setFaults({ a: { kind: 'ok', chunkGapMs: 2, chunks: Array.from({ length: 300 }, (_, i) => `palavra${i} `) } });
    const before = await procStats(gw);
    const slow = await Promise.all(Array.from({ length: 20 }, () => chatSse(gw, undefined, { readGapMs: 150 })));
    const upstreamEnds = fake.log().filter(x => x.model === 'a').map(x => (x.endedAt ?? 0) - x.startedAt);
    const whole = slow.every(o => o.text.includes('[DONE]') && o.text.includes('palavra299'));
    const mid = await procStats(gw);
    record('S4', '20 slow SSE readers (150 ms per read): answers arrive whole', whole ? 'PASS' : 'FAIL',
      `client time p50=${Math.round(slow.map(o => o.ms).sort((a, b) => a - b)[10])}ms vs upstream done in ≤${Math.max(...upstreamEnds)}ms (the gateway reads the upstream to the end and buffers it: no backpressure toward the provider); RSS ${before.rssMb}→${mid.rssMb} MB`);
    fake.reset();
    const slowS2s = await Promise.all(Array.from({ length: 5 }, () => s2s(gw, undefined, 50)));
    record('S4', '5 slow s2s readers: turns arrive whole', slowS2s.every(o => /"type":"done"/.test(o.text)) ? 'PASS' : 'FAIL',
      `p50=${Math.round(slowS2s.map(o => o.ms).sort((a, b) => a - b)[2])}ms errors=${slowS2s.filter(o => o.error).length}`);

    // 500 disconnects at random points of chat SSE / s2s / TTS / STT.
    fake.reset();
    const slowFaults = () => fake.setFaults({
      a: { kind: 'ok', chunkGapMs: 40, chunks: Array.from({ length: 15 }, (_, i) => `t${i}. `) },
      ta: { kind: 'ok', chunkGapMs: 60 },
      'or:transcriptions': { kind: 'ok', delayMs: 400 },
    });
    slowFaults();
    let rnd = 7;
    const r = () => { rnd = (rnd * 48271) % 2147483647; return rnd / 2147483647; };
    const cycle = async (i: number) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 20 + Math.floor(r() * 400));
      const kind = i % 4;
      if (kind === 0) await chatSse(gw, ac.signal); else if (kind === 1) await s2s(gw, ac.signal);
      else if (kind === 2) await tts(gw, ac.signal); else await stt(gw, wav(1, i), ac.signal);
    };
    for (let i = 0; i < 50; i++) await cycle(i);
    await sleep(1500);
    fake.reset();
    slowFaults();
    if (typeof Bun !== 'undefined') Bun.gc?.(true);
    const warm = await procStats(gw);
    const t0 = now();
    for (let batch = 0; batch < 50; batch++) {
      await Promise.all(Array.from({ length: 10 }, (_, k) => cycle(batch * 10 + k)));
    }
    await sleep(3000);
    const after = await procStats(gw);
    const log = fake.log();
    const open = log.filter(x => x.endedAt === null && !x.aborted).length;
    record('S4', '500 mid-stream disconnects (chat SSE, s2s, TTS, STT): no connection or upstream left open', after.active <= 1 && open === 0 ? 'PASS' : 'FAIL',
      `wall=${Math.round((now() - t0) / 1000)}s; gateway active connections after=${after.active}; upstream calls=${log.length}, aborted by the gateway=${log.filter(x => x.aborted).length}, finished=${log.filter(x => x.endedAt !== null).length}, still open=${open}`);
    // A second round of 500: a leak keeps growing, a warm-up / GC lag does not.
    for (let batch = 50; batch < 100; batch++) await Promise.all(Array.from({ length: 10 }, (_, k) => cycle(batch * 10 + k)));
    await sleep(3000);
    const after2 = await procStats(gw);
    record('S4', '2 × 500 disconnects: memory and handles (RSS, fds) do not keep growing', after2.rssMb - after.rssMb < 10 && after2.fds - warm.fds < 20 ? 'PASS' : 'FAIL',
      `after 50 warm-up cycles RSS=${warm.rssMb} MB fds=${warm.fds}; after 500 RSS=${after.rssMb} MB fds=${after.fds}; after 1000 RSS=${after2.rssMb} MB fds=${after2.fds} (2nd round Δ ${after2.rssMb - after.rssMb} MB); active connections=${after2.active}. Heap: not readable from outside the Bun process, RSS is the proxy`);
    // Slots: the full per-user limit (150) is still available.
    fake.reset();
    fake.setFaults({ a: { kind: 'ok', delayMs: 800 } });
    const full = await Promise.all(Array.from({ length: 150 }, () => chatJson(gw)));
    const statuses: Record<number, number> = {};
    for (const o of full) statuses[o.status] = (statuses[o.status] ?? 0) + 1;
    record('S4', 'after the 500 disconnects, 150 concurrent requests (the per-user limit) all pass', full.every(o => o.status === 200) ? 'PASS' : 'FAIL',
      `statuses=${JSON.stringify(statuses)} sample error=${full.find(o => o.status !== 200) ? errMsg(full.find(o => o.status !== 200)!).slice(0, 100) : '-'}`);
  } finally { await gw.stop(); }
}

// ── S5: compressed soak ─────────────────────────────────────────────────────

export async function scenario5(fake: FakeUpstream, record: Record_): Promise<void> {
  const minutes = Number(process.env.SOAK_MINUTES ?? 30);
  const workers = Number(process.env.SOAK_WORKERS ?? 16);
  fake.reset();
  fake.setChaos({ p5xx: 0.05, pTimeout: 0.02, pDrop: 0.01, seed: 42 });
  // GATEWAY_CLOUD_HEDGE_MS=0 reproduces the gateway before the cloud hedge (a hung link ate the whole budget).
  const hedgeEnv = process.env.GATEWAY_CLOUD_HEDGE_MS !== undefined ? { GATEWAY_CLOUD_HEDGE_MS: process.env.GATEWAY_CLOUD_HEDGE_MS } : {};
  const gw = await startGateway(fake.url, hedgeEnv);
  const end = Date.now() + minutes * 60_000;
  const samples: Array<{ t: number; rssMb: number; fds: number; active: number }> = [];
  const outcomes: Record<string, Record<string, number>> = {};
  const lat: Record<string, number[]> = {};
  const linkState = new Map<string, string>();
  let flips = 0;
  let opens = 0;
  const repeatAudio = wav(1, 3);
  const kinds = ['sse', 'sse', 'sse', 'sse', 'sse', 'sse', 'sse', 'json', 'json', 'json', 'stt', 'stt', 'stt', 'stt', 'tts', 'tts', 'tts', 's2s', 's2s', 's2s'];
  let n = 0;
  const one = async () => {
    const kind = kinds[n++ % kinds.length];
    const o = kind === 'sse' ? await chatSse(gw) : kind === 'json' ? await chatJson(gw) : kind === 'stt' ? await stt(gw, n % 2 ? repeatAudio : wav(1, n))
      : kind === 'tts' ? await tts(gw) : await s2s(gw);
    const ok = o.status === 200 && !o.error && (kind === 'sse' ? o.text.includes('[DONE]') : kind === 's2s' ? /"type":"done"/.test(o.text) && !/"type":"error"/.test(o.text) : true);
    const inband = kind === 'sse' ? /"error"/.test(o.text) : kind === 's2s' ? /"type":"error"/.test(o.text) : false;
    const verdict = o.status === 0 ? 'conn_error' : !ok && o.status === 200 ? (inband ? 'inband_error' : 'silent_cut') : String(o.status);
    (outcomes[kind] ??= {})[ok ? 'ok' : verdict] = ((outcomes[kind] ??= {})[ok ? 'ok' : verdict] ?? 0) + 1;
    (lat[kind] ??= []).push(o.ms);
  };
  const health = async () => {
    try {
      const h = await (await fetch(`${gw.url}/health`)).json() as { stages?: Record<string, Record<string, { links: Array<{ target: string; state: string }> }>> };
      for (const [stage, models] of Object.entries(h.stages ?? {})) {
        for (const [model, v] of Object.entries(models ?? {})) {
          for (const l of v.links ?? []) {
            const key = `${stage}/${model}/${l.target}`;
            const prev = linkState.get(key);
            if (prev !== undefined && prev !== l.state) { flips++; if (l.state === 'circuit_open') opens++; }
            linkState.set(key, l.state);
          }
        }
      }
    } catch { /* sampled again */ }
  };
  const t0 = Date.now();
  const sampler = setInterval(() => {
    void procStats(gw).then((s) => {
      const sample = { t: Math.round((Date.now() - t0) / 1000), ...s };
      samples.push(sample);
      const reqs = Object.values(outcomes).reduce((a, o) => a + Object.values(o).reduce((x, y) => x + y, 0), 0);
      console.log(`   soak t=${sample.t}s RSS=${sample.rssMb}MB fds=${sample.fds} active=${sample.active} requests=${reqs} breaker changes=${flips}`);
    });
  }, 30_000);
  const healthTimer = setInterval(() => void health(), 2_000);
  samples.push({ t: 0, ...(await procStats(gw)) });
  try {
    await Promise.all(Array.from({ length: workers }, async () => { while (Date.now() < end) await one(); }));
    await sleep(10_000); // the timeouts in flight end; connections drain
    samples.push({ t: Math.round((Date.now() - t0) / 1000), ...(await procStats(gw)) });
  } finally {
    clearInterval(sampler);
    clearInterval(healthTimer);
    fake.setChaos(null);
  }
  const pct = (xs: number[], p: number) => Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? -1);
  const total = Object.values(outcomes).reduce((s, o) => s + Object.values(o).reduce((a, b) => a + b, 0), 0);
  const okAll = Object.values(outcomes).reduce((s, o) => s + (o.ok ?? 0), 0);
  // Trend: RSS over the second half against the first sample of that half (warm-up excluded).
  const half = samples.filter(s => s.t >= (minutes * 60) / 2);
  const rssSlope = half.length >= 2 ? (half[half.length - 1].rssMb - half[0].rssMb) / Math.max(1, (half[half.length - 1].t - half[0].t) / 600) : 0;
  const final = samples[samples.length - 1];
  const upstreamOpen = fake.log().filter(x => x.endedAt === null && !x.aborted && x.fault !== 'no-answer').length;
  record('S5', `soak ${minutes} min × ${workers} workers, faults 5 % 5xx / 2 % timeout / 1 % drop: memory flat, connections drained`,
    rssSlope < 10 && final.active <= 1 && upstreamOpen === 0 ? 'PASS' : 'FAIL',
    `${total} requests, ${(100 * okAll / Math.max(1, total)).toFixed(2)} % ok; RSS ${samples[0].rssMb}→${final.rssMb} MB (2nd-half slope ${rssSlope.toFixed(1)} MB/10 min); fds ${samples[0].fds}→${final.fds}; active connections at the end=${final.active}; upstream left open=${upstreamOpen}`);
  const n503 = Object.values(outcomes).reduce((a, o) => a + (o['503'] ?? 0), 0);
  record('S5', `soak: 503 rate (GATEWAY_CLOUD_HEDGE_MS=${process.env.GATEWAY_CLOUD_HEDGE_MS ?? 'default'})`, 'INFO',
    `${n503} of ${total} = ${(100 * n503 / Math.max(1, total)).toFixed(2)} %`);
  record('S5', 'soak: per-kind outcomes and latency', 'INFO',
    Object.keys(outcomes).map(k => `${k}: ${JSON.stringify(outcomes[k])} p50=${pct(lat[k], 0.5)} p95=${pct(lat[k], 0.95)} p99=${pct(lat[k], 0.99)}ms`).join(' | '));
  record('S5', 'soak: breaker flapping (health sampled every 2 s)', 'INFO', `${flips} state changes, ${opens} openings over ${linkState.size} links; final: ${[...linkState].filter(([, s]) => s !== 'ready').map(([k, s]) => `${k}=${s}`).join(', ') || 'all ready'}`);
  record('S5', 'soak: samples (t s: RSS MB / fds / active)', 'INFO', samples.map(s => `${s.t}:${s.rssMb}/${s.fds}/${s.active}`).join(' '));
  const lost = Object.entries(outcomes).map(([k, o]) => [k, o.silent_cut ?? 0] as const).filter(([, v]) => v > 0);
  record('S5', 'soak: no 200 that hides a broken answer (cut without [DONE]/done AND without an error event)', lost.length ? 'FAIL' : 'PASS',
    lost.length ? `silent cuts: ${lost.map(([k, v]) => `${k}=${v}`).join(', ')}` : 'none (cuts after the first byte all carried an in-band error)');
  await gw.stop();
}
