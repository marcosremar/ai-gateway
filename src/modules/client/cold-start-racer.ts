/**
 * Cold-Start Racer — races a cloud pipeline against a booting GPU pipeline.
 *
 * When the autoscaler reports a GPU that is still booting, the racer starts the
 * cloud request immediately and polls the GPU health endpoint in parallel.
 * Whichever finishes first wins; the loser is aborted via AbortController to
 * save compute and bandwidth.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColdStartRacerConfig {
  /** Only race if estimated GPU ready time < this threshold (ms). Default: 30_000 */
  maxEstimatedReadyMs?: number;
  /** How long to wait for GPU health check before giving up. Default: 30_000 */
  healthProbeTimeoutMs?: number;
  /** Min boot progress (0-1) before racing. Default: 0.5 */
  minBootProgress?: number;
}

export interface RaceContext {
  gpuEndpoint: string;
  estimatedReadyMs: number;
  /** Timestamp (ms) when the GPU boot was triggered. Used to compute boot progress. */
  bootStartedAt?: number;
}

export interface RaceResult<T> {
  result: T;
  source: 'cloud' | 'gpu';
}

interface RaceLogger {
  info: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<ColdStartRacerConfig> = {
  maxEstimatedReadyMs: 30_000,
  healthProbeTimeoutMs: 30_000,
  minBootProgress: 0.5,
};

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

/**
 * Poll the GPU health endpoint until it returns HTTP 200 or the timeout/signal fires.
 */
export async function waitForGpuReady(
  endpoint: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !signal.aborted) {
    try {
      const res = await fetch(`${endpoint}/health`, { signal, method: 'GET' });
      if (res.ok) return true;
    } catch {
      /* ignore — network errors, aborted signals, etc. */
    }
    // Don't sleep if already past the timeout or aborted
    if (Date.now() - start + 2000 >= timeoutMs || signal.aborted) break;
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Boot progress helper
// ---------------------------------------------------------------------------

/**
 * Compute boot progress as a fraction 0-1.
 *
 * progress = elapsed / (elapsed + estimatedRemainingMs)
 *
 * If bootStartedAt is not provided, returns 0 (unknown progress).
 */
function computeBootProgress(ctx: RaceContext): number {
  if (!ctx.bootStartedAt) return 0;
  const elapsed = Date.now() - ctx.bootStartedAt;
  if (elapsed <= 0) return 0;
  const total = elapsed + ctx.estimatedReadyMs;
  if (total <= 0) return 1;
  return Math.min(elapsed / total, 1);
}

// ---------------------------------------------------------------------------
// Cold-Start Race
// ---------------------------------------------------------------------------

/**
 * Race a cloud pipeline against a GPU pipeline that is still booting.
 *
 * 1. Check boot progress — if below `minBootProgress`, skip race and run cloud only.
 * 2. Start cloud immediately via `cloudFn(signal)`.
 * 3. In parallel, poll GPU health; on success run `gpuFn(endpoint, signal)`.
 * 4. `Promise.race` — first to resolve wins.
 * 5. Abort the loser's signal.
 * 6. If one side throws, the other wins. If both throw, the error propagates.
 */
export async function coldStartRace<T>(
  cloudFn: (signal: AbortSignal) => Promise<T>,
  gpuFn: (endpoint: string, signal: AbortSignal) => Promise<T>,
  ctx: RaceContext,
  config?: ColdStartRacerConfig,
  logger?: RaceLogger,
): Promise<RaceResult<T>> {
  const cfg: Required<ColdStartRacerConfig> = { ...DEFAULT_CONFIG, ...config };

  // ── Guard: estimated ready too far out ─────────────────────────────────
  if (ctx.estimatedReadyMs > cfg.maxEstimatedReadyMs) {
    logger?.info(
      `[ColdStartRacer] GPU estimated ${ctx.estimatedReadyMs}ms away (max ${cfg.maxEstimatedReadyMs}ms) — cloud only`,
    );
    const cloudCtrl = new AbortController();
    const result = await cloudFn(cloudCtrl.signal);
    return { result, source: 'cloud' };
  }

  // ── Guard: boot progress too low ───────────────────────────────────────
  const progress = computeBootProgress(ctx);
  if (progress < cfg.minBootProgress) {
    logger?.info(
      `[ColdStartRacer] Boot progress ${(progress * 100).toFixed(0)}% < ${(cfg.minBootProgress * 100).toFixed(0)}% — cloud only`,
    );
    const cloudCtrl = new AbortController();
    const result = await cloudFn(cloudCtrl.signal);
    return { result, source: 'cloud' };
  }

  // ── Race: cloud vs GPU ────────────────────────────────────────────────
  const cloudCtrl = new AbortController();
  const gpuCtrl = new AbortController();

  logger?.info(
    `[ColdStartRacer] Racing cloud vs GPU (est ${ctx.estimatedReadyMs}ms, progress ${(progress * 100).toFixed(0)}%)`,
  );

  // Wrap each side so we can distinguish the winner and handle per-side errors.
  type Tagged = { result: T; source: 'cloud' | 'gpu' };

  const cloudPromise: Promise<Tagged> = cloudFn(cloudCtrl.signal).then(
    (result) => ({ result, source: 'cloud' as const }),
  );

  const gpuPromise: Promise<Tagged> = (async (): Promise<Tagged> => {
    const ready = await waitForGpuReady(
      ctx.gpuEndpoint,
      cfg.healthProbeTimeoutMs,
      gpuCtrl.signal,
    );
    if (!ready) {
      throw new Error('GPU health probe timed out');
    }
    const result = await gpuFn(ctx.gpuEndpoint, gpuCtrl.signal);
    return { result, source: 'gpu' as const };
  })();

  // Use a settlement-based race so that if one rejects, the other can still win.
  // We create "safe" versions that never reject — they resolve with either
  // { status: 'ok', value } or { status: 'err', error }.
  type Settled<V> =
    | { status: 'ok'; value: V }
    | { status: 'err'; error: unknown };

  const settled = <V>(p: Promise<V>): Promise<Settled<V>> =>
    p.then(
      (value): Settled<V> => ({ status: 'ok', value }),
      (error): Settled<V> => ({ status: 'err', error }),
    );

  const safeCloud = settled(cloudPromise);
  const safeGpu = settled(gpuPromise);

  // Race for the first settlement (success or error).
  const first = await Promise.race([safeCloud, safeGpu]);

  if (first.status === 'ok') {
    // Winner resolved successfully — abort loser.
    const winner = first.value;
    if (winner.source === 'cloud') {
      gpuCtrl.abort();
      logger?.info('[ColdStartRacer] Cloud won the race');
    } else {
      cloudCtrl.abort();
      logger?.info('[ColdStartRacer] GPU won the race');
    }
    return winner;
  }

  // First to settle was an error. Wait for the other to see if it succeeds.
  // Determine which one errored first — we need to wait for the other.
  // Since Promise.race returns the first settlement, we need to figure out
  // which promise settled first. We do this by checking if safeCloud or safeGpu
  // has already resolved.

  // Wait for both to settle.
  const [cloudResult, gpuResult] = await Promise.all([safeCloud, safeGpu]);

  // If one succeeded, use it and abort the other.
  if (cloudResult.status === 'ok' && gpuResult.status === 'ok') {
    // Both succeeded — shouldn't happen since first was an error, but handle defensively.
    gpuCtrl.abort();
    return cloudResult.value;
  }

  if (cloudResult.status === 'ok') {
    gpuCtrl.abort();
    logger?.info('[ColdStartRacer] GPU errored, cloud result used');
    return cloudResult.value;
  }

  if (gpuResult.status === 'ok') {
    cloudCtrl.abort();
    logger?.info('[ColdStartRacer] Cloud errored, GPU result used');
    return gpuResult.value;
  }

  // Both failed — throw the cloud error (more likely to be actionable).
  logger?.info('[ColdStartRacer] Both cloud and GPU errored');
  throw cloudResult.error;
}
