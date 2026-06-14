'use client';

import { useState, useCallback } from 'react';
import { getHealth, type HealthResponse } from '@/lib/gateway';
import { usePolling } from './polling';

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

  // Visibility-aware: pauses while the tab is hidden (#940).
  usePolling(refresh, intervalMs);

  return { health, error, refresh };
}
