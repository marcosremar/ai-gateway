/**
 * Correlated telemetry of a realtime session (docs/realtime.md § Telemetry), behind a small interface so the shared
 * browser emitter (`sdk/browser/telemetry`, built separately) can replace this local one without touching the session.
 *
 * - One W3C trace per session: `traceparent` = `00-<traceId 32 hex>-<spanId 16 hex>-01`, sent on every gateway call
 *   (session request, signaling, WS as a query parameter — a browser WebSocket cannot set headers —, /v1/s2s, the POST
 *   fallback); the gateway propagates it to the edge and echoes `X-Aigw-Trace-Id`.
 * - Event: `{ts, source:"browser", level, event, traceId, sessionId?, turnId?, durMs?, attrs?}`.
 * - Never audio, transcript, LLM text or tokens: lengths, codes and durations only (`safeAttrs` drops anything else).
 * - Ingest: `POST /v1/telemetry/events` `{events:[…]}`, ≤ 100 per batch, `Authorization: Bearer <session token>`.
 */

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelemetryEvent {
  ts: string;
  source: 'browser';
  level: TelemetryLevel;
  event: string;
  traceId: string;
  sessionId?: string;
  turnId?: string;
  durMs?: number;
  attrs?: Record<string, string | number | boolean | null>;
}

export interface TelemetryFields {
  level?: TelemetryLevel;
  turnId?: string;
  durMs?: number;
  attrs?: Record<string, unknown>;
}

/** What the session needs; the shared emitter implements the same `emit`. */
export interface RealtimeTelemetry {
  readonly traceId: string;
  readonly traceparent: string;
  emit(event: string, fields?: TelemetryFields): void;
  /** The session got its id and token (events from then on carry `sessionId`, and can be sent). */
  bind(sessionId: string, token: string, ingestUrl: string | null): void;
  flush(): Promise<void>;
  close(): void;
}

export const TELEMETRY_MAX_BATCH = 100;
const FLUSH_MS = 5_000;
const MAX_QUEUE = 1_000;
const MAX_STRING = 64;

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  if (a.every(b => b === 0)) a[0] = 1; // all-zero ids are invalid in W3C trace context
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

export function newTraceparent(traceId = randomHex(16)): { traceId: string; traceparent: string } {
  return { traceId, traceparent: `00-${traceId}-${randomHex(8)}-01` };
}

export function newTurnId(): string {
  return `turn_${randomHex(6)}`;
}

/**
 * Attributes reduced to what may leave the browser: numbers, booleans, null, and short strings (codes, transport
 * names). Keys that name content are dropped whatever their value.
 */
const CONTENT_KEY = /(^|_)(text|transcript|reply|content|audio|pcm|sdp|token|prompt|message|messages|system)($|_)/i;
export function safeAttrs(attrs: Record<string, unknown> | undefined): TelemetryEvent['attrs'] | undefined {
  if (!attrs) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (CONTENT_KEY.test(k)) continue;
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length <= MAX_STRING) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface LocalTelemetryOptions {
  fetchImpl?: typeof fetch;
  /** Also hand each event to the page (debug overlay, its own analytics). */
  onEvent?: (event: TelemetryEvent) => void;
  now?: () => Date;
  /** Send batches (default true). Off = events go only to `onEvent`. */
  send?: boolean;
}

/** The local emitter: queue, batches of ≤ 100 every 5 s (and on flush/close, `keepalive`), sent with the session token. */
export function createLocalTelemetry(opts: LocalTelemetryOptions = {}): RealtimeTelemetry {
  const { traceId, traceparent } = newTraceparent();
  const f = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? (() => new Date());
  let sessionId: string | undefined;
  let token: string | null = null;
  let url: string | null = null;
  let queue: TelemetryEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  const send = async (keepalive: boolean) => {
    if (opts.send === false || !token || !url || !queue.length) return;
    while (queue.length) {
      const batch = queue.slice(0, TELEMETRY_MAX_BATCH);
      queue = queue.slice(batch.length);
      try {
        await f(url, {
          method: 'POST', keepalive,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', traceparent },
          body: JSON.stringify({ events: batch }),
        });
      } catch { /* telemetry never breaks the session */ }
    }
  };

  return {
    traceId,
    traceparent,
    emit(event, fields = {}) {
      const e: TelemetryEvent = {
        ts: now().toISOString(), source: 'browser', level: fields.level ?? 'info', event, traceId,
        ...(sessionId ? { sessionId } : {}),
        ...(fields.turnId ? { turnId: fields.turnId } : {}),
        ...(typeof fields.durMs === 'number' && Number.isFinite(fields.durMs) ? { durMs: Math.round(fields.durMs) } : {}),
      };
      const attrs = safeAttrs(fields.attrs);
      if (attrs) e.attrs = attrs;
      try { opts.onEvent?.(e); } catch { /* the page's handler */ }
      if (opts.send === false) return;
      queue.push(e);
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
      if (queue.length >= TELEMETRY_MAX_BATCH) void send(false);
    },
    bind(id, sessionToken, ingestUrl) {
      sessionId = id;
      token = sessionToken;
      url = ingestUrl;
      for (const e of queue) if (!e.sessionId) e.sessionId = id;
      if (!timer && opts.send !== false) {
        timer = setInterval(() => { void send(false); }, FLUSH_MS);
        (timer as { unref?: () => void }).unref?.();
      }
    },
    flush: () => send(false),
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      void send(true);
    },
  };
}
