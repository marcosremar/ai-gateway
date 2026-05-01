/**
 * Lightweight logger for the Browser SDK.
 *
 * Supports four levels (debug, info, warn, error) and a global debug flag.
 * When `debug` mode is off, debug-level messages are silently dropped.
 *
 * @example
 * ```ts
 * const log = createLogger('WS');
 * log.debug('connecting to', url);  // only prints if debug=true
 * log.info('connected');
 * log.warn('reconnecting', { attempt: 2 });
 * log.error('failed', err);
 * ```
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface LoggerOptions {
  /** Minimum level to output. Default: 'warn' */
  level?: LogLevel;
  /** Custom log handler. Defaults to console. */
  handler?: (level: LogLevel, prefix: string, args: unknown[]) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

let globalLevel: LogLevel = 'warn';
let globalHandler: LoggerOptions['handler'] | null = null;

/**
 * Set the global log level for all SDK loggers.
 * @param level - Minimum level to output. 'silent' suppresses everything.
 */
export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

/**
 * Set a global custom log handler (useful for integrating with external logging).
 * Pass `null` to reset to default console logging.
 */
export function setLogHandler(handler: LoggerOptions['handler'] | null): void {
  globalHandler = handler;
}

/**
 * Create a namespaced logger instance.
 * @param prefix - Short namespace (e.g., 'WS', 'SSE', 'Client')
 */
export function createLogger(prefix: string): Logger {
  const tag = `[SpeechSDK:${prefix}]`;

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[globalLevel];
  }

  function log(level: LogLevel, args: unknown[]): void {
    if (!shouldLog(level)) return;
    if (globalHandler) {
      globalHandler(level, tag, args);
      return;
    }
    const fn = level === 'debug' ? console.debug
      : level === 'info' ? console.info
      : level === 'warn' ? console.warn
      : console.error;
    fn(tag, ...args);
  }

  return {
    debug: (...args) => log('debug', args),
    info: (...args) => log('info', args),
    warn: (...args) => log('warn', args),
    error: (...args) => log('error', args),
  };
}
