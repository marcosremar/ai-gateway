'use client';

import { useState, useEffect, useCallback } from 'react';
import { getGpuStatus, type GpuStatusResponse } from '@/lib/gateway';

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
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [active, refresh, intervalMs]);

  return { gpu, error, refresh };
}
