import type { Logger } from './deps';

export const defaultLogger: Logger = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
