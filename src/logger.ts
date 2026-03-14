import type { Logger } from './deps';

export const defaultLogger: Logger = {
  debug: console.debug,
  log: console.log,
  warn: console.warn,
  error: console.error,
};
