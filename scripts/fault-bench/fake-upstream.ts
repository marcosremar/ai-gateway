/**
 * Fake upstream for the fault bench: speaks the OpenAI shapes OpenRouter and Groq use, and misbehaves on demand.
 *
 *   POST /<tag>/chat/completions          JSON or SSE (`stream: true`)
 *   POST /<tag>/audio/transcriptions      multipart (OpenAI shape)
 *   POST /<tag>/audio/speech              audio bytes, streamed in chunks
 *   GET  /<tag>/key | /<tag>/models       health probes (200)
 *
 * `<tag>` names the fake provider (e.g. `or` for OpenRouter, `groq`), so one server plays every provider of a chain.
 *
 * Control API (never reached by the gateway):
 *   PUT  /__control/faults   {"<model>": Fault | Fault[]}   — a list is consumed one per request, the last one sticks
 *   POST /__control/reset    clears faults and the request log
 *   GET  /__control/log      every request received: model, body sha256, bytes, timings, aborted (client went away)
 *
 * The fault is chosen by the UPSTREAM model of the request (the gateway does not forward client headers), so a chain
 * `openrouter:a → openrouter:b → groq:c` gets one behaviour per link. Runs on Node and Bun (node:http).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export type Fault =
  | { kind: 'ok'; text?: string; chunks?: string[]; delayMs?: number; chunkGapMs?: number; finishReason?: string }
  | { kind: 'status'; status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number; readBody?: 'all' | 'half' }
  /** SSE: `deltas` chunks, then an in-band error with HTTP 200 (OpenRouter shape, or Anthropic `event: error`). */
  | { kind: 'sse-error'; deltas: number; style: 'openrouter' | 'anthropic' }
  /** SSE: comment keep-alives every `everyMs` for `forMs`, then a normal answer. */
  | { kind: 'sse-keepalive'; forMs: number; everyMs?: number; text?: string }
  /** SSE: multibyte chars split across TCP writes and a `data:` line split mid-JSON. */
  | { kind: 'sse-split' }
  /** Streams `deltas` chunks then goes silent for `silentMs`, then finishes normally. */
  | { kind: 'stall-mid'; deltas: number; silentMs: number }
  /** Streams `deltas` chunks then destroys the socket (no `[DONE]`, no finish_reason). */
  | { kind: 'close-mid'; deltas: number }
  /** Streams `deltas` chunks then ends the response cleanly, but with no finish_reason and no `[DONE]`. */
  | { kind: 'end-mid'; deltas: number }
  /** Accepts the request and never answers. */
  | { kind: 'no-answer' }
  /** Sends the response headers, then never a byte of body. */
  | { kind: 'headers-stall' }
  /** Empty answer of a reasoning model. */
  | { kind: 'empty'; shape: 'content' | 'choices' }
  /** Abrupt TCP reset before any response. */
  | { kind: 'reset' };

export interface LoggedRequest {
  id: number;
  tag: string;
  path: string;
  model: string | null;
  stream: boolean;
  bodyBytes: number;
  bodySha256: string;
  /** sha256 of the multipart file part (STT), to compare what two providers received. */
  fileSha256: string | null;
  fileName: string | null;
  fileType: string | null;
  language: string | null;
  auth: string | null;
  fault: string;
  startedAt: number;
  /** When the body was fully received (null if never). */
  bodyAt: number | null;
  endedAt: number | null;
  /** The client (the gateway) closed the connection before the response finished. */
  aborted: boolean;
  abortedAt: number | null;
}

export interface Chaos { p5xx: number; pTimeout: number; pDrop: number; seed?: number }

export interface FakeUpstream {
  url: string;
  port: number;
  server: Server;
  setFaults(faults: Record<string, Fault | Fault[]>): void;
  /** Random faults for every request without an explicit one (soak): probabilities per request. `null` turns it off. */
  setChaos(chaos: Chaos | null): void;
  reset(): void;
  log(): LoggedRequest[];
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function chunk(model: string, content: string | null, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'gen-fake', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
  })}\n\n`;
}

/** Minimal multipart reader (fields + first file part). */
function parseMultipart(body: Buffer, contentType: string) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const out: { fields: Record<string, string>; file: Buffer | null; fileName: string | null; fileType: string | null } = {
    fields: {}, file: null, fileName: null, fileType: null,
  };
  if (!m) return out;
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  let at = body.indexOf(boundary);
  while (at >= 0) {
    const next = body.indexOf(boundary, at + boundary.length);
    if (next < 0) break;
    const part = body.subarray(at + boundary.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd >= 0) {
      const head = part.subarray(0, headEnd).toString();
      const data = part.subarray(headEnd + 4);
      const name = /name="([^"]*)"/.exec(head)?.[1];
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      if (filename !== undefined) {
        out.file = Buffer.from(data);
        out.fileName = filename;
        out.fileType = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null;
      } else if (name) {
        out.fields[name] = data.toString();
      }
    }
    at = next;
  }
  return out;
}

export async function startFakeUpstream(port = 0): Promise<FakeUpstream> {
  const faults = new Map<string, Fault[]>();
  const requests: LoggedRequest[] = [];
  let nextId = 1;

  let chaos: Chaos | null = null;
  let rng = 1;
  const random = () => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng / 2147483648; };
  const chaosFault = (): Fault | null => {
    if (!chaos) return null;
    const x = random();
    if (x < chaos.p5xx) return { kind: 'status', status: 502 + Math.floor(random() * 2) };
    if (x < chaos.p5xx + chaos.pTimeout) return { kind: 'no-answer' };
    if (x < chaos.p5xx + chaos.pTimeout + chaos.pDrop) return { kind: 'close-mid', deltas: 2 };
    return null;
  };
  const faultFor = (model: string | null): Fault | null => {
    const list = model ? faults.get(model) : undefined;
    if (!list || list.length === 0) return chaosFault();
    return list.length > 1 ? list.shift()! : list[0];
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname.startsWith('/__control/')) return control(req, res, url.pathname);
    const [, tag = '', ...rest] = url.pathname.split('/');
    const path = `/${rest.join('/')}`;
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }

    const entry: LoggedRequest = {
      id: nextId++, tag, path, model: null, stream: false, bodyBytes: 0, bodySha256: '', fileSha256: null, fileName: null,
      fileType: null, language: null, auth: (req.headers.authorization as string | undefined) ?? null, fault: 'ok',
      startedAt: Date.now(), bodyAt: null, endedAt: null, aborted: false, abortedAt: null,
    };
    requests.push(entry);
    res.on('close', () => {
      if (!res.writableFinished) { entry.aborted = true; entry.abortedAt = Date.now(); }
    });
    res.on('finish', () => { entry.endedAt = Date.now(); });

    // The model decides the fault, so it is read first. A "read half then fail" fault needs the model before the body
    // is complete: for multipart, the model field comes after the file (OpenAI SDK order), so STT faults are keyed by
    // the request's tag+path when set with the model `<tag>:stt`.
    const isJson = String(req.headers['content-type'] ?? '').includes('application/json');
    let pre: Fault | null = null;
    if (!isJson) {
      pre = faultFor(`${tag}:${path.split('/').pop()}`);
      if (pre?.kind === 'status' && pre.readBody === 'half') {
        const total = Number(req.headers['content-length'] ?? 0);
        let got = 0;
        entry.fault = 'status-after-half';
        await new Promise<void>((resolve) => {
          req.on('data', (c: Buffer) => {
            got += c.length;
            if (total > 0 && got >= total / 2) { req.pause(); resolve(); }
          });
          req.on('end', () => resolve());
        });
        entry.bodyBytes = got;
        res.writeHead(pre.status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(pre.body ?? { error: { message: 'upstream broke mid-upload', code: pre.status } }));
        req.destroy();
        return;
      }
    }
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = Buffer.concat(parts);
    entry.bodyAt = Date.now();
    entry.bodyBytes = body.length;
    entry.bodySha256 = sha(body);

    let model: string | null = null;
    let stream = false;
    if (isJson) {
      try {
        const json = JSON.parse(body.toString()) as { model?: string; stream?: boolean };
        model = json.model ?? null;
        stream = json.stream === true;
      } catch { /* bad json */ }
    } else {
      const mp = parseMultipart(body, String(req.headers['content-type'] ?? ''));
      model = mp.fields.model ?? null;
      entry.language = mp.fields.language ?? null;
      if (mp.file) { entry.fileSha256 = sha(mp.file); entry.fileName = mp.fileName; entry.fileType = mp.fileType; }
    }
    entry.model = model;
    entry.stream = stream;
    const fault = pre ?? faultFor(model) ?? { kind: 'ok' };
    entry.fault = fault.kind;
    await respond(fault, path, model ?? 'fake', stream, res, req);
  };

  const respond = async (fault: Fault, path: string, model: string, stream: boolean, res: ServerResponse, req: IncomingMessage) => {
    const gone = () => res.destroyed || res.writableEnded;
    switch (fault.kind) {
      case 'reset':
        if (req.socket.resetAndDestroy) req.socket.resetAndDestroy(); else req.socket.destroy();
        return;
      case 'no-answer':
        return; // never answers; the connection stays open until the client gives up
      case 'headers-stall':
        res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
        res.flushHeaders();
        return;
      case 'status': {
        if (fault.delayMs) await sleep(fault.delayMs);
        res.writeHead(fault.status, { 'content-type': 'application/json', ...fault.headers });
        res.end(JSON.stringify(fault.body ?? { error: { message: `fake ${fault.status}`, code: fault.status } }));
        return;
      }
      default:
        break;
    }

    if (path.endsWith('/audio/transcriptions')) {
      const text = fault.kind === 'ok' ? (fault.text ?? 'olá mundo') : fault.kind === 'empty' ? '' : 'olá';
      if (fault.kind === 'ok' && fault.delayMs) await sleep(fault.delayMs);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text, language: 'portuguese', duration: 1, segments: [] }));
      return;
    }

    if (path.endsWith('/audio/speech')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      const piece = Buffer.alloc(4000, 7);
      const n = fault.kind === 'stall-mid' || fault.kind === 'close-mid' ? fault.deltas : 10;
      for (let i = 0; i < n && !gone(); i++) { res.write(piece); await sleep(fault.kind === 'ok' ? (fault.chunkGapMs ?? 20) : 20); }
      if (fault.kind === 'close-mid') { req.socket.destroy(); return; }
      if (fault.kind === 'stall-mid') { await sleep(fault.silentMs); for (let i = 0; i < 3 && !gone(); i++) res.write(piece); }
      if (!gone()) res.end();
      return;
    }

    // chat
    const okChunks = fault.kind === 'ok' ? (fault.chunks ?? (fault.text ?? 'Olá, tudo bem com você?').split(/(?<= )/)) : ['Olá, ', 'tudo ', 'bem ', 'com ', 'você?'];
    if (fault.kind === 'ok' && fault.delayMs) await sleep(fault.delayMs);
    if (!stream) {
      if (fault.kind === 'empty') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fault.shape === 'choices'
          ? { id: 'gen', object: 'chat.completion', model, choices: [] }
          : { id: 'gen', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }));
        return;
      }
      const full = JSON.stringify({
        id: 'gen', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: okChunks.join('') }, finish_reason: fault.kind === 'ok' ? (fault.finishReason ?? 'stop') : 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (fault.kind === 'stall-mid') { res.write(full.slice(0, 20)); await sleep(fault.silentMs); if (gone()) return; res.end(full.slice(20)); return; }
      if (fault.kind === 'close-mid') { res.write(full.slice(0, 20)); req.socket.destroy(); return; }
      res.end(full);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const send = async (s: string | Buffer, gapMs = 15) => { if (gone()) return; res.write(s); await sleep(gapMs); };
    switch (fault.kind) {
      case 'ok':
        for (const c of okChunks) await send(chunk(model, c), fault.chunkGapMs ?? 15);
        await send(chunk(model, null, fault.finishReason ?? 'stop'));
        break;
      case 'empty':
        if (fault.shape === 'content') { await send(chunk(model, '')); await send(chunk(model, null, 'length')); }
        else await send(`data: ${JSON.stringify({ id: 'gen', object: 'chat.completion.chunk', model, choices: [] })}\n\n`);
        break;
      case 'sse-error':
        for (let i = 0; i < fault.deltas; i++) await send(chunk(model, okChunks[i % okChunks.length]));
        if (fault.style === 'openrouter') {
          await send(`data: ${JSON.stringify({
            id: 'gen', object: 'chat.completion.chunk', model, provider: 'fake',
            error: { code: 'server_error', message: 'Provider disconnected unexpectedly' },
            choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
          })}\n\n`);
        } else {
          await send(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`);
        }
        break;
      case 'sse-keepalive': {
        const until = Date.now() + fault.forMs;
        while (Date.now() < until && !gone()) await send(': OPENROUTER PROCESSING\n\n', fault.everyMs ?? 1000);
        for (const c of (fault.text ?? 'Olá depois da espera').split(/(?<= )/)) await send(chunk(model, c));
        await send(chunk(model, null, 'stop'));
        break;
      }
      case 'sse-split': {
        // "Não, não é assim" with every multibyte char split across writes, and one data line cut mid-JSON.
        const full = chunk(model, 'Não, ') + chunk(model, 'não é ') + chunk(model, 'assim — ção') + chunk(model, null, 'stop');
        const bytes = Buffer.from(full);
        const cuts: number[] = [];
        for (let i = 1; i < bytes.length; i++) if ((bytes[i] & 0xc0) === 0x80) cuts.push(i); // inside a multibyte char
        cuts.push(Math.floor(bytes.indexOf('"delta"') + 3)); // mid-JSON
        const sorted = [...new Set(cuts)].sort((a, b) => a - b);
        let from = 0;
        for (const at of sorted) { await send(bytes.subarray(from, at), 5); from = at; }
        await send(bytes.subarray(from), 5);
        break;
      }
      case 'stall-mid':
        for (let i = 0; i < fault.deltas; i++) await send(chunk(model, okChunks[i % okChunks.length]));
        await sleep(fault.silentMs);
        await send(chunk(model, 'fim.'));
        await send(chunk(model, null, 'stop'));
        break;
      case 'close-mid':
        for (let i = 0; i < fault.deltas; i++) await send(chunk(model, okChunks[i % okChunks.length]));
        req.socket.destroy();
        return;
      case 'end-mid':
        for (let i = 0; i < fault.deltas; i++) await send(chunk(model, okChunks[i % okChunks.length]));
        if (!gone()) res.end();
        return;
      default:
        break;
    }
    if (!gone()) { res.write('data: [DONE]\n\n'); res.end(); }
  };

  const control = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    if (path === '/__control/faults') {
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}') as Record<string, Fault | Fault[]>;
      for (const [model, f] of Object.entries(body)) faults.set(model, Array.isArray(f) ? [...f] : [f]);
    } else if (path === '/__control/reset') {
      faults.clear();
      requests.length = 0;
    } else if (path === '/__control/log') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(requests));
      return;
    }
    res.writeHead(204);
    res.end();
  };

  const server = createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy(); } catch { /* gone */ } }); });
  server.keepAliveTimeout = 120_000;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    server,
    setFaults: (f) => { for (const [model, x] of Object.entries(f)) faults.set(model, Array.isArray(x) ? [...x] : [x]); },
    reset: () => { faults.clear(); requests.length = 0; },
    setChaos: (c) => { chaos = c; rng = c?.seed ?? 1; },
    log: () => requests.map((r) => ({ ...r })),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (import.meta.main) {
  const fake = await startFakeUpstream(Number(process.env.PORT ?? 0));
  console.log(`fake upstream on ${fake.url}`);
}
