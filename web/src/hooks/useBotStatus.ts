'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getBotStatus, type BotStatusResponse } from '@/lib/gateway';

export function useBotStatus(active = true, intervalMs = 5000) {
  const [bot, setBot] = useState<BotStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getBotStatus();
      if (!mountedRef.current) return;
      setBot(data);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to fetch bot status');
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

  return { bot, error, refresh };
}
