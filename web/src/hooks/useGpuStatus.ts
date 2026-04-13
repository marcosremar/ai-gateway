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
  const prevStatusRef = useRef<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const data = await getGpuStatus();
      setGpu(prev => {
        // Detect status change — the component will re-render automatically
        // via setState, and the interval adjusts below based on current status
        if (prev?.status !== data.status) {
          prevStatusRef.current = prev?.status;
        }
        return data;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch GPU status');
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();

    // Use faster polling during active transitions (deploy, boot, benchmark)
    const currentStatus = gpu?.status || gpu?.step;
    const isTransitioning = currentStatus != null && ACTIVE_STATUSES.has(currentStatus);
    const effectiveInterval = isTransitioning ? FAST_INTERVAL_MS : intervalMs;

    const id = setInterval(refresh, effectiveInterval);
    return () => clearInterval(id);
  }, [active, refresh, intervalMs, gpu?.status, gpu?.step]);

  return { gpu, error, refresh };
}
