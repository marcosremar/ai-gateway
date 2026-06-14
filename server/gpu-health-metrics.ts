// ── GPU Health Metrics — parse /health payload (temp, util, memory) ─────────
// Pure parsing + deployState update. Emits warnings for thermal throttling,
// idle GPU (no utilization), and near-OOM memory usage.

import { createLogger } from '../src/logger';
import { deployState, setDeployState } from './state';

const log = createLogger('gpu-deploy');

export const GPU_MONITOR_INTERVAL_MS = 30_000; // health check every 30s

/**
 * #247 — load-adaptive probe interval, both directions.
 *
 * The monitor's base interval (30s) only ever slows *down* while idle (to
 * 60s). It never speeds up around a known cold-start (when we want fast
 * feedback) nor slows further for a long-stable pod (to cut probe cost). This
 * pure helper returns the interval to use for the next probe:
 *   - booting / just-resumed  → faster (base/2, floored at `minMs`)
 *   - idle (no recent req)    → slower (grows toward `maxMs`)
 *   - long stable             → coast at `maxMs`
 *
 * Exported separately so the cadence policy is unit-testable without a live
 * loop; the loop can adopt it incrementally.
 *
 * @param baseMs    Base interval (GPU_MONITOR_INTERVAL_MS).
 * @param idleMs    Time since last request (0 = active).
 * @param isBooting Pod is booting / warming up (wants fast feedback).
 * @param minMs     Lower bound (default 10s).
 * @param maxMs     Upper bound (default 120s).
 */
export function adaptiveProbeInterval(
  baseMs: number,
  idleMs: number,
  isBooting: boolean,
  minMs = 10_000,
  maxMs = 120_000,
): number {
  if (isBooting) return Math.max(minMs, Math.round(baseMs / 2));
  // Stable & active → base. Idle → grow toward maxMs proportional to idle time.
  if (idleMs <= 60_000) return baseMs;
  if (idleMs <= 5 * 60_000) return Math.min(maxMs, baseMs * 2);
  return maxMs; // long idle / long stable — coast at the cap to cut probe cost
}

/** Track consecutive zero-utilization probes to detect idle GPU (5+ min at 0% = warning). */
let consecutiveZeroUtilProbes = 0;
let zeroUtilWarned = false; // one-shot guard so the warning fires reliably even if the counter jumps
const ZERO_UTIL_WARNING_THRESHOLD = 10; // 10 probes * 30s = 5 min

/**
 * Parse GPU hardware metrics from the /health response and store in deployState.
 * Logs warnings for thermal throttling (>85C), idle GPU (0% util for 5+ min),
 * and near-OOM memory usage (>95%).
 */
export function parseAndStoreGpuMetrics(data: Record<string, unknown>): void {
  const temp = typeof data.gpu_temp_c === 'number' ? data.gpu_temp_c
    : typeof data.gpu_temperature === 'number' ? data.gpu_temperature
    : typeof data.temperature === 'number' ? data.temperature : 0;

  const util = typeof data.gpu_util_pct === 'number' ? data.gpu_util_pct
    : typeof data.gpu_utilization === 'number' ? data.gpu_utilization
    : typeof data.utilization === 'number' ? data.utilization : -1;

  const memUsed = typeof data.gpu_mem_used_gb === 'number' ? data.gpu_mem_used_gb
    : typeof data.gpu_memory_used === 'number' ? data.gpu_memory_used
    : typeof data.vram_used_gb === 'number' ? data.vram_used_gb : 0;

  const memTotal = typeof data.gpu_mem_total_gb === 'number' ? data.gpu_mem_total_gb
    : typeof data.gpu_memory_total === 'number' ? data.gpu_memory_total
    : typeof data.vram_total_gb === 'number' ? data.vram_total_gb : 0;

  // Only update state if we got at least one metric
  if (temp > 0 || util >= 0 || memUsed > 0 || memTotal > 0) {
    setDeployState({
      gpuTemp: temp,
      gpuUtil: util,
      gpuMemUsed: memUsed,
      gpuMemTotal: memTotal,
    });
  }

  // Thermal warning: >85C indicates throttling risk
  if (temp > 85) {
    log.warn(`[gpu] HIGH TEMPERATURE: ${temp}C — GPU may be thermal throttling`);
    setDeployState({ alert: `GPU temperature high: ${temp}C (throttling risk above 85C)` });
  }

  // Idle GPU warning: 0% utilization for 5+ minutes (10 consecutive probes at 30s interval).
  // Use `>=` + a one-shot flag so the warning is not silently skipped if the
  // probe counter ever jumps past the threshold, and still fires only once per
  // sustained-idle window (reset when utilization resumes).
  if (util === 0) {
    consecutiveZeroUtilProbes++;
    if (consecutiveZeroUtilProbes >= ZERO_UTIL_WARNING_THRESHOLD && !zeroUtilWarned) {
      zeroUtilWarned = true;
      log.warn(`[gpu] GPU utilization 0% for ~${Math.round(ZERO_UTIL_WARNING_THRESHOLD * GPU_MONITOR_INTERVAL_MS / 60_000)}min — GPU idle (wasting compute)`);
    }
  } else if (util > 0) {
    consecutiveZeroUtilProbes = 0;
    zeroUtilWarned = false;
  }

  // Near-OOM warning: memory usage >95%
  if (memTotal > 0 && memUsed > 0) {
    const memPct = (memUsed / memTotal) * 100;
    if (memPct > 95) {
      log.warn(`[gpu] HIGH MEMORY: ${memUsed.toFixed(1)}/${memTotal.toFixed(1)}GB (${memPct.toFixed(0)}%) — OOM risk`);
      setDeployState({ alert: `GPU memory critical: ${memUsed.toFixed(1)}/${memTotal.toFixed(1)}GB (${memPct.toFixed(0)}%)` });
    }
  }
}
