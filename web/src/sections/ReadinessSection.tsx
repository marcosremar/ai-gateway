'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getReadinessStatus, getGpuReadinessHistory, resetGpuReadiness, patchLatencySettings,
  type ReadinessStatusResponse, type GpuReadinessHistoryResponse, type ReadinessHistoryRun,
} from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, AlertBanner, StatusBadge, FormInput, SectionHeader } from '@/components/ui';
import { RefreshCw, RotateCcw, Activity, AlertTriangle } from 'lucide-react';

type Phase = 'idle' | 'benchmarking' | 'ready' | 'degraded' | 'failed' | 'repechage' | 'condemned';

function PhaseBadge({ phase }: { phase: Phase }) {
  switch (phase) {
    case 'ready':        return <StatusBadge variant="emerald" dot>Ready</StatusBadge>;
    case 'benchmarking': return <StatusBadge variant="amber" dot>Benchmarking</StatusBadge>;
    case 'degraded':     return <StatusBadge variant="orange" dot>Degraded</StatusBadge>;
    case 'repechage':    return <StatusBadge variant="amber">Repechage</StatusBadge>;
    case 'failed':       return <StatusBadge variant="red" dot>Failed</StatusBadge>;
    case 'condemned':    return <StatusBadge variant="red" dot>Condemned</StatusBadge>;
    default:             return <StatusBadge variant="gray" dot>Idle</StatusBadge>;
  }
}

function phaseColor(phase: Phase): string {
  switch (phase) {
    case 'ready': return 'var(--color-emerald, #34d399)';
    case 'benchmarking': return 'var(--color-amber, #fbbf24)';
    case 'degraded': return '#f97316';
    case 'repechage': return 'var(--color-purple, #a78bfa)';
    case 'failed': return 'var(--color-red, #f87171)';
    case 'condemned': return '#991b1b';
    default: return 'var(--color-text-muted, #71717a)';
  }
}

function p95Color(p95: number | null, target: number, multiplier: number): string {
  if (p95 === null) return 'var(--color-text-muted)';
  const threshold = target * multiplier;
  if (p95 <= target) return 'var(--color-emerald, #34d399)';
  if (p95 <= threshold) return 'var(--color-amber, #fbbf24)';
  return 'var(--color-red, #f87171)';
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
        setSttTargetMs(s.targets.stt);
        setLlmTargetMs(s.targets.llm);
        setTtsTargetMs(s.targets.tts);
        setP95Multiplier(s.p95DemotionMultiplier);
        setRepechageMax(s.repechageMaxAttempts);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Determine if any stage is in an active phase
  const hasActivePhase = status && ['benchmarking', 'degraded', 'repechage', 'condemned'].some(p =>
    status.readinessState.stt.phase === p || status.readinessState.llm.phase === p || status.readinessState.tts.phase === p
  );
  const pollIntervalMs = hasActivePhase || status?.readinessState.shadowPhase ? 2000 : 10000;

  useEffect(() => {
    load();
    const iv = setInterval(load, pollIntervalMs);
    return () => clearInterval(iv);
  }, [load, pollIntervalMs]);

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

  if (loading) return <div className="p-8 text-center" style={{ color: 'var(--color-text-muted)' }}>Loading...</div>;

  const stages = ['stt', 'llm', 'tts'] as const;

  return (
    <div className="space-y-6 p-6">
      <SectionHeader title="GPU Readiness" subtitle="Benchmark → shadow mode → production activation. GPU never handles real traffic until latency targets are proven." />

      {/* Phase lifecycle diagram — directional */}
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
            ] as const).map((item, i) =>
              item === null ? (
                <span key={i} className="text-base" style={{ color: 'var(--color-text-muted)' }}>→</span>
              ) : (
                <div key={item.phase} className="flex flex-col gap-1 px-3 py-2 rounded-lg border min-w-[110px]"
                  style={{
                    borderColor: `color-mix(in srgb, ${item.color} 35%, var(--color-border))`,
                    background: `color-mix(in srgb, ${item.color} 7%, var(--color-surface-elevated))`,
                  }}>
                  <span className="font-bold text-[11px]" style={{ color: item.color }}>{item.label}</span>
                  <span className="text-[10px] leading-tight" style={{ color: 'var(--color-text-muted)' }}>{item.desc}</span>
                </div>
              )
            )}
          </div>

          {/* Failure path: benchmarking/ready → degraded/repechage → condemned */}
          <div className="flex items-start gap-3 flex-wrap pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <span className="text-[10px] font-semibold pt-2.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>failure paths</span>
            {([
              { phase: 'degraded',  color: '#f97316', label: 'degraded',  desc: 'Live P95 exceeded threshold — pulled from traffic, re-benchmarking' },
              null,
              { phase: 'repechage', color: '#a78bfa', label: 'repechage', desc: 'Benchmark failed — retrying every 2 min (up to max attempts)' },
              null,
              { phase: 'condemned', color: '#f87171', label: 'condemned', desc: 'Max retries exhausted — cloud handles all traffic until manual reset' },
            ] as const).map((item, i) =>
              item === null ? (
                <span key={i} className="text-base pt-2" style={{ color: 'var(--color-text-muted)' }}>→</span>
              ) : (
                <div key={item.phase} className="flex flex-col gap-1 px-3 py-2 rounded-lg border min-w-[130px]"
                  style={{
                    borderColor: `color-mix(in srgb, ${item.color} 35%, var(--color-border))`,
                    background: `color-mix(in srgb, ${item.color} 7%, var(--color-surface-elevated))`,
                  }}>
                  <span className="font-bold text-[11px]" style={{ color: item.color }}>{item.label}</span>
                  <span className="text-[10px] leading-tight" style={{ color: 'var(--color-text-muted)' }}>{item.desc}</span>
                </div>
              )
            )}
          </div>

          {/* Note about profile latency targets */}
          <div className="mt-3 pt-3 border-t text-[10px] leading-relaxed" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            <strong style={{ color: 'var(--color-text-secondary)' }}>Profile latency target:</strong>{' '}
            The active profile's <em>Latency</em> field (realtime / low / batch) sets the benchmark thresholds automatically —
            realtime uses STT&nbsp;300ms / LLM&nbsp;500ms / TTS&nbsp;300ms; low uses 800ms / 2s / 1.5s; batch accepts any latency.
            Switching profiles updates thresholds immediately and takes effect on the next benchmark cycle.
          </div>
        </CardBody>
      </Card>

      {error && <AlertBanner variant="error">{error}</AlertBanner>}

      {status?.readinessState.condemned && (
        <AlertBanner variant="error">GPU condemned — repechage attempts exhausted. All traffic routed to cloud. Re-run benchmark to retry.</AlertBanner>
      )}

      {/* Card 1: Benchmark Settings */}
      <Card>
        <CardHeader><span className="text-sm font-semibold">Benchmark Settings</span></CardHeader>
        <CardBody>
          {/* Flow description */}
          <div className="mb-4 text-xs space-y-1 leading-relaxed p-3 rounded-lg" style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-muted)' }}>
            <p><strong style={{ color: 'var(--color-text-secondary)' }}>How it works:</strong> When a GPU pod boots, each service (STT, LLM, TTS) is benchmarked independently before it handles real traffic.
            The GPU must hit at least one request below <em>target × (1 − margin%)</em> within Max Runs attempts.
            If all three pass, the GPU enters <strong>shadow mode</strong>: it runs in the background while cloud still serves users.
            After Shadow Runs consecutive successes, the GPU goes live for production.
            Once live, P95 latency is monitored continuously — if it exceeds target × Demotion Multiplier, the GPU is removed from the pool.
            A failed benchmark triggers <strong>repechage</strong>: retries every 2 min up to Max Repechage Attempts before condemning the pod.</p>
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
          <div className="grid grid-cols-3 gap-4 mt-4">
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
          <div className="grid grid-cols-2 gap-4 mt-4">
            <FormInput label="P95 Demotion Multiplier" type="number" step="0.1" value={p95Multiplier}
              hint="Live P95 threshold = target × multiplier. Exceed it and the GPU is pulled from production. E.g. 2.0 → demote at 2× target."
              onChange={e => { setP95Multiplier(Number(e.target.value)); markDirty(); }} />
            <FormInput label="Max Repechage Attempts" type="number" value={repechageMax}
              hint="How many times to retry a failed benchmark (every 2 min) before condemning the pod permanently."
              onChange={e => { setRepechageMax(Number(e.target.value)); markDirty(); }} />
          </div>
          {settingsDirty && (
            <div className="mt-4 flex justify-end">
              <Button onClick={handleSaveSettings} disabled={savingSettings}>
                {savingSettings ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Card 2: Live Status */}
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
            <div className="space-y-3">
              {stages.map(stage => {
                const s = status.readinessState[stage];
                const maxRuns = benchMaxRuns;
                const pct = s.completedRuns > 0 ? Math.min(100, Math.round(s.completedRuns / maxRuns * 100)) : 0;
                return (
                  <div key={stage} className="flex items-center gap-4">
                    <span className="w-10 font-mono text-xs uppercase" style={{ color: 'var(--color-text-muted)' }}>{stage}</span>
                    <PhaseBadge phase={s.phase as Phase} />
                    {s.phase === 'benchmarking' && (
                      <div className="flex-1 flex items-center gap-2">
                        <div className="flex-1 h-2 rounded-full" style={{ background: 'var(--color-bg-secondary)' }}>
                          <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, background: phaseColor(s.phase as Phase) }} />
                        </div>
                        <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>{s.completedRuns}/{maxRuns}</span>
                      </div>
                    )}
                    <span className="text-xs font-mono">
                      best: {fmtMs(s.bestLatencyMs)} / target: {fmtMs(s.targetMs)}
                    </span>
                  </div>
                );
              })}

              {status.readinessState.shadowPhase && (
                <div className="flex items-center gap-2 mt-2 pt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
                  <Activity className="w-4 h-4" style={{ color: 'var(--color-amber, #fbbf24)' }} />
                  <span className="text-sm">Shadow mode: {status.readinessState.shadowCompletedRuns}/{shadowRunsVal} runs</span>
                </div>
              )}

              {status.readinessState.repechageAttempts > 0 && (
                <div className="flex items-center gap-2 mt-2 pt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
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

      {/* Card 3: P95 Monitor */}
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
                return (
                  <div key={stage} className="text-center p-3 rounded-lg" style={{ background: 'var(--color-bg-secondary)' }}>
                    <div className="text-xs uppercase font-mono mb-1" style={{ color: 'var(--color-text-muted)' }}>{stage}</div>
                    <div className="text-2xl font-mono font-bold" style={{ color: p95Color(p95, target, status.p95DemotionMultiplier) }}>
                      {fmtMs(p95)}
                    </div>
                    <div className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                      target: {target}ms / demote: {Math.round(threshold)}ms
                    </div>
                    {p95 !== null && (
                      <div className="mt-2 h-1.5 rounded-full" style={{ background: 'var(--color-bg)' }}>
                        <div className="h-1.5 rounded-full transition-all" style={{
                          width: `${Math.min(100, Math.round(p95 / threshold * 100))}%`,
                          background: p95Color(p95, target, status.p95DemotionMultiplier),
                        }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-4 mt-4 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              <span>Production: {status.gpuReadyForProduction ? 'Active' : 'Inactive'}</span>
              <span>Shadow: {status.gpuShadowMode ? 'Active' : 'Inactive'}</span>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Card 4: Benchmark History */}
      {history && Object.keys(history.history).length > 0 && (
        <Card>
          <CardHeader><span className="text-sm font-semibold">Benchmark History</span></CardHeader>
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr style={{ color: 'var(--color-text-muted)' }}>
                    <th className="text-left py-1 px-2">Image : GPU</th>
                    <th className="text-left py-1 px-2">Stage</th>
                    <th className="text-right py-1 px-2">Pass Rate</th>
                    <th className="text-right py-1 px-2">Avg (ms)</th>
                    <th className="text-right py-1 px-2">Last Run</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(history.history).map(([key, rec]) => {
                    const runs = rec.runs;
                    const byStage: Record<string, ReadinessHistoryRun[]> = {};
                    for (const r of runs) {
                      (byStage[r.stage] ??= []).push(r);
                    }
                    return Object.entries(byStage).map(([stage, stageRuns]) => {
                      const passed = stageRuns.filter(r => r.passed).length;
                      const total = stageRuns.length;
                      const avg = rec.avgPassedMs[stage as 'stt' | 'llm' | 'tts'];
                      const last = stageRuns[stageRuns.length - 1];
                      return (
                        <tr key={`${key}-${stage}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                          <td className="py-1 px-2">{key.length > 40 ? `...${key.slice(-37)}` : key}</td>
                          <td className="py-1 px-2 uppercase">{stage}</td>
                          <td className="py-1 px-2 text-right">{passed}/{total}</td>
                          <td className="py-1 px-2 text-right">{avg ? `${avg}` : '—'}</td>
                          <td className="py-1 px-2 text-right">{last ? fmtAgo(last.ts) : '—'}</td>
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

      {/* Card 5: Actions */}
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
