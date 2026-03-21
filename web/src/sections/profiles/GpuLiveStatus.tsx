'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, Check, X, AlertTriangle, Clock, Zap, Activity } from 'lucide-react';
import { getGpuStatus, getReadinessStatus, type GpuStatusResponse, type ReadinessStatusResponse } from '@/lib/gateway';
import { useGatewayWs, type GatewayWsState } from '@/hooks/useGatewayWs';

/* ── Phase config ── */

const PHASE_META: Record<string, { color: string; label: string; icon: typeof Loader2 }> = {
  // Pre-deploy
  idle:             { color: '#6b7280', label: 'Offline',         icon: Clock },
  offline:          { color: '#6b7280', label: 'Offline',         icon: Clock },
  searching:        { color: '#a78bfa', label: 'Searching GPU',   icon: Loader2 },
  searching_offers: { color: '#a78bfa', label: 'Searching',       icon: Loader2 },
  no_offers:        { color: '#f59e0b', label: 'No GPUs Found',   icon: AlertTriangle },
  // Deploy phases
  queued:           { color: '#a78bfa', label: 'Queued',          icon: Clock },
  creating:         { color: '#38bdf8', label: 'Creating',        icon: Loader2 },
  creating_pod:     { color: '#38bdf8', label: 'Creating Pod',    icon: Loader2 },
  installing:       { color: '#38bdf8', label: 'Pulling Image',   icon: Loader2 },
  pulling_image:    { color: '#38bdf8', label: 'Pulling Image',   icon: Loader2 },
  starting_container: { color: '#38bdf8', label: 'Starting',      icon: Loader2 },
  booting:          { color: '#38bdf8', label: 'Booting',         icon: Loader2 },
  waiting_health:   { color: '#a78bfa', label: 'Loading Models',  icon: Loader2 },
  // Granular model loading
  downloading_models: { color: '#a78bfa', label: 'Downloading',   icon: Loader2 },
  loading_stt:      { color: '#38bdf8', label: 'Loading STT',     icon: Loader2 },
  loading_llm:      { color: '#a78bfa', label: 'Loading LLM',     icon: Loader2 },
  loading_tts:      { color: '#fbbf24', label: 'Loading TTS',     icon: Loader2 },
  compiling_tts:    { color: '#fbbf24', label: 'Compiling TTS',   icon: Loader2 },
  // Readiness
  warming:          { color: '#a78bfa', label: 'Warming Models',  icon: Loader2 },
  benchmarking:     { color: '#38bdf8', label: 'Benchmarking',    icon: Activity },
  shadow:           { color: '#a78bfa', label: 'Shadow Mode',     icon: Activity },
  'fast-tracked':   { color: '#10b981', label: 'Fast-Tracked',    icon: Zap },
  // Production
  ready:            { color: '#10b981', label: 'Ready',           icon: Check },
  production:       { color: '#10b981', label: 'Production',      icon: Check },
  // Degradation
  degraded:         { color: '#f59e0b', label: 'Degraded',        icon: AlertTriangle },
  repechage:        { color: '#f97316', label: 'Repechage',       icon: Loader2 },
  failed:           { color: '#ef4444', label: 'Failed',          icon: X },
  condemned:        { color: '#ef4444', label: 'Condemned',       icon: X },
  'auto-recovery':  { color: '#06b6d4', label: 'Auto-Recovery',   icon: Zap },
  draining:         { color: '#a78bfa', label: 'Draining',        icon: Loader2 },
  error:            { color: '#ef4444', label: 'Error',           icon: X },
};

function phaseMeta(phase: string) {
  return PHASE_META[phase] || { color: '#6b7280', label: phase, icon: Clock };
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/* ── Deploy Sub-Steps Bar ── */

const DEPLOY_STEPS = ['searching_offers', 'queued', 'creating_pod', 'pulling_image', 'starting_container', 'downloading_models', 'benchmarking', 'shadow', 'ready'];
const DEPLOY_STEP_LABELS: Record<string, string> = {
  searching_offers: 'Search', queued: 'Queue', creating_pod: 'Create', pulling_image: 'Pull',
  starting_container: 'Boot', downloading_models: 'Models', benchmarking: 'Bench', shadow: 'Shadow', ready: 'Ready',
};
// Map granular model steps to the same position in the progress bar
const STEP_ALIASES: Record<string, string> = {
  loading_stt: 'downloading_models', loading_llm: 'downloading_models',
  loading_tts: 'downloading_models', compiling_tts: 'downloading_models',
  waiting_health: 'downloading_models', no_offers: 'searching_offers',
};

function DeployProgressBar({ currentStep, gpuType, elapsed }: { currentStep: string; gpuType?: string; elapsed?: number }) {
  const resolvedStep = STEP_ALIASES[currentStep] || currentStep;
  const stepIdx = DEPLOY_STEPS.indexOf(resolvedStep);

  return (
    <div>
      <div className="flex items-center gap-1 mb-1">
        {gpuType && <span className="text-[9px] font-semibold" style={{ color: '#a78bfa' }}>{gpuType}</span>}
        {elapsed != null && <span className="text-[9px] ml-auto font-mono" style={{ color: 'var(--color-text-muted)' }}>{formatElapsed(elapsed)}</span>}
      </div>
      <div className="flex rounded overflow-hidden" style={{ height: 6 }}>
        {DEPLOY_STEPS.map((step, i) => {
          const isActive = i === stepIdx;
          const isDone = i < stepIdx;
          const color = isDone ? '#10b981' : isActive ? '#38bdf8' : 'var(--color-border)';
          return (
            <div key={step} className="flex-1" style={{ background: color, opacity: isActive ? 1 : isDone ? 0.7 : 0.3 }} />
          );
        })}
      </div>
      <div className="flex mt-0.5">
        {DEPLOY_STEPS.map((step, i) => (
          <div key={step} className="flex-1 text-center">
            <span className="text-[7px]" style={{ color: i === stepIdx ? '#38bdf8' : i < stepIdx ? '#10b981' : 'var(--color-text-muted)', fontWeight: i === stepIdx ? 700 : 400 }}>
              {DEPLOY_STEP_LABELS[step]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Benchmark Progress ── */

function BenchmarkProgress({ progress }: { progress: GatewayWsState['benchmarkProgress'] }) {
  const stages = ['stt', 'llm', 'tts'] as const;
  const colors = { stt: '#38bdf8', llm: '#a78bfa', tts: '#fbbf24' };

  return (
    <div className="grid grid-cols-3 gap-1.5">
      {stages.map(stage => {
        const p = progress[stage];
        if (!p) return (
          <div key={stage} className="rounded border p-1.5 text-center" style={{ borderColor: 'var(--color-border)', opacity: 0.4 }}>
            <span className="text-[8px] font-bold uppercase" style={{ color: colors[stage] }}>{stage}</span>
            <div className="text-[9px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>waiting</div>
          </div>
        );
        const pct = p.totalRuns > 0 ? Math.round((p.run / p.totalRuns) * 100) : 0;
        return (
          <div key={stage} className="rounded border p-1.5" style={{ borderColor: `color-mix(in srgb, ${colors[stage]} 30%, var(--color-border))` }}>
            <div className="flex items-center justify-between">
              <span className="text-[8px] font-bold uppercase" style={{ color: colors[stage] }}>{stage}</span>
              {p.passed === true && <Check className="w-2.5 h-2.5" style={{ color: '#10b981' }} />}
              {p.passed === false && <X className="w-2.5 h-2.5" style={{ color: '#ef4444' }} />}
            </div>
            <div className="w-full rounded-full mt-1" style={{ height: 3, background: 'var(--color-border)' }}>
              <div className="rounded-full h-full transition-all" style={{ width: `${pct}%`, background: colors[stage] }} />
            </div>
            <div className="flex justify-between mt-0.5">
              <span className="text-[8px] font-mono" style={{ color: 'var(--color-text-muted)' }}>{p.run}/{p.totalRuns}</span>
              {p.bestMs != null && (
                <span className="text-[8px] font-mono" style={{ color: p.bestMs <= p.targetMs ? '#10b981' : '#ef4444' }}>
                  {Math.round(p.bestMs)}ms
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Shadow Progress ── */

function ShadowProgress({ progress }: { progress: { completed: number; total: number } }) {
  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <Activity className="w-3 h-3" style={{ color: '#a78bfa' }} />
      <div className="flex-1">
        <div className="w-full rounded-full" style={{ height: 4, background: 'var(--color-border)' }}>
          <div className="rounded-full h-full transition-all" style={{ width: `${pct}%`, background: '#a78bfa' }} />
        </div>
      </div>
      <span className="text-[9px] font-mono" style={{ color: '#a78bfa' }}>{progress.completed}/{progress.total}</span>
    </div>
  );
}

/* ── Transition Timeline ── */

function TransitionTimeline({ transitions }: { transitions: GatewayWsState['transitions'] }) {
  if (transitions.length === 0) return null;
  const recent = transitions.slice(-8);

  return (
    <div className="space-y-0.5">
      {recent.map((t, i) => {
        const meta = phaseMeta(t.phase);
        const ago = Date.now() - t.ts;
        return (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: meta.color }} />
            <span className="text-[10px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
            {t.stage !== 'all' && <span className="text-[9px] font-medium uppercase" style={{ color: 'var(--color-text-muted)' }}>{t.stage}</span>}
            {t.detail && <span className="text-[9px] truncate flex-1" style={{ color: 'var(--color-text-muted)' }}>— {t.detail}</span>}
            <span className="text-[9px] font-mono ml-auto flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{formatElapsed(ago)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Main Component ── */

export function GpuLiveStatus() {
  const ws = useGatewayWs();
  const [gpuStatus, setGpuStatus] = useState<GpuStatusResponse | null>(null);
  const [readiness, setReadiness] = useState<ReadinessStatusResponse | null>(null);

  // Poll HTTP as fallback (slower, for initial load + WS reconnection gaps)
  useEffect(() => {
    const poll = () => {
      getGpuStatus().then(setGpuStatus).catch(() => {});
      getReadinessStatus().then(setReadiness).catch(() => {});
    };
    poll();
    const interval = setInterval(poll, ws.connected ? 15_000 : 5_000);
    return () => clearInterval(interval);
  }, [ws.connected]);

  // Derive current phase from WS or HTTP
  const currentPhase = ws.readinessPhase !== 'idle' ? ws.readinessPhase
    : gpuStatus?.status === 'ready' ? 'ready'
    : gpuStatus?.status || 'idle';

  const meta = phaseMeta(currentPhase);
  const Icon = meta.icon;
  const isActive = !['idle', 'offline', 'error', 'ready', 'production'].includes(currentPhase);
  const elapsed = gpuStatus?.elapsedSec ? gpuStatus.elapsedSec * 1000 : undefined;

  // Deploy sub-step
  const deployStep = gpuStatus?.status === 'ready' ? 'ready'
    : (gpuStatus as Record<string, unknown>)?.step as string || currentPhase;
  const showDeployBar = ['searching', 'queued', 'creating', 'booting', 'installing'].includes(gpuStatus?.status || '') ||
    ['searching_offers', 'no_offers', 'queued', 'creating_pod', 'pulling_image', 'starting_container', 'booting',
     'waiting_health', 'downloading_models', 'loading_stt', 'loading_llm', 'loading_tts', 'compiling_tts'].includes(deployStep);

  return (
    <div className="space-y-3">
      {/* Current status badge */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
          style={{ background: `color-mix(in srgb, ${meta.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${meta.color} 25%, transparent)` }}>
          <Icon className={`w-4 h-4 ${isActive ? 'animate-spin' : ''}`} style={{ color: meta.color, animation: isActive && Icon === Loader2 ? undefined : 'none' }} />
          <span className="text-xs font-bold uppercase tracking-wider" style={{ color: meta.color }}>
            {meta.label}
          </span>
        </div>
        {gpuStatus?.gpuType && (
          <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-muted)' }}>{gpuStatus.gpuType}</span>
        )}
        {elapsed != null && elapsed > 0 && (
          <span className="text-[10px] font-mono ml-auto" style={{ color: 'var(--color-text-muted)' }}>{formatElapsed(elapsed)}</span>
        )}
        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${ws.connected ? 'bg-emerald-500' : 'bg-red-500'}`}
          title={ws.connected ? 'WebSocket connected' : 'WebSocket disconnected (using polling)'} />
      </div>

      {/* Deploy progress bar */}
      {showDeployBar && (
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, #38bdf8 3%, transparent)' }}>
          <DeployProgressBar currentStep={deployStep} gpuType={gpuStatus?.gpuType || undefined} elapsed={elapsed} />
        </div>
      )}

      {/* Benchmark progress */}
      {Object.keys(ws.benchmarkProgress).length > 0 && currentPhase === 'benchmarking' && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Benchmark Progress</p>
          <BenchmarkProgress progress={ws.benchmarkProgress} />
        </div>
      )}

      {/* Shadow progress */}
      {ws.shadowProgress && currentPhase === 'shadow' && (
        <div className="rounded-lg border p-3" style={{ borderColor: 'color-mix(in srgb, #a78bfa 25%, var(--color-border))' }}>
          <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: '#a78bfa' }}>Shadow Validation</p>
          <ShadowProgress progress={ws.shadowProgress} />
        </div>
      )}

      {/* Per-service status (separated from deploy state) */}
      {readiness && currentPhase !== 'idle' && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Service Status</p>
          <div className="grid grid-cols-3 gap-1.5">
            {(['stt', 'llm', 'tts'] as const).map(stage => {
              const colors = { stt: '#38bdf8', llm: '#a78bfa', tts: '#fbbf24' };
              const labels = { stt: 'STT', llm: 'LLM', tts: 'TTS' };
              const rs = (readiness as any)?.readinessState?.[stage] || {};
              const phase = rs.phase || 'idle';
              const meta = phaseMeta(phase);
              const route = (gpuStatus?.pipelineRouting as Record<string, string>)?.[stage];
              const detail = rs.loadDetail || '';
              const best = rs.bestLatencyMs;
              const Icon = meta.icon;
              return (
                <div key={stage} className="rounded-lg border p-2"
                  style={{ borderColor: `color-mix(in srgb, ${colors[stage]} 25%, var(--color-border))`, background: `color-mix(in srgb, ${colors[stage]} 4%, transparent)` }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[10px] font-bold uppercase" style={{ color: colors[stage] }}>{labels[stage]}</span>
                    <span className="ml-auto text-[8px] font-medium px-1.5 py-0.5 rounded"
                      style={{ background: `color-mix(in srgb, ${meta.color} 15%, transparent)`, color: meta.color }}>
                      {meta.label}
                    </span>
                  </div>
                  {detail && <p className="text-[8px] truncate" style={{ color: 'var(--color-text-muted)' }}>{detail}</p>}
                  <div className="flex items-center justify-between mt-1">
                    {best != null && <span className="text-[8px] font-mono" style={{ color: meta.color }}>{Math.round(best)}ms</span>}
                    {route && (
                      <span className="text-[7px] font-bold uppercase" style={{ color: route === 'gpu' ? colors[stage] : 'var(--color-text-muted)' }}>
                        {route === 'gpu' ? 'GPU' : 'Cloud'}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Pipeline routing (compact — only when no readiness data) */}
      {gpuStatus?.pipelineRouting && !readiness && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Pipeline Routing</p>
          <div className="flex gap-2">
            {(['stt', 'llm', 'tts'] as const).map(stage => {
              const route = (gpuStatus.pipelineRouting as Record<string, string>)?.[stage];
              const isGpu = route === 'gpu';
              const colors = { stt: '#38bdf8', llm: '#a78bfa', tts: '#fbbf24' };
              return (
                <div key={stage} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[10px] font-bold uppercase"
                  style={{
                    background: `color-mix(in srgb, ${colors[stage]} ${isGpu ? 10 : 4}%, transparent)`,
                    borderColor: `color-mix(in srgb, ${colors[stage]} ${isGpu ? 25 : 10}%, var(--color-border))`,
                    color: isGpu ? colors[stage] : 'var(--color-text-muted)',
                  }}>
                  {stage}
                  <span className="text-[9px] font-medium normal-case">{isGpu ? 'GPU' : 'Cloud'}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Transition timeline */}
      {ws.transitions.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>
            Recent Transitions
          </p>
          <TransitionTimeline transitions={ws.transitions} />
        </div>
      )}
    </div>
  );
}
