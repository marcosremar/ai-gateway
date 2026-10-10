// ── AI Gateway — Desktop-app field telemetry: batch contract + validation ──────────────────────────────────────────
// What an opted-in desktop app (ucast.me) uploads (docs/app-telemetry.md):
//
//   POST /v1/telemetry/app/events
//   { "installId": "<random uuid>", "appVersion": "0.9.3", "os": "windows",
//     "events": [ { "ts": 1760090000000, "kind": "utterance", "fields": { "total_ms": 812, "stt_ms": 300, … } } ] }
//
// Privacy: never transcript text. Any key named original / translated[_N] / text / transcript[ion] is DROPPED at any
// depth before the batch is stored; every remaining string must be short (codes, providers, modes) or the batch is
// refused, so free text has no way in.

export const APP_TELEMETRY_KINDS = [
  'session_start', 'session_end', 'utterance', 'crash', 'app_start', 'app_exit', 'gpu_wait', 'stream',
  'direction_changed', 'error',
] as const;
export type AppTelemetryKind = typeof APP_TELEMETRY_KINDS[number];

export const APP_TELEMETRY_LIMITS = {
  maxBatchEvents: 500,
  maxBatchBytes: 256 * 1024,
  /** Longest string value anywhere in `fields`. */
  maxString: 256,
  maxKey: 64,
  maxKeysPerObject: 64,
  maxArrayItems: 64,
  /** Nesting of objects/arrays inside `fields` (fields itself = depth 1). */
  maxDepth: 4,
  /** Serialized size of one event's fields after stripping. */
  maxFieldsBytes: 16 * 1024,
  /** Clock skew tolerated for `ts` in the future. */
  maxFutureMs: 24 * 3_600_000,
} as const;

/** Keys that would carry what the user said or what was shown: removed, never stored. */
export const APP_TELEMETRY_TEXT_KEY = /^(original|translated(_\d+)?|text|transcript|transcription)$/i;

export type FieldValue = string | number | boolean | null | FieldValue[] | { [k: string]: FieldValue };
export type Fields = Record<string, FieldValue>;

export interface AppTelemetryEvent {
  ts: number;
  kind: AppTelemetryKind;
  fields: Fields;
}

export interface AppTelemetryBatch {
  installId: string;
  appVersion: string;
  os: string;
  events: AppTelemetryEvent[];
}

/** One stored row: the event, the batch envelope, and what only the server knows. */
export interface StoredAppEvent extends AppTelemetryEvent {
  rxTs: number;
  installId: string;
  appVersion: string;
  os: string;
  /** Gateway user of the key that uploaded it. */
  app: string;
}

export class AppTelemetryError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z.+_-]{1,32}$/;
const OS = /^[A-Za-z0-9._-]{1,32}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Copies `value` keeping only scalars/arrays/objects within the limits, dropping text keys. Throws on a limit breach
 * (too-long string, too deep, too many keys) — the client strips before sending, so a breach is a bug to surface.
 */
export function sanitizeFields(value: unknown, path = 'fields', depth = 1): FieldValue {
  const L = APP_TELEMETRY_LIMITS;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AppTelemetryError(`${path}: not a finite number`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > L.maxString) throw new AppTelemetryError(`${path}: string longer than ${L.maxString} characters`);
    return value;
  }
  if (depth > L.maxDepth) throw new AppTelemetryError(`${path}: nested deeper than ${L.maxDepth}`);
  if (Array.isArray(value)) {
    if (value.length > L.maxArrayItems) throw new AppTelemetryError(`${path}: more than ${L.maxArrayItems} items`);
    return value.map((v, i) => sanitizeFields(v, `${path}[${i}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > L.maxKeysPerObject) throw new AppTelemetryError(`${path}: more than ${L.maxKeysPerObject} keys`);
    const out: Record<string, FieldValue> = {};
    for (const k of keys) {
      if (APP_TELEMETRY_TEXT_KEY.test(k)) continue;
      if (k.length > L.maxKey) throw new AppTelemetryError(`${path}: key longer than ${L.maxKey} characters`);
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = sanitizeFields(value[k], `${path}.${k}`, depth + 1);
    }
    return out;
  }
  throw new AppTelemetryError(`${path}: unsupported value`);
}

/** Validates a parsed body into a batch (text keys stripped). Throws AppTelemetryError. */
export function parseBatch(body: unknown, now: number): AppTelemetryBatch {
  const L = APP_TELEMETRY_LIMITS;
  if (!isPlainObject(body)) throw new AppTelemetryError('Body must be a JSON object');
  const { installId, appVersion, os, events } = body;
  if (typeof installId !== 'string' || !UUID.test(installId)) throw new AppTelemetryError('installId must be a UUID');
  if (typeof appVersion !== 'string' || !VERSION.test(appVersion)) throw new AppTelemetryError('appVersion is missing or invalid');
  if (typeof os !== 'string' || !OS.test(os)) throw new AppTelemetryError('os is missing or invalid');
  if (!Array.isArray(events) || events.length === 0) throw new AppTelemetryError('events must be a non-empty array');
  if (events.length > L.maxBatchEvents) throw new AppTelemetryError(`At most ${L.maxBatchEvents} events per batch`, 413);
  const out: AppTelemetryEvent[] = events.map((raw, i) => {
    if (!isPlainObject(raw)) throw new AppTelemetryError(`events[${i}] must be an object`);
    const { ts, kind, fields } = raw;
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts <= 0 || ts > now + L.maxFutureMs) {
      throw new AppTelemetryError(`events[${i}].ts must be ms since the epoch`);
    }
    if (typeof kind !== 'string' || !(APP_TELEMETRY_KINDS as readonly string[]).includes(kind)) {
      throw new AppTelemetryError(`events[${i}].kind must be one of ${APP_TELEMETRY_KINDS.join(', ')}`);
    }
    if (fields !== undefined && fields !== null && !isPlainObject(fields)) throw new AppTelemetryError(`events[${i}].fields must be an object`);
    const clean = (fields == null ? {} : sanitizeFields(fields, `events[${i}].fields`)) as Fields;
    if (Buffer.byteLength(JSON.stringify(clean)) > L.maxFieldsBytes) {
      throw new AppTelemetryError(`events[${i}].fields larger than ${L.maxFieldsBytes} bytes`);
    }
    return { ts, kind: kind as AppTelemetryKind, fields: clean };
  });
  return { installId: installId.toLowerCase(), appVersion, os: os.toLowerCase(), events: out };
}
