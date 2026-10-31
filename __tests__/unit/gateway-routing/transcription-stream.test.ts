/**
 * `GET /v1/audio/transcriptions/stream` against a fake speech-stack replica (`/ws/audio-stream`, segments protocol):
 * relay both ways with the alias / provider in `ready`, the vocabulary prompt sent as the first config frame, every
 * refusal BEFORE the handshake (so the app falls back to batch), metering while it streams, and the close codes.
 */
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { DeploymentError, type Lease } from '../../../src/deployments/controller-state';
import {
  clientControl, createTranscriptionStream, STT_STREAM_PATH, type StreamDenial, type StreamSummary, type TranscriptionStreamDeps,
} from '../../../src/gateway/proxy/routes/transcription-stream';

const TOKEN = 'replica-token-for-tests';
type Mode = 'ready' | 'warming' | 'legacy' | 'refuse';

interface FakeReplica {
  host: string;
  mode: Mode;
  finalText: string;
  urls: string[];
  texts: string[];
  audioBytes: number;
  sockets: WebSocket[];
  close(): Promise<void>;
}

async function startReplica(): Promise<FakeReplica> {
  const replica = { mode: 'ready' as Mode, finalText: 'Bom dia a todos.', urls: [] as string[], texts: [] as string[], audioBytes: 0, sockets: [] as WebSocket[] } as FakeReplica;
  const server: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (req.headers['x-aigw-token'] !== TOKEN || replica.mode === 'refuse') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    replica.urls.push(req.url ?? '');
    wss.handleUpgrade(req, socket, head, (ws) => {
      replica.sockets.push(ws);
      if (replica.mode === 'warming') { ws.close(1013, 'stt loading, llm waiting, tts warming'); return; }
      if (replica.mode === 'legacy') return;
      const language = new URL(req.url ?? '/', 'http://r').searchParams.get('language');
      ws.send(JSON.stringify({ type: 'ready', model: 'large-v3', language, prompt_chars: 0 }));
      let utterance = 0;
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          replica.audioBytes += (data as Buffer).length;
          ws.send(JSON.stringify({ type: 'partial', utterance, text: 'bom dia', stable: 'bom', end_ms: 1000 }));
          return;
        }
        const text = data.toString();
        replica.texts.push(text);
        const msg = JSON.parse(text) as { type: string; prompt?: string | null; language?: string };
        if (msg.type === 'config') ws.send(JSON.stringify({ type: 'config', language: msg.language ?? language, prompt_chars: (msg.prompt ?? '').length }));
        if (msg.type === 'flush') ws.send(JSON.stringify({ type: 'final', utterance: utterance++, text: replica.finalText, reason: 'flush', avg_logprob: -0.2, speech_ms: 0 }));
      });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  replica.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  replica.close = () => new Promise<void>((r) => { for (const ws of replica.sockets) ws.terminate(); wss.close(); server.close(() => r()); });
  return replica;
}

interface Harness {
  url: string;
  leases: Array<boolean | string>;
  acquires: Array<{ name: string; opts: Record<string, unknown> }>;
  summaries: StreamSummary[];
  metered: number[];
  meterEnds: number;
  gone: AbortController;
  cold: Set<string>;
  quotaAfterSeconds: number | null;
  close(): Promise<void>;
}

async function startGateway(replica: FakeReplica, over: Partial<TranscriptionStreamDeps> = {}): Promise<Harness> {
  const h = { leases: [], acquires: [], summaries: [], metered: [], meterEnds: 0, gone: new AbortController(), cold: new Set<string>(), quotaAfterSeconds: null } as unknown as Harness;
  const keys: Record<string, string> = { 'key-app': 'babelcast', 'key-admin': 'admin', 'key-other': 'parle' };
  const route = createTranscriptionStream({
    controller: {
      acquire: async (name: string, opts: Record<string, unknown> = {}) => {
        h.acquires.push({ name, opts });
        if (h.cold.has(name) || name === 'babelcast-speech') throw new DeploymentError(503, `deployment '${name}': replicas are starting`, 30);
        return {
          machine: { id: 'r1', ip: replica.host }, token: TOKEN, exposed: false, signal: h.gone.signal,
          done: (outcome?: boolean | string) => { h.leases.push(outcome ?? false); },
        } as unknown as Lease;
      },
    } as never,
    deploymentsOf: (model) => ({ 'babelcast-stt': ['babelcast-gpu', 'babelcast-speech'], 'babelcast-stt-scribe': [] } as Record<string, string[]>)[model] ?? [],
    userOf: (req) => keys[String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')] ?? null,
    isAdmin: (userId) => userId === 'admin',
    admit: (userId, model) => (userId === 'babelcast' && model.startsWith('babelcast-')) || userId === 'admin' ? null
      : { status: 403, type: 'permission_error', message: `model '${model}' is not an alias of app '${userId}' — an app key may only call its own stt aliases` },
    meter: (req) => (String(req.headers.authorization).includes('key-app') ? {
      add: (seconds: number): StreamDenial | null => {
        h.metered.push(seconds);
        const total = h.metered.reduce((a, b) => a + b, 0);
        return h.quotaAfterSeconds !== null && total >= h.quotaAfterSeconds
          ? { status: 402, type: 'quota_exceeded', code: 'quota_exceeded', message: 'Sua cota mensal de transcrição acabou (60 min).' } : null;
      },
      end: () => { h.meterEnds++; },
    } : null),
    readyTimeoutMs: 400,
    onEnd: (s) => h.summaries.push(s),
    ...over,
  });
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    void route.handleUpgrade(req, socket, head).then((handled) => { if (!handled) socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  h.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h.close = () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return h;
}

interface Client { ws: WebSocket; messages: Array<Record<string, unknown>>; closed: Promise<{ code: number; reason: string }> }

function connect(url: string, key = 'key-app'): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    const messages: Array<Record<string, unknown>> = [];
    const closed = new Promise<{ code: number; reason: string }>(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => reject(Object.assign(new Error(`refused ${res.statusCode}`), {
        status: res.statusCode, retryAfter: res.headers['retry-after'], body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as { error: Record<string, unknown> },
      })));
    });
    ws.on('error', () => { /* reported through unexpected-response / close */ });
  });
}

async function refused(url: string, key = 'key-app'): Promise<{ status: number; retryAfter?: string; body: { error: Record<string, unknown> } }> {
  try {
    const c = await connect(url, key);
    c.ws.close();
  } catch (err) {
    return err as never;
  }
  throw new Error('the upgrade should have been refused');
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); }
};

const pcm = (seconds: number) => Buffer.alloc(Math.round(seconds * 32_000));
/** Audio as the app sends it: frames of at most one second. */
const sendAudio = (ws: WebSocket, seconds: number) => {
  for (let left = seconds; left > 0; left -= 1) ws.send(pcm(Math.min(1, left)));
};

describe('streaming STT route', () => {
  let replica: FakeReplica;
  let gw: Harness;
  beforeEach(async () => { replica = await startReplica(); gw = await startGateway(replica); });
  afterEach(async () => { await gw.close(); await replica.close(); });

  it('refuses an audio frame over 256 KiB with 1009', async () => {
    const c = await connect(`${gw.url}${STT_STREAM_PATH}?model=babelcast-stt`);
    c.ws.send(pcm(9));
    expect(await c.closed).toEqual({ code: 1009, reason: 'frame_too_large' });
  });

  it('relays audio and events with the alias, sends the vocabulary prompt first, and meters the stream', async () => {
    const prompt = 'Kubernetes, Grafana, Ksawery Wiśniewski';
    const c = await connect(`${gw.url}${STT_STREAM_PATH}?model=babelcast-stt&language=pt&chunk_size=0.5&prompt=${encodeURIComponent(prompt)}`);
    await until(() => c.messages.length >= 1);
    expect(c.messages[0]).toEqual({ type: 'ready', model: 'babelcast-stt', provider: 'deployment:babelcast-gpu', engine: 'large-v3', language: 'pt', prompt_chars: prompt.length });
    expect(gw.acquires[0]).toMatchObject({ name: 'babelcast-gpu', opts: { waitMs: 0, stage: 'stt' } });
    const upstreamUrl = new URL(replica.urls[0]!, 'http://r');
    expect(upstreamUrl.pathname).toBe('/ws/audio-stream');
    expect(Object.fromEntries(upstreamUrl.searchParams)).toEqual({ segments: '1', language: 'pt', chunk_size: '0.5' });
    await until(() => replica.texts.length >= 1);
    expect(JSON.parse(replica.texts[0]!)).toEqual({ type: 'config', prompt });

    sendAudio(c.ws, 16);
    await until(() => c.messages.some(m => m.type === 'partial'));
    expect(c.messages.find(m => m.type === 'partial')).toMatchObject({ text: 'bom dia', stable: 'bom' });
    expect(c.messages.some(m => m.type === 'config'), 'the ack of the gateway\'s own config is not forwarded').toBe(false);
    await until(() => gw.metered.length === 1);
    expect(gw.metered).toEqual([15]);

    c.ws.send(JSON.stringify({ type: 'config', prompt: 'Kestrel, Sirocco', language: 'fr' }));
    await until(() => c.messages.some(m => m.type === 'config'));
    expect(c.messages.find(m => m.type === 'config')).toEqual({ type: 'config', language: 'fr', prompt_chars: 16 });
    c.ws.send(JSON.stringify({ type: 'tell me a joke' }));
    c.ws.send(JSON.stringify({ type: 'ping' }));
    c.ws.send(JSON.stringify({ type: 'flush' }));
    await until(() => c.messages.some(m => m.type === 'final') && c.messages.some(m => m.type === 'pong'));
    expect(c.messages.find(m => m.type === 'error')).toMatchObject({ code: 'bad_frame' });
    expect(c.messages.find(m => m.type === 'final')).toMatchObject({ text: 'Bom dia a todos.', reason: 'flush' });
    expect(replica.texts.map(t => JSON.parse(t).type)).toEqual(['config', 'config', 'flush']);

    sendAudio(c.ws, 2);
    await until(() => replica.audioBytes === pcm(18).length);
    c.ws.close(1000);
    expect((await c.closed).code).toBe(1000);
    await until(() => gw.summaries.length === 1);
    expect(gw.leases).toEqual([false]);
    expect(gw.metered.reduce((a, b) => a + b, 0)).toBe(18);
    expect(gw.meterEnds).toBe(1);
    expect(gw.summaries[0]).toMatchObject({ userId: 'babelcast', model: 'babelcast-stt', deployment: 'babelcast-gpu', audioSeconds: 18, finals: 1, from: 'client' });
  });

  it('refuses before the handshake with the batch route\'s answers, so the app falls back to batch', async () => {
    const path = `${gw.url}${STT_STREAM_PATH}`;
    expect((await refused(`${path}?model=babelcast-stt`, 'nope')).status).toBe(401);
    expect((await refused(`${path}?language=pt`)).body.error).toMatchObject({ code: 'missing_model' });
    expect((await refused(`${path}?model=babelcast-stt&language=p!`)).status).toBe(400);
    expect((await refused(`${path}?model=babelcast-stt&prompt=${'x'.repeat(2001)}`)).body.error).toMatchObject({ code: 'prompt_too_long' });
    const alias = await refused(`${path}?model=whisper-large-v3-turbo`);
    expect(alias.status).toBe(403);
    expect(alias.body.error.message).toMatch(/may only call its own stt aliases/);
    expect((await refused(`${path}?model=deployment:babelcast-gpu`)).status).toBe(403);
    const none = await refused(`${path}?model=babelcast-stt-scribe`);
    expect(none.status).toBe(404);
    expect(none.body.error).toMatchObject({ code: 'no_streaming_backend' });
    expect(gw.acquires).toHaveLength(0);

    gw.cold.add('babelcast-gpu');
    const cold = await refused(`${path}?model=babelcast-stt`);
    expect(cold.status).toBe(503);
    expect(cold.retryAfter).toBe('30');
    expect(cold.body.error).toMatchObject({ code: 'gpu_not_ready', type: 'provider_unavailable' });
    expect(gw.acquires.map(a => a.name)).toEqual(['babelcast-gpu', 'babelcast-speech']);
    gw.cold.clear();

    replica.mode = 'warming';
    const warming = await refused(`${path}?model=babelcast-stt`);
    expect(warming.status).toBe(503);
    expect(warming.body.error.message).toMatch(/still loading Whisper/);
    replica.mode = 'legacy';
    expect((await refused(`${path}?model=babelcast-stt`)).body.error).toMatchObject({ code: 'stream_unsupported' });
    replica.mode = 'refuse';
    expect((await refused(`${path}?model=babelcast-stt`)).status).toBe(502);
    expect(gw.leases).toEqual([false, false, true]);
    expect(gw.summaries).toHaveLength(0);

    replica.mode = 'ready';
    const admin = await connect(`${path}?model=deployment:babelcast-gpu`, 'key-admin');
    await until(() => admin.messages.length >= 1);
    expect(admin.messages[0]).toMatchObject({ type: 'ready', provider: 'deployment:babelcast-gpu' });
    admin.ws.close();
  });

  it('the batch route hallucination filter empties an invented final (codes, no text); filter_hallucinations=false keeps it', async () => {
    replica.finalText = 'Legendas pela comunidade Amara.org';
    const c = await connect(`${gw.url}${STT_STREAM_PATH}?model=babelcast-stt&language=pt`);
    c.ws.send(JSON.stringify({ type: 'flush' }));
    await until(() => c.messages.some(m => m.type === 'final'));
    const final = c.messages.find(m => m.type === 'final')!;
    expect(final.text).toBe('');
    expect(Array.isArray(final.filtered) && (final.filtered as string[]).length).toBeTruthy();
    c.ws.close();
    const raw = await connect(`${gw.url}${STT_STREAM_PATH}?model=babelcast-stt&language=pt&filter_hallucinations=false`);
    raw.ws.send(JSON.stringify({ type: 'flush' }));
    await until(() => raw.messages.some(m => m.type === 'final'));
    expect(raw.messages.find(m => m.type === 'final')).toMatchObject({ text: 'Legendas pela comunidade Amara.org' });
    expect(raw.messages.find(m => m.type === 'final')).not.toHaveProperty('filtered');
    raw.ws.close();
  });

  it('two streams per key at most', async () => {
    const path = `${gw.url}${STT_STREAM_PATH}?model=babelcast-stt`;
    const a = await connect(path);
    const b = await connect(path);
    const third = await refused(path);
    expect(third.status).toBe(429);
    expect(third.body.error).toMatchObject({ code: 'too_many_streams' });
    a.ws.close();
    await until(() => gw.summaries.length === 1);
    const c = await connect(path);
    b.ws.close();
    c.ws.close();
  });

  it('a replica lost mid-stream ends it with gpu_lost / 1013; a released replica too', async () => {
    const c = await connect(`${gw.url}${STT_STREAM_PATH}?model=babelcast-stt`);
    await until(() => replica.sockets.length === 1);
    replica.sockets[0]!.close(1011, 'boom');
    const closed = await c.closed;
    expect(closed).toEqual({ code: 1013, reason: 'gpu_lost' });
    expect(c.messages.at(-1)).toMatchObject({ type: 'error', code: 'gpu_lost' });
    await until(() => gw.leases.length === 1);
    expect(gw.leases).toEqual([true]);

    const d = await connect(`${gw.url}${STT_STREAM_PATH}?model=babelcast-stt`);
    gw.gone.abort();
    expect((await d.closed).code).toBe(1013);
  });

  it('a monthly quota crossed mid-stream ends it with 1008 quota_exceeded', async () => {
    gw.quotaAfterSeconds = 30;
    const c = await connect(`${gw.url}${STT_STREAM_PATH}?model=babelcast-stt`);
    sendAudio(c.ws, 32);
    const closed = await c.closed;
    expect(closed).toEqual({ code: 1008, reason: 'quota_exceeded' });
    expect(c.messages.at(-1)).toMatchObject({ type: 'error', code: 'quota_exceeded' });
    expect(gw.meterEnds).toBe(1);
  });

  it('an account already over its quota is refused before the handshake', async () => {
    await gw.close();
    gw = await startGateway(replica, { meter: () => ({ denial: { status: 402, type: 'quota_exceeded', code: 'quota_exceeded', message: 'Sua cota mensal de transcrição acabou.' } }) });
    const r = await refused(`${gw.url}${STT_STREAM_PATH}?model=babelcast-stt`);
    expect(r.status).toBe(402);
    expect(r.body.error).toMatchObject({ code: 'quota_exceeded', type: 'quota_exceeded' });
  });

  it('an idle stream is closed with 1000 idle; the app budget is charged per started minute', async () => {
    await gw.close();
    const charged: number[] = [];
    gw = await startGateway(replica, { idleMs: 1_000, charge: (_u, n) => { charged.push(n); return null; } });
    const c = await connect(`${gw.url}${STT_STREAM_PATH}?model=babelcast-stt`);
    sendAudio(c.ws, 61);
    await until(() => charged.length === 1);
    expect(charged).toEqual([1]);
    const closed = await c.closed;
    expect(closed).toEqual({ code: 1000, reason: 'idle' });
  });
});

describe('client control frames', () => {
  it('accepts flush, ping and config (prompt string or null, language code); refuses the rest', () => {
    expect(clientControl('{"type":"flush"}')).toEqual({ type: 'flush' });
    expect(clientControl('{"type":"ping"}')).toEqual({ type: 'ping' });
    expect(clientControl('{"type":"config","prompt":"Grafana","language":"pt-BR","extra":1}')).toEqual({ type: 'config', prompt: 'Grafana', language: 'pt-BR' });
    expect(clientControl('{"type":"config","prompt":null}')).toEqual({ type: 'config', prompt: null });
    expect(clientControl('{"type":"config","prompt":5}')).toHaveProperty('error');
    expect(clientControl(JSON.stringify({ type: 'config', prompt: 'x'.repeat(4001) }))).toHaveProperty('error');
    expect(clientControl('{"type":"config","language":"português"}')).toHaveProperty('error');
    expect(clientControl('[1]')).toHaveProperty('error');
    expect(clientControl('nope')).toHaveProperty('error');
    expect(clientControl('{"type":"exec"}')).toHaveProperty('error');
  });
});
