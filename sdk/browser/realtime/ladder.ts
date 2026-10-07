/**
 * The transport ladder: try each rung in order with its own timeout, keep the first that connects; remember the winner
 * per network so the next session on the same network starts there (a school Wi-Fi that blocks UDP should not cost 7 s
 * of failed WebRTC on every lesson).
 */
import type { AttemptRecord, RealtimeTimeouts, RealtimeTransport, StorageLike, TransportType } from './types';

export class LadderExhausted extends Error {
  constructor(readonly attempts: AttemptRecord[]) {
    super(`no transport connected (${attempts.map(a => `${a.type}: ${a.error ?? 'failed'}`).join('; ') || 'none available'})`);
  }
}

/** Per-rung budget: WebRTC = ICE gathering + offer round trip + connection; WS = open + ready; clip rungs connect at once. */
export function attemptTimeoutMs(type: TransportType, t: RealtimeTimeouts): number {
  if (type === 'webrtc') return t.iceGatherMs + t.signalingMs + t.webrtcConnectMs;
  if (type === 'ws') return t.wsOpenMs + t.wsReadyMs;
  return 2_000;
}

export async function climbLadder(
  order: TransportType[],
  create: (type: TransportType) => RealtimeTransport | null,
  opts: {
    timeouts: RealtimeTimeouts; signal?: AbortSignal; now?: () => number;
    onTry?: (type: TransportType) => void; onAttempt?: (a: AttemptRecord) => void;
  },
): Promise<{ transport: RealtimeTransport; attempts: AttemptRecord[] }> {
  const now = opts.now ?? (() => Date.now());
  const attempts: AttemptRecord[] = [];
  for (const type of order) {
    if (opts.signal?.aborted) break;
    const transport = create(type);
    if (!transport) continue;
    opts.onTry?.(type);
    const started = now();
    const abort = new AbortController();
    const onOuterAbort = () => abort.abort(new Error('session closed'));
    opts.signal?.addEventListener('abort', onOuterAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.connect(abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`timeout after ${attemptTimeoutMs(type, opts.timeouts)} ms`);
            reject(err); // first: the race settles with the timeout, not with the abort it causes
            abort.abort(err);
          }, attemptTimeoutMs(type, opts.timeouts));
        }),
        new Promise<never>((_, reject) => {
          if (abort.signal.aborted) reject(abort.signal.reason as Error);
          abort.signal.addEventListener('abort', () => reject(abort.signal.reason as Error));
        }),
      ]);
      const record: AttemptRecord = { type, ok: true, ms: now() - started };
      attempts.push(record);
      opts.onAttempt?.(record);
      return { transport, attempts };
    } catch (err) {
      try { transport.close(); } catch { /* already gone */ }
      const record: AttemptRecord = { type, ok: false, ms: now() - started, error: err instanceof Error ? err.message : String(err) };
      attempts.push(record);
      opts.onAttempt?.(record);
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
  throw new LadderExhausted(attempts);
}

/** The ladder with the remembered winner first (the others keep their order, as fallbacks). */
export function orderWithWinner(order: TransportType[], winner: TransportType | null): TransportType[] {
  return winner && order.includes(winner) ? [winner, ...order.filter(t => t !== winner)] : [...order];
}

export const WINNER_TTL_MS = 6 * 3_600_000;
const KEY_PREFIX = 'aigw-rt:winner:';

/** Remembered winners, per network key. Every storage access is guarded (private mode, blocked storage). */
export function createWinnerMemory(storage: StorageLike | null, opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? WINNER_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  return {
    get(network: string): TransportType | null {
      if (!storage) return null;
      try {
        const raw = storage.getItem(KEY_PREFIX + network);
        if (!raw) return null;
        const v = JSON.parse(raw) as { type?: unknown; at?: unknown };
        if (typeof v.at !== 'number' || now() - v.at > ttl) { storage.removeItem(KEY_PREFIX + network); return null; }
        return v.type === 'webrtc' || v.type === 'ws' || v.type === 's2s-stream' || v.type === 'post' ? v.type : null;
      } catch { return null; }
    },
    set(network: string, type: TransportType): void {
      if (!storage) return;
      try { storage.setItem(KEY_PREFIX + network, JSON.stringify({ type, at: now() })); } catch { /* full or blocked */ }
    },
  };
}

/** A coarse key of the current network (Network Information API where it exists; one key elsewhere). */
export function defaultNetworkKey(): string {
  try {
    const c = (globalThis.navigator as { connection?: { type?: string; effectiveType?: string } } | undefined)?.connection;
    return c ? `${c.type ?? 'unknown'}/${c.effectiveType ?? 'unknown'}` : 'default';
  } catch { return 'default'; }
}

export function defaultStorage(): StorageLike | null {
  try { return (globalThis as { localStorage?: StorageLike }).localStorage ?? null; } catch { return null; }
}
