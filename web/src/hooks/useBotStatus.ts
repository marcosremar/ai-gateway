'use client';

import { useState, useCallback } from 'react';
import { getBotStatus, type BotStatusResponse } from '@/lib/gateway';
import { usePolling } from './polling';

export function useBotStatus(active = true, intervalMs = 5000) {
  const [bot, setBot] = useState<BotStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getBotStatus();
      setBot(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch bot status');
    }
  }, []);

  // Visibility-aware: pauses while the tab is hidden (#940).
  usePolling(refresh, intervalMs, active);

  return { bot, error, refresh };
}
