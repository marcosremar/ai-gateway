/**
 * useGatewayWs — React hook for real-time GPU status + readiness events
 *
 * Connects to the gateway WebSocket (port 4001) and dispatches events
 * to subscribers. Auto-reconnects with exponential backoff.
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export interface GpuStatusEvent {
  type: 'gpu:status';
  gpuStatus: 'ready' | 'offline' | 'booting' | 'error';
  tier: 'gpu' | 'cloud';
  reason: string;
  endpoint: string | null;
  gpuType: string | null;
  modelWarmth: { stt: boolean; llm: boolean; tts: boolean };
  pipelineRouting: { stt: string; llm: string; tts: string; mode: string } | null;
  readiness: { phase: string; shadowRuns: number };
}

export interface GpuReadinessEvent {
  type: 'gpu:readiness';
  stage: 'stt' | 'llm' | 'tts' | 'all';
  phase: string;
  run?: number;
  totalRuns?: number;
  latencyMs?: number;
  bestLatencyMs?: number;
  targetMs?: number;
  passed?: boolean;
  runsUsed?: number;
  shadowCompletedRuns?: number;
  shadowTotalRuns?: number;
  attempts?: number;
  maxAttempts?: number;
  retryInMs?: number;
  error?: string;
}

export type GatewayWsEvent = GpuStatusEvent | GpuReadinessEvent | { type: string; [k: string]: unknown };

export interface GatewayWsState {
  connected: boolean;
  lastEvent: GatewayWsEvent | null;
  gpuStatus: GpuStatusEvent | null;
  readinessPhase: string;
  /** Ordered list of phase transitions with timestamps */
  transitions: Array<{ phase: string; stage: string; ts: number; detail?: string }>;
  /** Current benchmark progress per stage */
  benchmarkProgress: Record<string, { run: number; totalRuns: number; bestMs: number | null; targetMs: number; passed?: boolean }>;
  /** Shadow mode progress */
  shadowProgress: { completed: number; total: number } | null;
}

const INITIAL_STATE: GatewayWsState = {
  connected: false,
  lastEvent: null,
  gpuStatus: null,
  readinessPhase: 'idle',
  transitions: [],
  benchmarkProgress: {},
  shadowProgress: null,
};

export function useGatewayWs(): GatewayWsState {
  const [state, setState] = useState<GatewayWsState>(INITIAL_STATE);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (typeof window === 'undefined') return;

    const host = window.location.hostname;
    // In dev mode (Next.js on 3000), connect to gateway WS on 4001.
    // In production, WS is location.port + 1.
    const locationPort = parseInt(window.location.port || '4000', 10);
    const port = locationPort === 3000 ? 4001 : locationPort + 1;
    const url = `ws://${host}:${port}/`;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        retryRef.current = 0;
        setState(s => ({ ...s, connected: true }));
      };

      ws.onmessage = (e) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(e.data as string) as GatewayWsEvent;
          setState(s => {
            const next = { ...s, lastEvent: msg };

            if (msg.type === 'gpu:status') {
              const evt = msg as GpuStatusEvent;
              next.gpuStatus = evt;
              next.readinessPhase = evt.readiness?.phase || 'idle';
              // Record transition
              next.transitions = [...s.transitions, {
                phase: evt.readiness?.phase || evt.gpuStatus,
                stage: 'all',
                ts: Date.now(),
                detail: evt.reason,
              }].slice(-50); // keep last 50
            }

            if (msg.type === 'gpu:readiness') {
              const evt = msg as GpuReadinessEvent;
              next.readinessPhase = evt.phase;

              // Record phase transitions (not every benchmark run)
              const lastTransition = s.transitions[s.transitions.length - 1];
              if (!lastTransition || lastTransition.phase !== evt.phase || lastTransition.stage !== evt.stage) {
                next.transitions = [...s.transitions, {
                  phase: evt.phase,
                  stage: evt.stage,
                  ts: Date.now(),
                  detail: evt.error || (evt.passed != null ? (evt.passed ? 'passed' : 'failed') : undefined),
                }].slice(-50);
              }

              // Update benchmark progress
              if (evt.phase === 'benchmarking' && evt.run != null && evt.stage !== 'all') {
                next.benchmarkProgress = {
                  ...s.benchmarkProgress,
                  [evt.stage]: {
                    run: evt.run,
                    totalRuns: evt.totalRuns || 0,
                    bestMs: evt.bestLatencyMs ?? null,
                    targetMs: evt.targetMs || 0,
                    passed: evt.passed,
                  },
                };
              }

              // Stage complete
              if ((evt.phase === 'ready' || evt.phase === 'failed') && evt.stage !== 'all') {
                next.benchmarkProgress = {
                  ...s.benchmarkProgress,
                  [evt.stage]: {
                    run: evt.runsUsed || 0,
                    totalRuns: evt.runsUsed || 0,
                    bestMs: evt.bestLatencyMs ?? null,
                    targetMs: evt.targetMs || 0,
                    passed: evt.passed,
                  },
                };
              }

              // Shadow progress
              if (evt.phase === 'shadow') {
                next.shadowProgress = {
                  completed: evt.shadowCompletedRuns ?? 0,
                  total: evt.shadowTotalRuns ?? 5,
                };
              }

              // Clear shadow on production/condemned
              if (evt.phase === 'condemned' || evt.phase === 'auto-recovery') {
                next.shadowProgress = null;
              }
            }

            return next;
          });
        } catch { /* ignore non-JSON */ }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setState(s => ({ ...s, connected: false }));
        wsRef.current = null;
        // Reconnect with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30000);
        retryRef.current++;
        setTimeout(connect, delay);
      };

      ws.onerror = () => { ws.close(); };
    } catch {
      // Connection failed — retry
      const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30000);
      retryRef.current++;
      setTimeout(connect, delay);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return state;
}
