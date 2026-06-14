'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getReadinessStatus, getGpuReadinessHistory, resetGpuReadiness, patchLatencySettings,
  type ReadinessStatusResponse, type GpuReadinessHistoryResponse, type ReadinessHistoryRun,
} from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, AlertBanner, StatusBadge, FormInput, SectionHeader } from '@/components/ui';
import { phaseColor, phaseBg, phaseVariant, phaseLabel as phaseLabel_, type ServicePhase as Phase } from '@/lib/phase-colors';
import { readinessPollInterval, READINESS_IDLE_INTERVAL_MS } from './readiness-logic';
import { RefreshCw, RotateCcw, Activity, AlertTriangle, ChevronDown, ChevronRight, CheckCircle2, XCircle, Mic, Brain, Volume2 } from 'lucide-react';

function PhaseBadge({ phase }: { phase: Phase }) {
  const dot = phase !== 'repechage';
  return <StatusBadge variant={phaseVariant(phase)} dot={dot}>{phaseLabel_(phase)}</StatusBadge>;
}

function p95Color(p95: number | null, target: number, multiplier: number): string {
  if (p95 === null) return 'var(--color-text-muted)';
  const threshold = target * multiplier;
  if (p95 <= target) return 'var(--color-emerald, #34d399)';
  if (p95 <= threshold) return 'var(--color-amber, #fbbf24)';
  return 'var(--color-red, #f87171)';
}

function p95BorderColor(p95: number | null, target: number, multiplier: number): string {
  if (p95 === null) return 'var(--color-border)';
  const threshold = target * multiplier;
  if (p95 <= target) return 'rgba(52, 211, 153, 0.5)';
  if (p95 <= threshold) return 'rgba(251, 191, 36, 0.5)';
  return 'rgba(248, 113, 113, 0.5)';
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  return `${Math.round(ms)}ms`;
}

function fmtAgo(ts: number): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ago`;
  if (m > 0) return `${m}m ago`;
  return `${s}s ago`;
}

// ── Quick Status Cell ──

const STAGE_META: Record<'stt' | 'llm' | 'tts', { label: string; icon: typeof Mic; shortLabel: string }> = {
  stt: { label: 'Speech-to-Text', icon: Mic, shortLabel: 'STT' },
  llm: { label: 'Language Model', icon: Brain, shortLabel: 'LLM' },
  tts: { label: 'Text-to-Speech', icon: Volume2, shortLabel: 'TTS' },
};

interface QuickStatusCellProps {
  stage: 'stt' | 'llm' | 'tts';
  phase: Phase;
  completedRuns: number;
  maxRuns: number;
}

function QuickStatusCell({ stage, phase, completedRuns, maxRuns }: QuickStatusCellProps) {
  const meta = STAGE_META[stage];
  const Icon = meta.icon;
  const color = phaseColor(phase);
  const bg = phaseBg(phase);
  const pct = phase === 'benchmarking' && maxRuns > 0 ? Math.round(completedRuns / maxRuns * 100) : null;

  return (
    <div className="flex-1 flex flex-col gap-1.5 px-4 py-3 rounded-xl border transition-all"
      style={{
        borderColor: phase !== 'idle' ? `color-mix(in srgb, ${color} 40%, var(--color-border))` : 'var(--color-border)',
        background: phase !== 'idle' ? bg : 'var(--color-surface-elevated)',
      }}>
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center"
          style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
          <Icon className="w-3.5 h-3.5" style={{ color }} />
        </div>
        <span className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>{meta.shortLabel}</span>
      </div>
      <PhaseBadge phase={phase} />
      {pct !== null && (
        <div className="space-y-1">
          <div className="h-1 rounded-full" style={{ background: 'var(--color-border)' }}>
            <div className="h-1 rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
          </div>
          <span className="text-[10px] font-mono" style={{ color: 'var(--color-text-muted)' }}>{completedRuns}/{maxRuns}</span>
        </div>
      )}
    </div>
  );
}

export function ReadinessSection() {
  const [status, setStatus] = useState<ReadinessStatusResponse | null>(null);
  const [history, setHistory] = useState<GpuReadinessHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);

  // Settings (local editable state)
  const [sttTargetMs, setSttTargetMs] = useState(800);
  const [llmTargetMs, setLlmTargetMs] = useState(2000);
  const [ttsTargetMs, setTtsTargetMs] = useState(1500);
  const [benchMaxRuns, setBenchMaxRuns] = useState(20);
  const [benchMarginPct, setBenchMarginPct] = useState(10);
  const [shadowRunsVal, setShadowRunsVal] = useState(5);
  const [p95Multiplier, setP95Multiplier] = useState(2.0);
  const [repechageMax, setRepechageMax] = useState(3);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // History row expand state
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const isActive = useRef(false);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        getReadinessStatus(),
        getGpuReadinessHistory(),
      ]);
      setStatus(s);
      setHistory(h);
      setError(null);

      // Sync settings from server (only when not dirty)
      if (!isActive.current) {
        setSttTargetMs(s.targets?.stt ?? 800);
        setLlmTargetMs(s.targets?.llm ?? 2000);
        setTtsTargetMs(s.targets?.tts ?? 1500);
        setP95Multiplier(s.p95DemotionMultiplier ?? 2);
        setRepechageMax(s.repechageMaxAttempts ?? 3);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Adaptive cadence: fast while a stage is transitioning / shadow mode runs,
  // otherwise idle. Held in a ref so flipping cadence doesn't tear down and
  // rebuild the interval on every phase change (#948).
  const desiredIntervalRef = useRef<number>(READINESS_IDLE_INTERVAL_MS);
  desiredIntervalRef.current = readinessPollInterval(status);

  useEffect(() => {
    load();
    // Self-rescheduling timeout: each tick re-reads the desired cadence from the
    // ref, so a 10s↔2s phase change is picked up on the next tick instead of
    // tearing down and rebuilding the effect (#948).
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        load();
        schedule();
      }, desiredIntervalRef.current);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [load]);

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      await patchLatencySettings({
        sttTargetLatencyMs: sttTargetMs,
        llmTargetLatencyMs: llmTargetMs,
        ttsTargetLatencyMs: ttsTargetMs,
        benchmarkMaxRuns: benchMaxRuns,
        benchmarkMarginPct: benchMarginPct,
        shadowRuns: shadowRunsVal,
        p95DemotionMultiplier: p95Multiplier,
        repechageMaxAttempts: repechageMax,
      });
      setSettingsDirty(false);
      isActive.current = false;
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await resetGpuReadiness();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  };

  const markDirty = () => { setSettingsDirty(true); isActive.current = true; };

  if (loading) return (
    <div className="p-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
      <div className="inline-flex items-center gap-2">
        <RefreshCw className="w-4 h-4 animate-spin" />
        <span>Loading readiness status...</span>
      </div>
    </div>
  );

  const stages = ['stt', 'llm', 'tts'] as const;

  return (
    <div className="space-y-6 p-6">
      <SectionHeader title="GPU Readiness" subtitle="Benchmark → shadow mode → production activation. GPU never handles real traffic until latency targets are proven." />

      {/* ── Quick Status Summary Strip ── */}
      {status && (
        <div className="flex gap-3">
          {stages.map(stage => (
            <QuickStatusCell
              key={stage}
              stage={stage}
              phase={status.readinessState[stage].phase as Phase}
              completedRuns={status.readinessState[stage].completedRuns}
              maxRuns={benchMaxRuns}
            />
          ))}
        </div>
      )}

      {/* ── Phase Lifecycle Diagram ── */}
      <Card>
        <CardHeader><span className="text-sm font-semibold">Service Phase Lifecycle</span></CardHeader>
        <CardBody>
          <div className="text-xs mb-4" style={{ color: 'var(--color-text-muted)' }}>
            Each GPU service (STT, LLM, TTS) transitions independently through these phases. Traffic is only routed to the GPU once a service reaches <strong style={{ color: '#10b981' }}>ready</strong>.
          </div>

          {/* Main happy path: idle → benchmarking → shadow → ready */}
          <div className="flex items-center gap-1 flex-wrap mb-3">
            {([
              { phase: 'idle',         color: '#71717a', label: 'idle',         desc: 'GPU not deployed or service not started' },
              null,
              { phase: 'benchmarking', color: '#fbbf24', label: 'benchmarking', desc: 'Sending test requests — must beat target latency' },
              null,
              { phase: 'shadow',       color: '#38bdf8', label: 'shadow',       desc: 'Dry-run alongside cloud — validates stability' },
              null,
              { phase: 'ready',        color: '#10b981', label: 'ready',        desc: 'Serving live traffic — P95 within target' },
            ] as const).map((item, i) => {
              if (item === null) return (
                <span key={i} className="text-base" style={{ color: 'var(--color-text-muted)' }}>→</span>
              );
              const isCurrentPhase = status && stages.some(s => status.readinessState[s].phase === item.phase);
              return (
                <div key={item.phase} className="relative flex flex-col gap-1 px-3 py-2 rounded-lg border min-w-[110px] transition-all"
                  style={{
                    borderColor: isCurrentPhase
                      ? item.color
                      : `color-mix(in srgb, ${item.color} 35%, var(--color-border))`,
                    background: isCurrentPhase
                      ? `color-mix(in srgb, ${item.color} 12%, var(--color-surface-elevated))`
                      : `color-mix(in srgb, ${item.color} 7%, var(--color-surface-elevated))`,
                    boxShadow: isCurrentPhase ? `0 0 0 1px ${item.color}40, 0 0 12px ${item.color}20` : undefined,
                  }}>
                  {isCurrentPhase && (
                    <span className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full border-2 animate-pulse"
                      style={{ background: item.color, borderColor: 'var(--color-surface)' }} />
                  )}
                  {item.phase === 'ready' && !isCurrentPhase && (
                    <CheckCircle2 className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5" style={{ color: '#10b981' }} />
                  )}
                  <span className="font-bold text-[11px]" style={{ color: item.color }}>{item.label}</span>
                  <span className="text-[10px] leading-tight" style={{ color: 'var(--color-text-muted)' }}>{item.desc}</span>
                </div>
              );
            })}
          </div>

          {/* Failure path */}
          <div className="flex items-start gap-3 flex-wrap pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <span className="text-[10px] font-semibold pt-2.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>failure paths</span>
            {([
              { phase: 'degraded',  color: '#f97316', label: 'degraded',  desc: 'Live P95 exceeded threshold — pulled from traffic, re-benchmarking' },
              null,
              { phase: 'repechage', color: '#a78bfa', label: 'repechage', desc: 'Benchmark failed — retrying every 2 min (up to max attempts)' },
              null,
              { phase: 'condemned', color: '#f87171', label: 'condemned', desc: 'Max retries exhausted — cloud handles all traffic until manual reset' },
            ] as const).map((item, i) => {
              if (item === null) return (
                <span key={i} className="text-base pt-2" style={{ color: 'var(--color-text-muted)' }}>→</span>
              );
              const isCurrentPhase = status && stages.some(s => status.readinessState[s].phase === item.phase);
              return (
                <div key={item.phase} className="relative flex flex-col gap-1 px-3 py-2 rounded-lg border min-w-[130px] transition-all"
                  style={{
                    borderColor: isCurrentPhase
                      ? item.color
                      : `color-mix(in srgb, ${item.color} 35%, var(--color-border))`,
                    background: isCurrentPhase
                      ? `color-mix(in srgb, ${item.color} 12%, var(--color-surface-elevated))`
                      : `color-mix(in srgb, ${item.color} 7%, var(--color-surface-elevated))`,
                    boxShadow: isCurrentPhase ? `0 0 0 1px ${item.color}40, 0 0 12px ${item.color}20` : undefined,
                  }}>
                  {isCurrentPhase && (
                    <span className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full border-2 animate-pulse"
                      style={{ background: item.color, borderColor: 'var(--color-surface)' }} />
                  )}
                  <span className="font-bold text-[11px]" style={{ color: item.color }}>{item.label}</span>
                  <span className="text-[10px] leading-tight" style={{ color: 'var(--color-text-muted)' }}>{item.desc}</span>
                </div>
              );
            })}
          </div>

          {/* Note about profile latency targets */}
          <div className="mt-3 pt-3 border-t text-[10px] leading-relaxed" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            <strong style={{ color: 'var(--color-text-secondary)' }}>Profile latency target:</strong>{' '}
            The active profile&apos;s <em>Latency</em> field (realtime / low / batch) sets the benchmark thresholds automatically —
            realtime uses STT&nbsp;300ms / LLM&nbsp;500ms / TTS&nbsp;300ms; low uses 800ms / 2s / 1.5s; batch accepts any latency.
            Switching profiles updates thresholds immediately and takes effect on the next benchmark cycle.
          </div>
        </CardBody>
      </Card>

      {error && <AlertBanner variant="error">{error}</AlertBanner>}

      {status?.readinessState.condemned && (
        <AlertBanner variant="error">GPU condemned — repechage attempts exhausted. All traffic routed to cloud. Re-run benchmark to retry.</AlertBanner>
      )}

      {/* ── Benchmark Settings ── */}
      <Card>
        <CardHeader><span className="text-sm font-semibold">Benchmark Settings</span></CardHeader>
        <CardBody>
          {/* How it works description */}
          <div className="mb-5 text-xs leading-relaxed p-3 rounded-lg border-l-2"
            style={{ background: 'var(--color-surface-elevated)', borderLeftColor: 'rgba(56, 189, 248, 0.5)', color: 'var(--color-text-muted)' }}>
            <strong style={{ color: 'var(--color-text-secondary)' }}>How it works:</strong>{' '}
            When a GPU pod boots, each service is benchmarked independently before handling real traffic.
            The GPU must hit at least one request below <em>target × (1 − margin%)</em> within Max Runs attempts.
            If all three pass, it enters <strong style={{ color: 'var(--color-text-secondary)' }}>shadow mode</strong> (dry-run alongside cloud).
            After Shadow Runs consecutive successes, the GPU goes live. Once live, P95 is monitored continuously —
            exceed target × Demotion Multiplier and the GPU is pulled from the pool.
          </div>

          {/* Basic settings — always visible */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>Target Latencies</span>
              <div className="flex-1 h-px" style={{ background: 'var(--color-border)' }} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <FormInput label="STT Target (ms)" type="number" value={sttTargetMs}
                hint="Max acceptable latency for speech-to-text. GPU must hit target × (1 − margin%) in at least one run."
                onChange={e => { setSttTargetMs(Number(e.target.value)); markDirty(); }} />
              <FormInput label="LLM Target (ms)" type="number" value={llmTargetMs}
                hint="Max acceptable latency for the LLM translation step."
                onChange={e => { setLlmTargetMs(Number(e.target.value)); markDirty(); }} />
              <FormInput label="TTS Target (ms)" type="number" value={ttsTargetMs}
                hint="Max acceptable time-to-first-audio for TTS synthesis."
                onChange={e => { setTtsTargetMs(Number(e.target.value)); markDirty(); }} />
            </div>
          </div>

          {/* Advanced settings — collapsible */}
          <div className="mt-5">
            <button
              onClick={() => setShowAdvanced(v => !v)}
              className="flex items-center gap-2 text-xs font-medium transition-colors hover:opacity-80 mb-3 w-full"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {showAdvanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <span>{showAdvanced ? 'Hide advanced settings' : 'Show advanced settings'}</span>
              <div className="flex-1 h-px ml-1" style={{ background: 'var(--color-border)' }} />
            </button>

            {showAdvanced && (
              <div className="space-y-4 pt-1">
                <div className="grid grid-cols-3 gap-4">
                  <FormInput label="Max Runs" type="number" value={benchMaxRuns}
                    hint="Benchmark requests sent per service. If none hit the target, repechage kicks in."
                    onChange={e => { setBenchMaxRuns(Number(e.target.value)); markDirty(); }} />
                  <FormInput label="Margin %" type="number" value={benchMarginPct}
                    hint="Safety buffer. 10% means the GPU must hit target × 0.9, not just target."
                    onChange={e => { setBenchMarginPct(Number(e.target.value)); markDirty(); }} />
                  <FormInput label="Shadow Runs" type="number" value={shadowRunsVal}
                    hint="After benchmark passes, run this many background requests while cloud still serves. All must succeed before GPU goes live."
                    onChange={e => { setShadowRunsVal(Number(e.target.value)); markDirty(); }} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormInput label="P95 Demotion Multiplier" type="number" step="0.1" value={p95Multiplier}
                    hint="Live P95 threshold = target × multiplier. Exceed it and the GPU is pulled from production. E.g. 2.0 → demote at 2× target."
                    onChange={e => { setP95Multiplier(Number(e.target.value)); markDirty(); }} />
                  <FormInput label="Max Repechage Attempts" type="number" value={repechageMax}
                    hint="How many times to retry a failed benchmark (every 2 min) before condemning the pod permanently."
                    onChange={e => { setRepechageMax(Number(e.target.value)); markDirty(); }} />
                </div>
              </div>
            )}
          </div>

          {settingsDirty && (
            <div className="mt-5 flex justify-end">
              <Button onClick={handleSaveSettings} disabled={savingSettings}>
                {savingSettings ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── Live Status ── */}
      {status && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Live Status</span>
              <div className="flex items-center gap-2">
                {status.gpuReadyForProduction
                  ? <StatusBadge variant="emerald" dot>Production</StatusBadge>
                  : status.gpuShadowMode
                    ? <StatusBadge variant="amber" dot>Shadow Mode</StatusBadge>
                    : <StatusBadge variant="gray" dot>Not Active</StatusBadge>
                }
              </div>
            </div>
          </CardHeader>
          <CardBody>
            <div className="space-y-2">
              {stages.map(stage => {
                const s = status.readinessState[stage];
                const meta = STAGE_META[stage];
                const Icon = meta.icon;
                const phase = s.phase as Phase;
                const color = phaseColor(phase);
                const maxRuns = benchMaxRuns;
                const pct = s.completedRuns > 0 ? Math.min(100, Math.round(s.completedRuns / maxRuns * 100)) : 0;
                return (
                  <div key={stage} className="flex items-center gap-4 px-4 py-3 rounded-xl border-l-4 transition-all"
                    style={{
                      borderLeftColor: color,
                      background: phaseBg(phase),
                      border: `1px solid color-mix(in srgb, ${color} 20%, var(--color-border))`,
                      borderLeft: `4px solid ${color}`,
                    }}>
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
                      <Icon className="w-4 h-4" style={{ color }} />
                    </div>
                    <span className="w-10 font-mono text-xs uppercase font-bold" style={{ color: 'var(--color-text-secondary)' }}>{stage}</span>
                    <PhaseBadge phase={phase} />
                    {/* Phase duration */}
                    {phase !== 'idle' && s.phaseStartedAt && (() => {
                      const elapsed = Date.now() - s.phaseStartedAt;
                      const sec = Math.floor(elapsed / 1000);
                      const dur = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
                      return <span className="text-[10px] font-mono" style={{ color: 'var(--color-text-muted)' }}>{dur}</span>;
                    })()}
                    {/* Load detail during download/load/compile */}
                    {(phase === 'downloading' || phase === 'loading' || phase === 'compiling') && s.loadDetail && (
                      <span className="text-[10px] truncate max-w-[180px]" style={{ color: 'var(--color-text-muted)' }}>{s.loadDetail}</span>
                    )}
                    {phase === 'benchmarking' && (
                      <div className="flex-1 flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full" style={{ background: 'var(--color-border)' }}>
                          <div className="h-1.5 rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
                        </div>
                        <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>{s.completedRuns}/{maxRuns}</span>
                      </div>
                    )}
                    <span className="text-xs font-mono ml-auto" style={{ color: 'var(--color-text-muted)' }}>
                      best: <span style={{ color: 'var(--color-text-secondary)' }}>{fmtMs(s.bestLatencyMs)}</span>
                      {' '}/ target: <span style={{ color: 'var(--color-text-secondary)' }}>{fmtMs(s.targetMs)}</span>
                    </span>
                  </div>
                );
              })}

              {status.readinessState.shadowPhase && (
                <div className="flex items-center gap-2 mt-2 pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
                  <Activity className="w-4 h-4" style={{ color: 'var(--color-amber, #fbbf24)' }} />
                  <span className="text-sm">Shadow mode: {status.readinessState.shadowCompletedRuns}/{shadowRunsVal} runs</span>
                </div>
              )}

              {status.readinessState.repechageAttempts > 0 && (
                <div className="flex items-center gap-2 mt-2 pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
                  <AlertTriangle className="w-4 h-4" style={{ color: 'var(--color-amber, #fbbf24)' }} />
                  <span className="text-sm">Repechage attempts: {status.readinessState.repechageAttempts}/{repechageMax}</span>
                </div>
              )}

              {/* Phase legend */}
              <div className="mt-3 pt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ borderTop: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                <span><span style={{ color: '#71717a' }}>●</span> Idle — waiting for pod</span>
                <span><span style={{ color: '#fbbf24' }}>●</span> Benchmarking — sending test requests</span>
                <span><span style={{ color: '#34d399' }}>●</span> Ready — passed benchmark</span>
                <span><span style={{ color: '#f97316' }}>●</span> Degraded — live P95 exceeded, re-benchmarking</span>
                <span><span style={{ color: '#a78bfa' }}>●</span> Repechage — retrying every 2 min</span>
                <span><span style={{ color: '#f87171' }}>●</span> Failed / Condemned</span>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── P95 Monitor ── */}
      {status && (
        <Card>
          <CardHeader>
            <div>
              <span className="text-sm font-semibold">Live P95 Monitor</span>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                Tracks real production latency. Green = within target. Yellow = approaching demotion threshold. Red = demoted back to cloud.
              </p>
            </div>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-3 gap-4">
              {stages.map(stage => {
                const p95 = status.perStageP95[stage];
                const target = status.targets[stage];
                const threshold = target * status.p95DemotionMultiplier;
                const color = p95Color(p95, target, status.p95DemotionMultiplier);
                const borderColor = p95BorderColor(p95, target, status.p95DemotionMultiplier);
                const Icon = STAGE_META[stage].icon;
                return (
                  <div key={stage} className="p-4 rounded-xl border transition-all"
                    style={{
                      background: 'var(--color-surface-elevated)',
                      borderColor,
                      borderTop: `3px solid ${borderColor}`,
                    }}>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-6 h-6 rounded-md flex items-center justify-center"
                        style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
                        <Icon className="w-3.5 h-3.5" style={{ color }} />
                      </div>
                      <span className="text-xs uppercase font-semibold font-mono" style={{ color: 'var(--color-text-muted)' }}>{stage}</span>
                    </div>
                    <div className="text-2xl font-mono font-bold mb-1" style={{ color }}>
                      {fmtMs(p95)}
                    </div>
                    <div className="text-[11px] mb-2 space-y-0.5" style={{ color: 'var(--color-text-muted)' }}>
                      <div>target: <span className="font-mono" style={{ color: 'var(--color-text-secondary)' }}>{target}ms</span></div>
                      <div>demote: <span className="font-mono" style={{ color: 'var(--color-text-secondary)' }}>{Math.round(threshold)}ms</span></div>
                    </div>
                    {p95 !== null && (
                      <div className="h-1.5 rounded-full" style={{ background: 'var(--color-border)' }}>
                        <div className="h-1.5 rounded-full transition-all" style={{
                          width: `${Math.min(100, Math.round(p95 / threshold * 100))}%`,
                          background: color,
                        }} />
                      </div>
                    )}
                    {/* P95 sparkline from latency samples */}
                    {(() => {
                      const samples = status.readinessState[stage].latencySamples;
                      if (!samples || samples.length < 2) return null;
                      const recent = samples.slice(-20);
                      const maxVal = Math.max(...recent, target);
                      const w = 120, h = 28;
                      const points = recent.map((v, i) => {
                        const x = (i / (recent.length - 1)) * (w - 2) + 1;
                        const y = maxVal > 0 ? h - (v / maxVal) * (h - 4) + 2 : h / 2;
                        return `${x},${y}`;
                      }).join(' ');
                      const targetY = maxVal > 0 ? h - (target / maxVal) * (h - 4) + 2 : h / 2;
                      return (
                        <svg width={w} height={h} className="mt-2 w-full" style={{ opacity: 0.8 }}>
                          {/* Target line */}
                          <line x1="0" y1={targetY} x2={w} y2={targetY} stroke="#34d399" strokeWidth="0.5" strokeDasharray="3,2" />
                          <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
                        </svg>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-4 mt-4 pt-3 border-t text-xs" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
              <span>Production: <span style={{ color: status.gpuReadyForProduction ? '#34d399' : 'var(--color-text-muted)' }}>{status.gpuReadyForProduction ? 'Active' : 'Inactive'}</span></span>
              <span>Shadow: <span style={{ color: status.gpuShadowMode ? '#fbbf24' : 'var(--color-text-muted)' }}>{status.gpuShadowMode ? 'Active' : 'Inactive'}</span></span>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Benchmark History ── */}
      {history && Object.keys(history.history).length > 0 && (
        <Card>
          <CardHeader><span className="text-sm font-semibold">Benchmark History</span></CardHeader>
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr style={{ color: 'var(--color-text-muted)' }}>
                    <th className="text-left py-2 px-3 rounded-tl-lg" style={{ background: 'var(--color-surface-elevated)' }}>Image : GPU</th>
                    <th className="text-left py-2 px-3" style={{ background: 'var(--color-surface-elevated)' }}>Stage</th>
                    <th className="text-center py-2 px-3" style={{ background: 'var(--color-surface-elevated)' }}>Result</th>
                    <th className="text-right py-2 px-3" style={{ background: 'var(--color-surface-elevated)' }}>Pass Rate</th>
                    <th className="text-right py-2 px-3" style={{ background: 'var(--color-surface-elevated)' }}>Avg (ms)</th>
                    <th className="text-right py-2 px-3 rounded-tr-lg" style={{ background: 'var(--color-surface-elevated)' }}>Last Run</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(history.history).flatMap(([key, rec], outerIdx) => {
                    const runs = rec.runs;
                    const byStage: Record<string, ReadinessHistoryRun[]> = {};
                    for (const r of runs) {
                      (byStage[r.stage] ??= []).push(r);
                    }
                    const rowId = key;
                    const isExpanded = expandedRows.has(rowId);
                    const truncated = key.length > 40;
                    const displayKey = truncated && !isExpanded ? `...${key.slice(-37)}` : key;

                    return Object.entries(byStage).map(([stage, stageRuns], innerIdx) => {
                      const passed = stageRuns.filter(r => r.passed).length;
                      const total = stageRuns.length;
                      const avg = rec.avgPassedMs[stage as 'stt' | 'llm' | 'tts'];
                      const last = stageRuns[stageRuns.length - 1];
                      const allPassed = passed === total;
                      const isEven = (outerIdx + innerIdx) % 2 === 0;
                      return (
                        <tr key={`${key}-${stage}`}
                          style={{
                            background: isEven ? 'transparent' : 'var(--color-surface-elevated)',
                            borderTop: '1px solid var(--color-border)',
                          }}>
                          <td className="py-2 px-3">
                            {truncated ? (
                              <button
                                onClick={() => setExpandedRows(prev => {
                                  const next = new Set(prev);
                                  next.has(rowId) ? next.delete(rowId) : next.add(rowId);
                                  return next;
                                })}
                                className="text-left hover:underline transition-colors"
                                style={{ color: 'var(--color-text-secondary)', cursor: 'pointer' }}
                                title={key}
                              >
                                {displayKey}
                                <span className="ml-1 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                                  {isExpanded ? '▲' : '▼'}
                                </span>
                              </button>
                            ) : displayKey}
                          </td>
                          <td className="py-2 px-3">
                            <span className="uppercase font-semibold text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>{stage}</span>
                          </td>
                          <td className="py-2 px-3 text-center">
                            {allPassed
                              ? <CheckCircle2 className="w-4 h-4 inline" style={{ color: '#34d399' }} />
                              : <XCircle className="w-4 h-4 inline" style={{ color: '#f87171' }} />
                            }
                          </td>
                          <td className="py-2 px-3 text-right">
                            <span style={{ color: allPassed ? '#34d399' : '#f87171' }}>{passed}</span>
                            <span style={{ color: 'var(--color-text-muted)' }}>/{total}</span>
                          </td>
                          <td className="py-2 px-3 text-right" style={{ color: 'var(--color-text-secondary)' }}>
                            {avg ? `${avg}` : '—'}
                          </td>
                          <td className="py-2 px-3 text-right" style={{ color: 'var(--color-text-muted)' }}>
                            {last ? fmtAgo(last.ts) : '—'}
                          </td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Actions ── */}
      <Card>
        <CardHeader><span className="text-sm font-semibold">Actions</span></CardHeader>
        <CardBody>
          <div className="flex items-center gap-3">
            <Button onClick={handleReset} disabled={resetting} variant="secondary">
              <RotateCcw className={`w-4 h-4 mr-1 ${resetting ? 'animate-spin' : ''}`} />
              {resetting ? 'Resetting...' : 'Re-run Benchmark'}
            </Button>
            <Button onClick={load} variant="ghost">
              <RefreshCw className="w-4 h-4 mr-1" />
              Refresh
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
