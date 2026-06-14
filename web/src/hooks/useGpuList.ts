'use client';

import { useState, useCallback } from 'react';
import { getGpuList, type GpuInstanceItem } from '@/lib/gateway';
import { usePolling } from './polling';

export function useGpuList(active = true, intervalMs = 10000) {
  const [instances, setInstances] = useState<GpuInstanceItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getGpuList();
      setInstances(data.instances);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch GPU list');
    }
  }, []);

  // Visibility-aware: pauses while the tab is hidden (#940).
  usePolling(refresh, intervalMs, active);

  return { instances, error, refresh };
}
