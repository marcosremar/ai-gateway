'use client';

import { useState, useEffect, useCallback } from 'react';
import { getGpuList, type GpuInstanceItem } from '@/lib/gateway';

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

  useEffect(() => {
    if (!active) return;
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [active, refresh, intervalMs]);

  return { instances, error, refresh };
}
