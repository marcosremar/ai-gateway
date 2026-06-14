'use client';

import { useState, useEffect, useCallback } from 'react';
import { getGpuStatus, type GpuStatusResponse } from '@/lib/gateway';
import { shouldPoll, gpuPollInterval } from './polling-logic';

export function useGpuStatus(active = true, intervalMs = 5000) {
  const [gpu, setGpu] = useState<GpuStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getGpuStatus();
      setGpu(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch GPU status');
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();

    // Use faster polling during active transitions (deploy, boot, benchmark).
    const currentStatus = gpu?.status || gpu?.step;
    const effectiveInterval = gpuPollInterval(currentStatus, intervalMs);

    const tick = () => {
      // Skip ticks while the tab is hidden to stop background request churn (#940).
      const hidden = typeof document !== 'undefined' && document.hidden === true;
      if (shouldPoll(hidden)) refresh();
    };

    const id = setInterval(tick, effectiveInterval);
    return () => clearInterval(id);
  }, [active, refresh, intervalMs, gpu?.status, gpu?.step]);

  return { gpu, error, refresh };
}
