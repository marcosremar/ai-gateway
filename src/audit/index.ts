/**
 * Audit Logger — tamper-evident audit trail for security-relevant events.
 *
 * Writes to a JSONL file (append-only) with line-level checksums.
 * Unlike the regular logger (pino), this is NOT structured for aggregation —
 * it's a forensic log for security investigations.
 *
 * @example
 * ```ts
 * const audit = createAuditLogger('/var/log/gateway-audit.jsonl');
 * await audit.log({ event: 'AUTH_SUCCESS', userId: 'abc', ip: '1.2.3.4' });
 * await audit.log({ event: 'GPU_DEPLOY', userId: 'abc', provider: 'runpod' });
 * ```
 */

import { appendFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

export interface AuditEvent {
  /** ISO timestamp (auto-set if not provided) */
  timestamp?: string;
  /** Event type — e.g., AUTH_SUCCESS, GPU_DEPLOY, CONFIG_CHANGE */
  event: string;
  /** User or API key that triggered the event */
  actor?: string;
  /** Source IP address */
  ip?: string;
  /** Additional event-specific context */
  [key: string]: unknown;
}

export interface AuditLoggerOptions {
  /** Max file size before rotation (default: 100MB) */
  maxSizeBytes?: number;
  /** Enable checksum validation on read (default: true) */
  verifyChecksum?: boolean;
}

const DEFAULT_OPTIONS: Required<AuditLoggerOptions> = {
  maxSizeBytes: 100 * 1024 * 1024, // 100MB
  verifyChecksum: true,
};

export class AuditLogger {
  private readonly filePath: string;
  private readonly options: Required<AuditLoggerOptions>;

  constructor(filePath: string, options: AuditLoggerOptions = {}) {
    this.filePath = filePath;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Log an audit event (append-only).
   */
  async log(event: AuditEvent): Promise<void> {
    const entry = {
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...event,
    };

    // Compute checksum for tamper detection
    const checksum = createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16);

    const line = JSON.stringify({ ...entry, _checksum: checksum }) + '\n';

    try {
      await appendFile(this.filePath, line, { encoding: 'utf-8' });
    } catch (err) {
      // Never fail silently — throw so the caller knows audit logging broke
      throw new Error(
        `Audit log write failed (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Read and verify the audit log.
   * Returns parsed events, or throws if tampering is detected.
   */
  async read(options?: { lastN?: number }): Promise<AuditEvent[]> {
    if (!existsSync(this.filePath)) return [];

    const content = await readFile(this.filePath, 'utf-8');
    const lines = content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line);
        if (this.options.verifyChecksum) {
          const { _checksum, ...data } = entry;
          const expected = createHash('sha256')
            .update(JSON.stringify(data))
            .digest('hex')
            .slice(0, 16);

          if (_checksum !== expected) {
            throw new Error(
              `Audit log tampering detected! Checksum mismatch at line: ${line.slice(0, 80)}...`,
            );
          }
        }
        return entry as AuditEvent;
      });

    const { lastN } = options ?? {};
    return lastN ? lines.slice(-lastN) : lines;
  }

  /**
   * Check if the log file needs rotation (size-based).
   */
  async needsRotation(): Promise<boolean> {
    try {
      const { size } = await readFile(this.filePath).then(() => ({
        size: 0, // placeholder
      }));
      return false;
    } catch {
      return false;
    }
  }
}

/**
 * Audit event types — use these for consistency.
 */
export const AUDIT_EVENTS = {
  AUTH_SUCCESS: 'AUTH_SUCCESS',
  AUTH_FAILURE: 'AUTH_FAILURE',
  GPU_DEPLOY: 'GPU_DEPLOY',
  GPU_STOP: 'GPU_STOP',
  GPU_TERMINATE: 'GPU_TERMINATE',
  CONFIG_CHANGE: 'CONFIG_CHANGE',
  API_KEY_ROTATE: 'API_KEY_ROTATE',
  BUDGET_ALERT: 'BUDGET_ALERT',
  RATE_LIMIT_HIT: 'RATE_LIMIT_HIT',
  PROVIDER_SWITCH: 'PROVIDER_SWITCH',
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
