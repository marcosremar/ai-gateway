/**
 * Typed error classes for the Browser SDK.
 *
 * Every error carries a machine-readable `code`, a human-readable `message`,
 * and a `recoverable` hint so callers can decide whether to retry or bail.
 */

export type SpeechErrorCode =
  | 'NETWORK_ERROR'
  | 'AUTH_ERROR'
  | 'TIMEOUT'
  | 'INVALID_INPUT'
  | 'TRANSPORT_FAILED'
  | 'SERVER_ERROR'
  | 'BROWSER_UNSUPPORTED'
  | 'CIRCUIT_OPEN'
  | 'DESTROYED'
  | 'NOT_CONNECTED'
  | 'BUSY';

export class SpeechSDKError extends Error {
  readonly code: SpeechErrorCode;
  readonly recoverable: boolean;
  readonly context?: Record<string, unknown>;

  constructor(
    code: SpeechErrorCode,
    message: string,
    opts?: { recoverable?: boolean; context?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message);
    this.name = 'SpeechSDKError';
    this.code = code;
    this.recoverable = opts?.recoverable ?? isRecoverableByDefault(code);
    this.context = opts?.context;
    if (opts?.cause) this.cause = opts.cause;
  }
}

function isRecoverableByDefault(code: SpeechErrorCode): boolean {
  switch (code) {
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
    case 'SERVER_ERROR':
    case 'CIRCUIT_OPEN':
    case 'BUSY':
      return true;
    case 'AUTH_ERROR':
    case 'INVALID_INPUT':
    case 'TRANSPORT_FAILED':
    case 'BROWSER_UNSUPPORTED':
    case 'DESTROYED':
    case 'NOT_CONNECTED':
      return false;
    default:
      return false;
  }
}
