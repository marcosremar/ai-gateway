import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, setLogLevel, setLogHandler } from '../../src/browser/logger';
import type { LogLevel } from '../../src/browser/logger';

describe('browser logger', () => {
  // Reset global state between tests
  beforeEach(() => {
    setLogLevel('warn');
    setLogHandler(null);
  });

  afterEach(() => {
    setLogLevel('warn');
    setLogHandler(null);
  });

  describe('createLogger()', () => {
    it('should return a logger with debug/info/warn/error methods', () => {
      const log = createLogger('Test');
      expect(typeof log.debug).toBe('function');
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.error).toBe('function');
    });

    it('should create namespaced logger with prefix in tag', () => {
      const handler = vi.fn();
      setLogHandler(handler);
      setLogLevel('debug');
      const log = createLogger('MyModule');
      log.warn('test message');
      expect(handler).toHaveBeenCalledWith('warn', '[SpeechSDK:MyModule]', ['test message']);
    });
  });

  describe('setLogLevel()', () => {
    it('should suppress debug when level is warn (default)', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const log = createLogger('Test');
      log.debug('debug msg');
      expect(debugSpy).not.toHaveBeenCalled();
      debugSpy.mockRestore();
    });

    it('should allow debug messages when level is debug', () => {
      setLogLevel('debug');
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const log = createLogger('Test');
      log.debug('debug msg');
      expect(debugSpy).toHaveBeenCalled();
      debugSpy.mockRestore();
    });

    it('should suppress info when level is warn', () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const log = createLogger('Test');
      log.info('info msg');
      expect(infoSpy).not.toHaveBeenCalled();
      infoSpy.mockRestore();
    });

    it('should allow info when level is info', () => {
      setLogLevel('info');
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const log = createLogger('Test');
      log.info('info msg');
      expect(infoSpy).toHaveBeenCalled();
      infoSpy.mockRestore();
    });

    it('should allow warn when level is warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = createLogger('Test');
      log.warn('warn msg');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should allow error when level is warn', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = createLogger('Test');
      log.error('error msg');
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('should suppress everything when level is silent', () => {
      setLogLevel('silent');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = createLogger('Test');
      log.warn('warn msg');
      log.error('error msg');
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should allow all levels when level is debug', () => {
      setLogLevel('debug');
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = createLogger('Test');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      expect(debugSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('setLogHandler()', () => {
    it('should call custom handler instead of console', () => {
      const handler = vi.fn();
      setLogHandler(handler);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = createLogger('Custom');
      log.warn('custom message');
      expect(handler).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should pass level, tag, and args to custom handler', () => {
      const handler = vi.fn();
      setLogHandler(handler);
      setLogLevel('debug');
      const log = createLogger('NS');
      log.debug('msg', 'arg2');
      expect(handler).toHaveBeenCalledWith('debug', '[SpeechSDK:NS]', ['msg', 'arg2']);
    });

    it('should restore console logging when handler set to null', () => {
      const handler = vi.fn();
      setLogHandler(handler);
      setLogHandler(null);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = createLogger('Test');
      log.warn('hello');
      expect(warnSpy).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should pass correct level for each method', () => {
      const handler = vi.fn();
      setLogHandler(handler);
      setLogLevel('debug');
      const log = createLogger('T');

      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      const calls = handler.mock.calls;
      expect(calls[0][0]).toBe('debug');
      expect(calls[1][0]).toBe('info');
      expect(calls[2][0]).toBe('warn');
      expect(calls[3][0]).toBe('error');
    });
  });

  describe('console method routing', () => {
    it('should use console.debug for debug level', () => {
      setLogLevel('debug');
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const log = createLogger('Test');
      log.debug('msg');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should use console.info for info level', () => {
      setLogLevel('info');
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const log = createLogger('Test');
      log.info('msg');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should use console.warn for warn level', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = createLogger('Test');
      log.warn('msg');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should use console.error for error level', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = createLogger('Test');
      log.error('msg');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('multiple loggers', () => {
    it('should use global level across all logger instances', () => {
      setLogLevel('error');
      const handler = vi.fn();
      setLogHandler(handler);
      const log1 = createLogger('A');
      const log2 = createLogger('B');
      log1.warn('from A');
      log2.warn('from B');
      expect(handler).not.toHaveBeenCalled();
      log1.error('error from A');
      log2.error('error from B');
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
