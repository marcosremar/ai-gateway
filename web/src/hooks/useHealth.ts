'use client';

import { useState, useEffect, useCallback } from 'react';
import { getHealth, type HealthResponse } from '@/lib/gateway';

export function useHealth(intervalMs = 30000) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getHealth();
      setHealth(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gateway unavailable');
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { health, error, refresh };
}
