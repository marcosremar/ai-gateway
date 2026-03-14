'use client';

import { createContext, useContext, ReactNode } from 'react';
import { useHealth } from './useHealth';
import type { HealthResponse } from '@/lib/gateway';

interface GatewayContextValue {
  health: HealthResponse | null;
  error: string | null;
  refresh: () => Promise<void>;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

export function GatewayProvider({ children }: { children: ReactNode }) {
  const { health, error, refresh } = useHealth(30000);
  return (
    <GatewayContext.Provider value={{ health, error, refresh }}>
      {children}
    </GatewayContext.Provider>
  );
}

export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) throw new Error('useGateway must be inside GatewayProvider');
  return ctx;
}
