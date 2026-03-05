# Exemplos de Testes — Prioridade 1

## 1. src/browser/emitter.ts — TypedEmitter

```typescript
import { describe, it, expect } from 'vitest';
import { TypedEmitter } from './emitter';

interface TestEvents {
  'message': { text: string };
  'error': { code: number; message: string };
  'done': undefined;
}

describe('TypedEmitter', () => {
  it('should register and emit events', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const events: any[] = [];
    
    emitter.on('message', (data) => events.push(data));
    emitter.emit('message', { text: 'hello' });
    
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ text: 'hello' });
  });

  it('should support multiple listeners on same event', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const calls: string[] = [];
    
    emitter.on('message', () => calls.push('listener1'));
    emitter.on('message', () => calls.push('listener2'));
    emitter.emit('message', { text: 'test' });
    
    expect(calls).toEqual(['listener1', 'listener2']);
  });

  it('should return unsubscribe function', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const events: any[] = [];
    
    const unsub = emitter.on('message', (data) => events.push(data));
    emitter.emit('message', { text: 'first' });
    
    unsub();
    emitter.emit('message', { text: 'second' });
    
    expect(events).toHaveLength(1);
  });

  it('should swallow errors in listeners', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const errors: Error[] = [];
    
    // Mock console.warn to track error logs
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg, err) => {
      errors.push(err);
    });
    
    emitter.on('message', () => {
      throw new Error('Listener error');
    });
    emitter.on('message', () => {
      // This should still be called
    });
    
    expect(() => emitter.emit('message', { text: 'test' })).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Listener error');
    
    warnSpy.mockRestore();
  });

  it('should support off() to remove specific listener', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const calls: string[] = [];
    
    const handler1 = () => calls.push('handler1');
    const handler2 = () => calls.push('handler2');
    
    emitter.on('message', handler1);
    emitter.on('message', handler2);
    emitter.off('message', handler1);
    emitter.emit('message', { text: 'test' });
    
    expect(calls).toEqual(['handler2']);
  });

  it('should support removeAllListeners()', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const calls: string[] = [];
    
    emitter.on('message', () => calls.push('m1'));
    emitter.on('message', () => calls.push('m2'));
    emitter.on('error', () => calls.push('e1'));
    
    emitter.removeAllListeners('message');
    emitter.emit('message', { text: 'test' });
    emitter.emit('error', { code: 1, message: 'err' });
    
    expect(calls).toEqual(['e1']);
  });

  it('should clear all listeners when called without event', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const calls: string[] = [];
    
    emitter.on('message', () => calls.push('m'));
    emitter.on('error', () => calls.push('e'));
    
    emitter.removeAllListeners();
    emitter.emit('message', { text: 'test' });
    emitter.emit('error', { code: 1, message: 'err' });
    
    expect(calls).toHaveLength(0);
  });

  it('should isolate events (error should not receive message data)', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const events: any[] = [];
    
    emitter.on('error', (data) => events.push(data));
    emitter.emit('message', { text: 'hello' });
    
    expect(events).toHaveLength(0);
  });
});
```

## 2. src/browser/logger.ts — createLogger

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { 
  createLogger, 
  setLogLevel, 
  setLogHandler, 
  type LogLevel 
} from './logger';

describe('Browser Logger', () => {
  beforeEach(() => {
    setLogLevel('warn'); // Reset to default
    setLogHandler(null);
  });

  it('should create a namespaced logger', () => {
    const log = createLogger('TestModule');
    expect(log).toHaveProperty('debug');
    expect(log).toHaveProperty('info');
    expect(log).toHaveProperty('warn');
    expect(log).toHaveProperty('error');
  });

  it('should respect global log level', () => {
    const logs: { level: LogLevel; msg: string }[] = [];
    
    setLogHandler((level, prefix, args) => {
      logs.push({ level, msg: args.join(' ') });
    });
    
    const log = createLogger('Test');
    
    setLogLevel('warn');
    log.debug('debug msg');
    log.info('info msg');
    log.warn('warn msg');
    log.error('error msg');
    
    // Only warn and error should be logged
    expect(logs.map(l => l.level)).toEqual(['warn', 'error']);
  });

  it('should not log debug when level is info', () => {
    const logs: LogLevel[] = [];
    
    setLogHandler((level) => logs.push(level));
    setLogLevel('info');
    
    const log = createLogger('Test');
    log.debug('msg');
    log.info('msg');
    
    expect(logs).toEqual(['info']);
  });

  it('should include prefix in output', () => {
    const outputs: Array<{ prefix: string; msg: string }> = [];
    
    setLogHandler((level, prefix, args) => {
      outputs.push({ prefix, msg: args.join(' ') });
    });
    
    setLogLevel('debug');
    const log = createLogger('MyModule');
    log.info('test');
    
    expect(outputs[0].prefix).toBe('[SpeechSDK:MyModule]');
  });

  it('should use default console when no handler set', () => {
    setLogLevel('warn');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    const log = createLogger('Test');
    log.warn('test warning');
    
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should support silent level', () => {
    const logs: any[] = [];
    
    setLogHandler(() => logs.push('logged'));
    setLogLevel('silent');
    
    const log = createLogger('Test');
    log.error('msg'); // Even errors should be silent
    
    expect(logs).toHaveLength(0);
  });

  it('should preserve level order (debug < info < warn < error)', () => {
    const logs: LogLevel[] = [];
    
    setLogHandler((level) => logs.push(level));
    setLogLevel('warn');
    
    const log = createLogger('Test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    
    expect(logs).toEqual(['warn', 'error']);
  });

  it('should support custom handler integration', () => {
    const customHandler = vi.fn();
    setLogHandler(customHandler);
    setLogLevel('info');
    
    const log = createLogger('Test');
    log.info('custom message');
    
    expect(customHandler).toHaveBeenCalledWith(
      'info',
      '[SpeechSDK:Test]',
      ['custom message']
    );
  });
});
```

## 3. src/providers/errors.ts — buildProviderError

```typescript
import { describe, it, expect } from 'vitest';
import { 
  buildProviderError, 
  CreditExhaustedError,
  extractErrorStatus,
  extractErrorMessage 
} from './errors';

describe('Provider Errors', () => {
  describe('buildProviderError', () => {
    it('should map 429 (quota) with billing URL', () => {
      const result = buildProviderError('openai', 429, 'Rate limit exceeded');
      
      expect(result.status).toBe(429);
      expect(result.message).toContain('Limite de uso atingido');
      expect(result.message).toContain('platform.openai.com');
    });

    it('should map 401 (auth) error', () => {
      const result = buildProviderError('groq', 401, 'Unauthorized');
      
      expect(result.status).toBe(401);
      expect(result.message).toContain('Chave de API inválida');
      expect(result.message).toContain('Configurações');
    });

    it('should map 402 (payment) error', () => {
      const result = buildProviderError('openrouter', 402, 'Payment required');
      
      expect(result.status).toBe(402);
      expect(result.message).toContain('Pagamento necessário');
      expect(result.message).toContain('openrouter.ai');
    });

    it('should map 403 (forbidden)', () => {
      const result = buildProviderError('fireworks', 403, 'Forbidden');
      
      expect(result.status).toBe(403);
      expect(result.message).toContain('Acesso negado');
    });

    it('should map 404 (not found)', () => {
      const result = buildProviderError('openai', 404, 'Model not found');
      
      expect(result.status).toBe(404);
      expect(result.message).toContain('Modelo não encontrado');
    });

    it('should map 502/503 (service unavailable)', () => {
      const result502 = buildProviderError('openai', 502, 'Bad Gateway');
      const result503 = buildProviderError('openai', 503, 'Service Unavailable');
      
      expect(result502.status).toBe(502);
      expect(result503.status).toBe(503);
      expect(result502.message).toContain('Serviço temporariamente indisponível');
      expect(result503.message).toContain('Serviço temporariamente indisponível');
    });

    it('should detect timeout errors', () => {
      const result = buildProviderError('openai', undefined, 'timeout: operation timed out');
      
      expect(result.status).toBe(408);
      expect(result.message).toContain('Tempo de resposta esgotado');
    });

    it('should detect ETIMEDOUT', () => {
      const result = buildProviderError('groq', undefined, 'Error: ETIMEDOUT');
      
      expect(result.status).toBe(408);
    });

    it('should detect network errors', () => {
      const result = buildProviderError('openai', undefined, 'fetch failed');
      
      expect(result.status).toBe(502);
      expect(result.message).toContain('Não foi possível conectar');
    });

    it('should detect connection refused', () => {
      const result = buildProviderError('openai', undefined, 'ECONNREFUSED');
      
      expect(result.status).toBe(502);
    });

    it('should fallback for unknown status', () => {
      const result = buildProviderError('openai', 418, 'I am a teapot');
      
      expect(result.status).toBe(418);
      expect(result.message).toContain('OpenAI');
      expect(result.message).toContain('I am a teapot');
    });

    it('should handle unknown providers gracefully', () => {
      const result = buildProviderError('unknown-provider', 401, 'Unauthorized');
      
      expect(result.status).toBe(401);
      expect(result.message).toContain('unknown-provider');
    });
  });

  describe('CreditExhaustedError', () => {
    it('should construct with provider list', () => {
      const error = new CreditExhaustedError(['openai', 'groq']);
      
      expect(error.status).toBe(402);
      expect(error.providers).toEqual(['openai', 'groq']);
      expect(error.name).toBe('CreditExhaustedError');
    });

    it('should include billing URLs for known providers', () => {
      const error = new CreditExhaustedError(['openai', 'groq', 'fireworks']);
      
      expect(error.billingUrls['openai']).toBe('platform.openai.com/settings/organization/billing');
      expect(error.billingUrls['groq']).toBe('console.groq.com/settings/billing');
      expect(error.billingUrls['fireworks']).toBe('fireworks.ai/account/billing');
    });

    it('should omit billing URLs for unknown providers', () => {
      const error = new CreditExhaustedError(['openai', 'unknown']);
      
      expect(error.billingUrls).toHaveProperty('openai');
      expect(error.billingUrls).not.toHaveProperty('unknown');
    });

    it('should format message with URLs', () => {
      const error = new CreditExhaustedError(['openai']);
      
      expect(error.message).toContain('Créditos esgotados');
      expect(error.message).toContain('platform.openai.com');
    });
  });

  describe('Helper functions', () => {
    it('extractErrorStatus should get status from error objects', () => {
      const error = { status: 401, message: 'Unauthorized' };
      expect(extractErrorStatus(error)).toBe(401);
    });

    it('extractErrorStatus should return undefined for non-error objects', () => {
      expect(extractErrorStatus({})).toBeUndefined();
      expect(extractErrorStatus(null)).toBeUndefined();
    });

    it('extractErrorMessage should handle Error objects', () => {
      const error = new Error('Test error');
      expect(extractErrorMessage(error, 'fallback')).toBe('Test error');
    });

    it('extractErrorMessage should use fallback for non-Error objects', () => {
      expect(extractErrorMessage('string', 'fallback')).toBe('fallback');
      expect(extractErrorMessage(null, 'fallback')).toBe('fallback');
    });
  });
});
```

## 4. src/hooks.ts — emitHook

```typescript
import { describe, it, expect, vi } from 'vitest';
import { emitHook, type GatewayHooks } from './hooks';

describe('emitHook', () => {
  it('should be noop when hooks undefined', () => {
    // Should not throw
    expect(() => {
      emitHook(undefined, 'onRequestStart', {
        userId: 'user1',
        stage: 'stt',
        provider: 'openai',
        timestamp: Date.now(),
      });
    }).not.toThrow();
  });

  it('should call matching hook function', () => {
    const hooks: GatewayHooks = {
      onRequestStart: vi.fn(),
    };

    emitHook(hooks, 'onRequestStart', {
      userId: 'user1',
      stage: 'stt',
      provider: 'openai',
      timestamp: Date.now(),
    });

    expect(hooks.onRequestStart).toHaveBeenCalledOnce();
  });

  it('should pass correct payload to hook', () => {
    const payload = {
      userId: 'user123',
      stage: 'llm' as const,
      provider: 'groq',
      timestamp: 12345,
    };

    const hooks: GatewayHooks = {
      onRequestStart: vi.fn(),
    };

    emitHook(hooks, 'onRequestStart', payload);

    expect(hooks.onRequestStart).toHaveBeenCalledWith(payload);
  });

  it('should not call hook if undefined', () => {
    const hooks: GatewayHooks = {}; // onRequestStart not defined

    expect(() => {
      emitHook(hooks, 'onRequestStart', {
        userId: 'user1',
        stage: 'stt',
        provider: 'openai',
        timestamp: Date.now(),
      });
    }).not.toThrow();
  });

  it('should catch sync errors in hooks', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const hooks: GatewayHooks = {
      onRequestStart: () => {
        throw new Error('Hook error');
      },
    };

    // Should not re-throw
    expect(() => {
      emitHook(hooks, 'onRequestStart', {
        userId: 'user1',
        stage: 'stt',
        provider: 'openai',
        timestamp: Date.now(),
      });
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[hooks] onRequestStart sync error:'),
      expect.any(Error)
    );

    warnSpy.mockRestore();
  });

  it('should catch async errors in hooks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const hooks: GatewayHooks = {
      onRequestStart: async () => {
        throw new Error('Async hook error');
      },
    };

    emitHook(hooks, 'onRequestStart', {
      userId: 'user1',
      stage: 'stt',
      provider: 'openai',
      timestamp: Date.now(),
    });

    // Give async handler time to catch
    await new Promise(r => setTimeout(r, 50));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[hooks] onRequestStart async error:'),
      expect.any(Error)
    );

    warnSpy.mockRestore();
  });

  it('should support async hook functions', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    const hooks: GatewayHooks = { onScaleUp: hook };

    const payload = {
      userId: 'user1',
      tierIndex: 0,
      provider: 'runpod',
      trigger: 'sessions',
      activeSessions: 5,
      timestamp: Date.now(),
    };

    emitHook(hooks, 'onScaleUp', payload);
    
    await new Promise(r => setTimeout(r, 50));

    expect(hook).toHaveBeenCalledWith(payload);
  });

  it('should isolate errors between hooks', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const hook1 = vi.fn(() => {
      throw new Error('Hook 1 error');
    });
    const hook2 = vi.fn();

    const hooks: GatewayHooks = {
      onFallback: hook1,
    };

    emitHook(hooks, 'onFallback', {
      userId: 'user1',
      stage: 'stt',
      fromProvider: 'openai',
      toProvider: 'groq',
      reason: 'quota',
      timestamp: Date.now(),
    });

    // Error in hook1 should not affect other operations
    expect(hook2).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
```

---

## Padrão Comum para Todos

Todos os testes devem:
1. Usar `vitest` (já configurado no projeto)
2. Incluir imports necessários
3. Testar happy path + edge cases + error handling
4. Usar `vi.fn()` para mocks
5. Mockar dependências externas (fetch, console, timers)
6. Incluir testes de integração para comportamento complexo

