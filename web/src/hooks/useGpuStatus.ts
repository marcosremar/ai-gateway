'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getGpuStatus, type GpuStatusResponse } from '@/lib/gateway';

/** Statuses that indicate an active transition — poll faster to show progress */
const ACTIVE_STATUSES = new Set(['booting', 'deploying', 'pulling', 'starting', 'benchmarking']);

/** Fast poll interval during active transitions (ms) */
const FAST_INTERVAL_MS = 2000;

export function useGpuStatus(active = true, intervalMs = 5000) {
  const [gpu, setGpu] = useState<GpuStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gpuRef = useRef<GpuStatusResponse | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getGpuStatus();
      if (!mountedRef.current) return;
      gpuRef.current = data;
      setGpu(data);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to fetch GPU status');
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    mountedRef.current = true;
    refresh();

    // Adaptive interval: fast during active transitions, normal otherwise.
    // Read latest status from ref to avoid recreating interval on every status change
    // (which would amplify request count during noisy boot transitions).
    const id = setInterval(() => {
      const currentStatus = gpuRef.current?.status;
      const isTransitioning = currentStatus != null && ACTIVE_STATUSES.has(currentStatus);
      // We only check status; effective interval is enforced by checking each tick
      // and skipping if not yet due. Simpler: always run refresh on the fast interval,
      // but skip alternate ticks when not transitioning.
      if (!isTransitioning) {
        // Skip ticks based on intervalMs/FAST_INTERVAL_MS ratio
        const skipFactor = Math.max(1, Math.round(intervalMs / FAST_INTERVAL_MS));
        if (Math.floor(Date.now() / FAST_INTERVAL_MS) % skipFactor !== 0) return;
      }
      refresh();
    }, FAST_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [active, refresh, intervalMs]);

  return { gpu, error, refresh };
}
