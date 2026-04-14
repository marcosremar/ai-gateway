// ── BabelCast Gateway — Modal TTS Keepalive ──────────────────────────────────
// Ping Modal /health every 4 minutes while voice cloning is active, so Modal
// doesn't scale to zero mid-session (default scaledown=15min). Stops itself
// after 20 minutes of inactivity.

import { createLogger } from '../../logger';

const log = createLogger('modal-keepalive');

const PING_INTERVAL_MS = 4 * 60_000; // 4 minutes
const IDLE_STOP_MS = 20 * 60_000; // 20 minutes

export interface ModalKeepaliveOptions {
  /** Endpoint URL for the Modal TTS deployment (must expose /health). */
  endpoint: string;
  /** Ping timeout per request. Defaults to 30s. */
  pingTimeoutMs?: number;
}

/**
 * Self-contained keepalive controller. Create once per process (the gateway
 * instantiates a single instance and exposes `touch()` / `stop()` via
 * ai-handlers.ts).
 */
export class ModalKeepalive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTouchAt = 0;

  constructor(private opts: ModalKeepaliveOptions) {}

  /** Reset the idle timer. If not running, starts the periodic ping loop. */
  touch(): void {
    this.lastTouchAt = Date.now();
    if (this.timer) return;
    log.log('Starting keepalive (ping every 4min while clone active)');
    this.timer = setInterval(() => this.tick(), PING_INTERVAL_MS);
  }

  /** Stop the timer immediately (e.g. on process shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.lastTouchAt > IDLE_STOP_MS) {
      log.log('No clone requests in 20min — stopping keepalive');
      this.stop();
      return;
    }
    try {
      const res = await fetch(`${this.opts.endpoint}/health`, {
        signal: AbortSignal.timeout(this.opts.pingTimeoutMs ?? 30_000),
      });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        log.log(`OK (uptime=${data.uptime_s}s, clone=${data.clone})`);
      } else {
        log.warn(`HTTP ${res.status}`);
      }
    } catch (err) {
      log.warn(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
