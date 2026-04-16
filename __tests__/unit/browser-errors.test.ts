import { describe, it, expect } from 'vitest';
import { SpeechSDKError } from '../src/browser/errors';
import type { SpeechErrorCode } from '../src/browser/errors';

describe('SpeechSDKError', () => {
  describe('construction', () => {
    it('should create error with code and message', () => {
      const err = new SpeechSDKError('NETWORK_ERROR', 'Connection failed');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SpeechSDKError);
      expect(err.message).toBe('Connection failed');
      expect(err.code).toBe('NETWORK_ERROR');
    });

    it('should set name to SpeechSDKError', () => {
      const err = new SpeechSDKError('TIMEOUT', 'Timed out');
      expect(err.name).toBe('SpeechSDKError');
    });

    it('should allow context to be passed', () => {
      const ctx = { endpoint: 'wss://example.com', attempt: 3 };
      const err = new SpeechSDKError('NETWORK_ERROR', 'Failed', { context: ctx });
      expect(err.context).toEqual(ctx);
    });

    it('should allow cause to be passed', () => {
      const cause = new Error('underlying cause');
      const err = new SpeechSDKError('TRANSPORT_FAILED', 'Transport failed', { cause });
      expect(err.cause).toBe(cause);
    });

    it('should allow recoverable to be overridden', () => {
      const err = new SpeechSDKError('NETWORK_ERROR', 'Fail', { recoverable: false });
      expect(err.recoverable).toBe(false);
    });

    it('should have undefined context when not provided', () => {
      const err = new SpeechSDKError('TIMEOUT', 'Timed out');
      expect(err.context).toBeUndefined();
    });
  });

  describe('isRecoverableByDefault — recoverable codes', () => {
    const recoverableCodes: SpeechErrorCode[] = [
      'NETWORK_ERROR',
      'TIMEOUT',
      'SERVER_ERROR',
      'CIRCUIT_OPEN',
      'BUSY',
    ];

    for (const code of recoverableCodes) {
      it(`should mark ${code} as recoverable by default`, () => {
        const err = new SpeechSDKError(code, 'test');
        expect(err.recoverable).toBe(true);
      });
    }
  });

  describe('isRecoverableByDefault — non-recoverable codes', () => {
    const nonRecoverableCodes: SpeechErrorCode[] = [
      'AUTH_ERROR',
      'INVALID_INPUT',
      'TRANSPORT_FAILED',
      'BROWSER_UNSUPPORTED',
      'DESTROYED',
      'NOT_CONNECTED',
    ];

    for (const code of nonRecoverableCodes) {
      it(`should mark ${code} as NOT recoverable by default`, () => {
        const err = new SpeechSDKError(code, 'test');
        expect(err.recoverable).toBe(false);
      });
    }
  });

  describe('override recoverable', () => {
    it('should allow overriding recoverable=true for non-recoverable code', () => {
      const err = new SpeechSDKError('AUTH_ERROR', 'Auth failed', { recoverable: true });
      expect(err.recoverable).toBe(true);
    });

    it('should allow overriding recoverable=false for recoverable code', () => {
      const err = new SpeechSDKError('TIMEOUT', 'Timed out', { recoverable: false });
      expect(err.recoverable).toBe(false);
    });
  });

  describe('instanceof checks', () => {
    it('should be instanceof Error', () => {
      const err = new SpeechSDKError('NETWORK_ERROR', 'test');
      expect(err instanceof Error).toBe(true);
    });

    it('should be instanceof SpeechSDKError', () => {
      const err = new SpeechSDKError('TIMEOUT', 'test');
      expect(err instanceof SpeechSDKError).toBe(true);
    });
  });

  describe('all codes create valid errors', () => {
    const allCodes: SpeechErrorCode[] = [
      'NETWORK_ERROR', 'AUTH_ERROR', 'TIMEOUT', 'INVALID_INPUT',
      'TRANSPORT_FAILED', 'SERVER_ERROR', 'BROWSER_UNSUPPORTED',
      'CIRCUIT_OPEN', 'DESTROYED', 'NOT_CONNECTED', 'BUSY',
    ];

    for (const code of allCodes) {
      it(`should create error for ${code}`, () => {
        const err = new SpeechSDKError(code, `Error: ${code}`);
        expect(err.code).toBe(code);
        expect(err.message).toBe(`Error: ${code}`);
        expect(typeof err.recoverable).toBe('boolean');
      });
    }
  });
});
