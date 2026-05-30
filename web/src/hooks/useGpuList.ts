'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getGpuList, type GpuInstanceItem } from '@/lib/gateway';

export function useGpuList(active = true, intervalMs = 10000) {
  const [instances, setInstances] = useState<GpuInstanceItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getGpuList();
      if (!mountedRef.current) return;
      setInstances(data.instances);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to fetch GPU list');
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    mountedRef.current = true;
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [active, refresh, intervalMs]);

  return { instances, error, refresh };
}
