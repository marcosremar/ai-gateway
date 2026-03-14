'use client';

import { useState, useEffect, useCallback } from 'react';
import { getBotStatus, type BotStatusResponse } from '@/lib/gateway';

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

  useEffect(() => {
    if (!active) return;
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [active, refresh, intervalMs]);

  return { bot, error, refresh };
}
