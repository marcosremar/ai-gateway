/**
 * Structured logger for @parle/ai-gateway.
 *
 * Backed by pino for JSON output in production. Implements the `Logger`
 * interface from `./deps` so existing DI call sites keep working without
 * changes — the upgrade is purely additive.
 *
 * Key features:
 *   - `createLogger(module)` returns a namespaced Logger. All lines carry
 *     the module name as a structured field.
 *   - `withLogContext({ requestId, userId }, fn)` establishes an
 *     AsyncLocalStorage frame. Every log line emitted while inside `fn`
 *     (or any async child of it) automatically gets those fields merged
 *     in. This is how correlation IDs flow through the proxy without
 *     threading them as arguments.
 *   - Call-shape compatibility: both `logger.log('text', arg)` and
 *     `logger.log({ fields }, 'text')` and `logger.error(err)` work. This
 *     matches existing call sites in boot-orchestrator, proxy, and GPU
 *     provider clients without requiring any migration.
 *
 * In development (NODE_ENV !== 'production') pino still emits JSON; if
 * you want pretty output locally, pipe through `| pino-pretty` at the
 * shell. We avoid adding pino-pretty as a dep to keep the lib lean.
 */

import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';
import type { Logger } from './deps';

export interface LogContext {
  requestId?: string;
  userId?: string;
  tierIndex?: number;
  provider?: string;
  module?: string;
  [k: string]: unknown;
}

const als = new AsyncLocalStorage<LogContext>();

/** Run `fn` with the given log context merged into the current ALS frame.
 *  Nested calls merge — inner context overrides outer. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = als.getStore() ?? {};
  return als.run({ ...parent, ...ctx }, fn);
}

/** Read the current ALS context (mostly for debugging / tests). */
export function getLogContext(): LogContext | undefined {
  return als.getStore();
}

// ── Test-mode detection ───────────────────────────────────────────────────
// In Vitest, tests frequently spy on `console.log` / `console.warn` to
// assert on observable log output. Routing through pino would bypass those
// spies and break the tests. So in test mode we back the logger with the
// global `console` object instead; production and dev keep using pino for
// structured JSON output.
const isTestMode = process.env.VITEST === 'true'
  || process.env.NODE_ENV === 'test'
  || !!process.env.VITEST_WORKER_ID;

// ── Internal pino instance (production / dev) ────────────────────────────
// `base: null` suppresses pid/hostname (we run in containers where those
// are set upstream). Timestamp is ISO so log aggregators parse it uniformly.
// The mixin auto-attaches the ALS context to every line — this is what
// makes correlation IDs work without touching call sites.

const basePino = isTestMode ? null : pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin: () => als.getStore() ?? {},
});

// ── Call-shape adapter ────────────────────────────────────────────────────
// The existing Logger interface uses `log(...args: unknown[])` — it accepts
// anything, mirroring console.* ergonomics. Pino wants `info(obj, msg)` or
// `info(msg)`. This wrapper bridges the two shapes so existing call sites
// like `this.logger.log('Tier ${i} OK')` AND new structured calls like
// `this.logger.log({ tierIndex: i }, 'Tier OK')` both produce sensible
// structured output.
//
// In test mode the same wrapper forwards to console.* so vi.spyOn(console)
// assertions continue to work unchanged. IMPORTANT: the console method
// must be looked up at CALL time rather than module-load time — if we
// cache a reference to console.log at load, tests that vi.spyOn(console)
// replace the method on the console object AFTER load and our cached
// reference bypasses the spy. This broke `gpu-cache-retry.test.ts` until
// we switched to dynamic lookup.

function wrap(method: 'debug' | 'info' | 'warn' | 'error', moduleName: string) {
  return (...args: unknown[]): void => {
    if (args.length === 0) return;

    // Test mode: forward directly to the LIVE console method (spy-compatible).
    // We mirror the args exactly — no structured shape-rewriting — so
    // assertions like `expect(spy).toHaveBeenCalledWith('some message')`
    // continue to work against legacy test suites.
    if (isTestMode || !basePino) {
      const consoleName: 'log' | 'debug' | 'warn' | 'error' =
        method === 'info' ? 'log' : method;
      // eslint-disable-next-line no-console
      (console[consoleName] as (...a: unknown[]) => void)(...args);
      return;
    }

    const first = args[0];

    // Shape 1: logger.log({ ...fields }, 'message', ...rest)
    if (typeof first === 'object' && first !== null && !(first instanceof Error) && !Array.isArray(first)) {
      const [obj, msg, ...rest] = args;
      basePino[method]({ ...(obj as object), module: moduleName },
        typeof msg === 'string' ? msg : String(msg ?? ''),
        ...rest);
      return;
    }

    // Shape 2: logger.error(err) or logger.error(err, 'context')
    if (first instanceof Error) {
      const [err, msg] = args;
      basePino[method]({ err, module: moduleName },
        typeof msg === 'string' ? msg : (err as Error).message);
      return;
    }

    // Shape 3: logger.log('message', arg1, arg2, ...) — flatten to a string
    // the way console.log would. This path preserves the output of every
    // legacy call site without requiring migration.
    const text = args.map(a => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    basePino[method]({ module: moduleName }, text);
  };
}

/** Create a namespaced logger. Every line emitted carries `module=<name>`. */
export function createLogger(moduleName: string): Logger {
  return {
    debug: wrap('debug', moduleName),
    log: wrap('info', moduleName),
    warn: wrap('warn', moduleName),
    error: wrap('error', moduleName),
  };
}

/** Default logger used by code that hasn't yet adopted a module name.
 *  Kept for backward compatibility with the previous `defaultLogger` export. */
export const defaultLogger: Logger = createLogger('app');
