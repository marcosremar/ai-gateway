/**
 * Server-side telemetry emitter (e.g. the parle backend) — the same batching emitter as the browser SDK
 * (sdk/browser/telemetry), authenticated with the app's gateway key. No beacon, no window listeners; call `close()`
 * (or let `beforeExit` do it) so the last batch goes out.
 *
 *   const telemetry = createServerTelemetry({ endpoint: GATEWAY_URL, apiKey: GATEWAY_KEY });
 *   telemetry.emit('turn.done', { traceId, sessionId, turnId, durMs: 2300, attrs: { outcome: 'ok' } });
 *
 * `source` defaults to `app` (the server app's own events); it may relay `browser` | `edge` | `model` events it
 * observed (`gateway` is reserved to the gateway). The `app` field is stamped by the gateway from the key.
 */
import { TelemetryEmitter, type TelemetryEmitterOptions } from '../browser/telemetry/emitter';

export { TelemetryEmitter, newTraceId, traceparentOf } from '../browser/telemetry/emitter';
export type { EmitFields, TelemetryContext, TelemetryStats } from '../browser/telemetry/emitter';

export interface ServerTelemetryOptions extends Omit<TelemetryEmitterOptions, 'token' | 'beacon' | 'target' | 'captureErrors' | 'source'> {
  apiKey: string;
  source?: Exclude<NonNullable<TelemetryEmitterOptions['source']>, 'gateway'>;
  /** Flush on process `beforeExit` (default true). */
  flushOnExit?: boolean;
}

export function createServerTelemetry(opts: ServerTelemetryOptions): TelemetryEmitter {
  const { apiKey, flushOnExit, source, ...rest } = opts;
  const emitter = new TelemetryEmitter({ ...rest, source: source ?? 'app', token: apiKey, beacon: false, target: null, captureErrors: false });
  const proc = (globalThis as { process?: { once?: (ev: string, fn: () => void) => void } }).process;
  if (flushOnExit !== false) proc?.once?.('beforeExit', () => { void emitter.close(); });
  return emitter;
}
