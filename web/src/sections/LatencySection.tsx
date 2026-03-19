'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getLatencySettings, patchLatencySettings, triggerLatencyRun, getLatencyHosts, patchLatencyHosts,
  getGpuDefaults, getGpuReadinessHistory, resetGpuReadiness,
  type LatencySettings, type LatencyHost, type GpuSortBy,
  type GpuReadinessState, type GpuReadinessHistoryResponse,
} from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, AlertBanner, FormSelect, SectionHeader, StatusBadge, FormInput } from '@/components/ui';
import { RefreshCw, Play, Clock, Cpu, ChevronUp, ChevronDown, X, Plus, RotateCcw, MapPin, Activity, ChevronRight } from 'lucide-react';

const INTERVAL_OPTIONS = [
  { value: 30,   label: '30 min' },
  { value: 60,   label: '1 hour' },
  { value: 120,  label: '2 hours' },
  { value: 240,  label: '4 hours' },
  { value: 360,  label: '6 hours' },
  { value: 720,  label: '12 hours' },
  { value: 1440, label: '24 hours' },
];

const MAX_LATENCY_OPTIONS = [
  { value: 0,   label: 'Disabled' },
  { value: 30,  label: '30 ms' },
  { value: 50,  label: '50 ms' },
  { value: 80,  label: '80 ms' },
  { value: 100, label: '100 ms' },
  { value: 150, label: '150 ms' },
  { value: 200, label: '200 ms' },
  { value: 300, label: '300 ms' },
];

// Known GPU types across all providers (used for the "Add GPU" dropdown)
const KNOWN_GPU_TYPES = [
  'NVIDIA GeForce RTX 5090',
  'NVIDIA GeForce RTX 5080',
  'NVIDIA GeForce RTX 4090',
  'NVIDIA GeForce RTX 4080',
  'NVIDIA L40S',
  'NVIDIA L40',
  'NVIDIA RTX A6000',
  'NVIDIA RTX A5000',
  'NVIDIA A100-SXM4-80GB',
  'NVIDIA A100 80GB PCIe',
  'NVIDIA A100-SXM4-40GB',
  'NVIDIA A40',
  'NVIDIA H100 80GB HBM3',
  'NVIDIA H100 PCIe',
  'Tesla T4',
];

function fmtTime(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function fmtAgo(ts: number): string {
  if (!ts) return 'never';
  return `${fmtTime(Date.now() - ts)} ago`;
}

function rttColor(ms: number | null): string {
  if (ms === null) return 'text-zinc-500';
  if (ms < 50)  return 'text-emerald-400';
  if (ms < 120) return 'text-amber-400';
  return 'text-red-400';
}

function shortGpuName(name: string): string {
  return name.replace('NVIDIA ', '').replace('GeForce ', '');
}

type PhaseBadgeProps = { phase: string; spinning?: boolean };
function PhaseBadge({ phase }: PhaseBadgeProps) {
  switch (phase) {
    case 'ready':       return <StatusBadge variant="emerald" dot>Ready</StatusBadge>;
    case 'benchmarking':return <StatusBadge variant="amber" dot>Benchmarking</StatusBadge>;
    case 'repechage':   return <StatusBadge variant="amber">Repechage</StatusBadge>;
    case 'failed':      return <StatusBadge variant="red" dot>Failed</StatusBadge>;
    default:            return <StatusBadge variant="gray" dot>Idle</StatusBadge>;
  }
}

function effectiveTarget(targetMs: number, marginPct: number): number {
  return Math.round(targetMs * (1 - marginPct / 100));
}

export function LatencySection() {
  const [settings, setSettings]           = useState<LatencySettings | null>(null);
  const [hosts, setHosts]                 = useState<LatencyHost[]>([]);
  const [error, setError]                 = useState<string | null>(null);
  const [loading, setLoading]             = useState(true);
  const [running, setRunning]             = useState(false);

  // Schedule settings
  const [intervalMin, setIntervalMin]     = useState(120);
  const [maxLatencyMs, setMaxLatencyMs]   = useState(100);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  // GPU priority list
  const [gpuList, setGpuList]             = useState<string[]>([]);
  const [gpuListDirty, setGpuListDirty]   = useState(false);
  const [savingGpuList, setSavingGpuList] = useState(false);
  const [addGpuValue, setAddGpuValue]     = useState('');
  const [defaults, setDefaults]           = useState<string[]>([]);

  // Selection criteria
  const [gpuSortBy, setGpuSortBy]         = useState<GpuSortBy>('balanced');
  const [savingSortBy, setSavingSortBy]   = useState(false);

  // My location (from latency probes)
  const [myLocation, setMyLocation]       = useState<{ city: string; country: string; flag: string } | null>(null);

  // Host table
  const [regionFilter, setRegionFilter]   = useState('EU');
  const [selection, setSelection]         = useState<Set<string> | null>(null);
  const [savingSelection, setSavingSelection] = useState(false);

  // GPU Readiness
  const [readiness, setReadiness]             = useState<GpuReadinessHistoryResponse | null>(null);
  const [readinessError, setReadinessError]   = useState<string | null>(null);
  const [resettingBenchmark, setResettingBenchmark] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  // Readiness targets (local editable state)
  const [sttTargetMs, setSttTargetMs]         = useState(800);
  const [llmTargetMs, setLlmTargetMs]         = useState(1500);
  const [ttsTargetMs, setTtsTargetMs]         = useState(600);
  const [benchmarkMaxRuns, setBenchmarkMaxRuns] = useState(5);
  const [benchmarkMarginPct, setBenchmarkMarginPct] = useState(10);
  const [shadowRuns, setShadowRuns]           = useState(3);
  const [readinessDirty, setReadinessDirty]   = useState(false);
  const [savingReadiness, setSavingReadiness] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        getLatencySettings(),
        getLatencyHosts({ region: regionFilter || undefined }),
      ]);
      setSettings(s);
      setHosts(h.hosts);
      setRunning(s.running);
      setIntervalMin(s.intervalMin);
      setMaxLatencyMs(s.maxLatencyMs ?? 100);
      setGpuList(prev => gpuListDirty ? prev : (s.gpuPriorityList ?? []));
      setSelection(prev => prev ?? new Set(h.hosts.filter(x => x.monitored === 1).map(x => x.host_id)));
      if (s.gpuSortBy) setGpuSortBy(s.gpuSortBy);
      if (h.from) setMyLocation(h.from);
      // Sync readiness targets from settings (only if not currently editing)
      if (!readinessDirty) {
        if (s.sttTargetLatencyMs != null) setSttTargetMs(s.sttTargetLatencyMs);
        if (s.llmTargetLatencyMs != null) setLlmTargetMs(s.llmTargetLatencyMs);
        if (s.ttsTargetLatencyMs != null) setTtsTargetMs(s.ttsTargetLatencyMs);
        if (s.benchmarkMaxRuns   != null) setBenchmarkMaxRuns(s.benchmarkMaxRuns);
        if (s.benchmarkMarginPct != null) setBenchmarkMarginPct(s.benchmarkMarginPct);
        if (s.shadowRuns         != null) setShadowRuns(s.shadowRuns);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [regionFilter, gpuListDirty, readinessDirty]);

  const loadReadiness = useCallback(async () => {
    try {
      const r = await getGpuReadinessHistory();
      setReadiness(r);
      setReadinessError(null);
    } catch (e) {
      setReadinessError(e instanceof Error ? e.message : 'Failed to load readiness');
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { void loadReadiness(); }, [loadReadiness]);
  useEffect(() => {
    getGpuDefaults().then(d => setDefaults(d.defaults)).catch(() => {});
  }, []);

  // Poll every 5s when running
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [running, load]);

  // Poll readiness every 5s when a benchmark is in progress
  const readinessRunning = readiness
    ? (['benchmarking', 'repechage'] as const).some(ph =>
        readiness.currentState.stt.phase === ph ||
        readiness.currentState.llm.phase === ph ||
        readiness.currentState.tts.phase === ph
      ) || readiness.currentState.shadowPhase
    : false;

  useEffect(() => {
    if (!readinessRunning) return;
    const t = setInterval(() => void loadReadiness(), 5_000);
    return () => clearInterval(t);
  }, [readinessRunning, loadReadiness]);

  async function handleSaveSortBy(sort: GpuSortBy) {
    setGpuSortBy(sort);
    setSavingSortBy(true);
    try { await patchLatencySettings({ gpuSortBy: sort }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSavingSortBy(false); }
  }

  async function handleSaveSchedule() {
    setSavingSchedule(true);
    try {
      await patchLatencySettings({ intervalMin, maxLatencyMs });
      setScheduleDirty(false);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSavingSchedule(false); }
  }

  async function handleSaveReadinessTargets() {
    setSavingReadiness(true);
    try {
      await patchLatencySettings({
        sttTargetLatencyMs: sttTargetMs,
        llmTargetLatencyMs: llmTargetMs,
        ttsTargetLatencyMs: ttsTargetMs,
        benchmarkMaxRuns,
        benchmarkMarginPct,
        shadowRuns,
      });
      setReadinessDirty(false);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSavingReadiness(false); }
  }

  async function handleResetBenchmark() {
    setResettingBenchmark(true);
    try {
      await resetGpuReadiness();
      await loadReadiness();
    } catch (e) { setReadinessError(e instanceof Error ? e.message : 'Reset failed'); }
    finally { setResettingBenchmark(false); }
  }

  async function handleRunNow() {
    setRunning(true);
    try {
      await triggerLatencyRun();
      let tries = 0;
      while (tries < 60) {
        await new Promise(r => setTimeout(r, 3_000));
        const s = await getLatencySettings();
        if (!s.running) { await load(); break; }
        tries++;
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Run failed'); }
    finally { setRunning(false); }
  }

  async function handleSaveGpuList() {
    setSavingGpuList(true);
    try {
      await patchLatencySettings({ gpuPriorityList: gpuList });
      setGpuListDirty(false);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSavingGpuList(false); }
  }

  function moveGpu(idx: number, dir: -1 | 1) {
    const next = [...gpuList];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setGpuList(next);
    setGpuListDirty(true);
  }

  function removeGpu(idx: number) {
    setGpuList(prev => prev.filter((_, i) => i !== idx));
    setGpuListDirty(true);
  }

  function addGpu() {
    const val = addGpuValue.trim();
    if (!val || gpuList.includes(val)) return;
    setGpuList(prev => [...prev, val]);
    setGpuListDirty(true);
    setAddGpuValue('');
  }

  function resetToDefaults() {
    setGpuList([...defaults]);
    setGpuListDirty(true);
  }

  async function handleSaveSelection() {
    if (!selection) return;
    setSavingSelection(true);
    try {
      const allIds  = hosts.map(h => h.host_id);
      const sel     = allIds.filter(id => selection.has(id));
      const unsel   = allIds.filter(id => !selection.has(id));
      if (sel.length   > 0) await patchLatencyHosts(sel,   true);
      if (unsel.length > 0) await patchLatencyHosts(unsel, false);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSavingSelection(false); }
  }

  function toggleHost(id: string) {
    setSelection(prev => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelection(checked ? new Set(hosts.map(h => h.host_id)) : new Set());
  }

  const stats         = settings?.dbStats;
  const allChecked    = selection !== null && hosts.length > 0 && hosts.every(h => selection.has(h.host_id));
  const someChecked   = selection !== null && hosts.some(h => selection.has(h.host_id));
  const selectionCount = selection?.size ?? 0;
  const selectionDirty = selection !== null && hosts.some(h => selection.has(h.host_id) !== (h.monitored === 1));
  const availableToAdd = [...KNOWN_GPU_TYPES, ...defaults]
    .filter((g, i, arr) => arr.indexOf(g) === i && !gpuList.includes(g));

  // Readiness derived values
  const cs = readiness?.currentState;
  const benchmarkInProgress = cs
    ? (['benchmarking', 'repechage'] as const).some(ph =>
        cs.stt.phase === ph || cs.llm.phase === ph || cs.tts.phase === ph
      )
    : false;

  // Flatten history entries for the history table (last 10)
  const historyRows: Array<{ key: string; run: import('@/lib/gateway').ReadinessHistoryRun }> = [];
  if (readiness?.history) {
    for (const [key, rec] of Object.entries(readiness.history)) {
      for (const run of rec.runs) {
        historyRows.push({ key, run });
      }
    }
  }
  historyRows.sort((a, b) => b.run.ts - a.run.ts);
  const recentHistory = historyRows.slice(0, 10);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <SectionHeader title="Latency & GPU Config" subtitle="Controls which GPU types are tried and in what order, how network latency affects selection, and what latency targets the GPU must prove before handling production traffic." />
        {myLocation && (
          <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)', background: 'var(--color-surface)' }}>
            <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{myLocation.flag} {myLocation.city}, {myLocation.country}</span>
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>(your location)</span>
          </div>
        )}
      </div>

      {error && <AlertBanner variant="error">{error}</AlertBanner>}

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Total hosts',         value: stats.totalHosts,     color: undefined },
            { label: 'Monitored',           value: stats.monitoredHosts, color: stats.monitoredHosts > 0 ? 'text-emerald-400' : 'text-zinc-400' },
            { label: 'Unstable (σ>20ms)',   value: stats.unstable,       color: stats.unstable > 0 ? 'text-amber-400' : undefined },
            { label: 'Failing (3+ errors)', value: stats.failing,        color: stats.failing > 0 ? 'text-red-400' : undefined },
          ].map(({ label, value, color }) => (
            <Card key={label}>
              <CardBody>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
                <div className={`text-2xl font-bold ${color ?? ''}`}>{value}</div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* GPU Readiness */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-sm font-semibold">GPU Readiness</span>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>— benchmark pipeline latency after deploy</span>
            </div>
            <div className="flex items-center gap-2">
              {readinessDirty && (
                <Button variant="primary" size="sm" onClick={handleSaveReadinessTargets} disabled={savingReadiness}>
                  {savingReadiness ? 'Saving...' : 'Save targets'}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetBenchmark}
                disabled={resettingBenchmark || benchmarkInProgress}
                title={benchmarkInProgress ? 'Benchmark already in progress' : 'Re-run benchmark'}
              >
                {resettingBenchmark
                  ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />&nbsp;Resetting...</>
                  : <><RotateCcw className="w-3.5 h-3.5" />&nbsp;Re-run Benchmark</>
                }
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {readinessError && (
            <div className="mb-4 text-xs rounded-lg px-3 py-2" style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171' }}>
              {readinessError}
            </div>
          )}

          {/* A) Readiness Targets */}
          <div className="mb-5">
            <div className="text-xs font-semibold mb-1" style={{ color: 'var(--color-text-secondary)' }}>Readiness Targets</div>
            <p className="text-[11px] mb-3 leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
              After a GPU pod boots, each service is benchmarked independently. The pod must hit <em>target × (1 − margin%)</em> in at least one successful run before serving real traffic. Failing services trigger repechage (retry every 2 min). Once all pass, the GPU enters shadow mode — running in the background while cloud still serves users — for the configured number of shadow rounds before going live.
            </p>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <FormInput
                label="STT max (ms)"
                type="number"
                min={0}
                value={sttTargetMs}
                hint="Max acceptable latency for speech-to-text. GPU must hit target × (1 − margin%) in at least one run."
                onChange={e => { setSttTargetMs(Number(e.target.value)); setReadinessDirty(true); }}
              />
              <FormInput
                label="LLM max (ms)"
                type="number"
                min={0}
                value={llmTargetMs}
                hint="Max acceptable latency for the LLM translation step. Failing LLM blocks production activation."
                onChange={e => { setLlmTargetMs(Number(e.target.value)); setReadinessDirty(true); }}
              />
              <FormInput
                label="TTS max (ms)"
                type="number"
                min={0}
                value={ttsTargetMs}
                hint="Max acceptable time-to-first-audio for TTS. TTS failure does not block STT+LLM activation."
                onChange={e => { setTtsTargetMs(Number(e.target.value)); setReadinessDirty(true); }}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <FormInput
                label="Margin %"
                type="number"
                min={0}
                max={50}
                value={benchmarkMarginPct}
                hint="Safety buffer. 10% means GPU must hit target × 0.9, not just target."
                onChange={e => { setBenchmarkMarginPct(Number(e.target.value)); setReadinessDirty(true); }}
              />
              <FormInput
                label="Max runs"
                type="number"
                min={1}
                value={benchmarkMaxRuns}
                hint="Benchmark requests per service. If none hit the target, repechage kicks in."
                onChange={e => { setBenchmarkMaxRuns(Number(e.target.value)); setReadinessDirty(true); }}
              />
              <FormInput
                label="Shadow runs"
                type="number"
                min={0}
                value={shadowRuns}
                hint="After benchmark passes, run this many background requests while cloud still serves. All must succeed before GPU goes live."
                onChange={e => { setShadowRuns(Number(e.target.value)); setReadinessDirty(true); }}
              />
            </div>
            <div className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Effective targets: STT &lt;{effectiveTarget(sttTargetMs, benchmarkMarginPct)}ms, LLM &lt;{effectiveTarget(llmTargetMs, benchmarkMarginPct)}ms, TTS &lt;{effectiveTarget(ttsTargetMs, benchmarkMarginPct)}ms (= max × (1 − margin%))
            </div>
          </div>

          {/* B) Live readiness status */}
          {cs && (
            <div className="mb-5">
              <div className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>Live Status</div>
              <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--color-border)' }}>
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)' }}>
                      <th className="px-4 py-2 text-left font-medium">Stage</th>
                      <th className="px-4 py-2 text-left font-medium">Phase</th>
                      <th className="px-4 py-2 text-left font-medium">Progress</th>
                      <th className="px-4 py-2 text-right font-medium">Target</th>
                      <th className="px-4 py-2 text-right font-medium">Best</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['stt', 'llm', 'tts'] as const).map((stage, i) => {
                      const svc = cs[stage];
                      return (
                        <tr key={stage} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                          <td className="px-4 py-3 font-mono font-semibold uppercase text-[11px]" style={{ color: 'var(--color-text)' }}>
                            {stage}
                          </td>
                          <td className="px-4 py-3">
                            <PhaseBadge phase={svc.phase} />
                          </td>
                          <td className="px-4 py-3">
                            {svc.phase === 'benchmarking' || svc.phase === 'repechage' ? (
                              <div className="flex items-center gap-2">
                                <span style={{ color: 'var(--color-text-muted)' }}>
                                  Run {svc.completedRuns}/{benchmarkMaxRuns}
                                </span>
                                <div className="w-20 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                                  <div
                                    className="h-full rounded-full transition-all"
                                    style={{
                                      width: `${Math.min(100, (svc.completedRuns / Math.max(1, benchmarkMaxRuns)) * 100)}%`,
                                      background: '#fbbf24',
                                    }}
                                  />
                                </div>
                              </div>
                            ) : svc.phase === 'ready' ? (
                              <span style={{ color: '#34d399' }}>{svc.completedRuns} run{svc.completedRuns !== 1 ? 's' : ''}</span>
                            ) : svc.phase === 'failed' ? (
                              <span style={{ color: '#f87171' }}>{svc.completedRuns}/{benchmarkMaxRuns} runs</span>
                            ) : (
                              <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>
                            {svc.targetMs > 0 ? `${svc.targetMs}ms` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-semibold">
                            {svc.bestLatencyMs !== null
                              ? <span style={{ color: svc.bestLatencyMs <= svc.targetMs ? '#34d399' : '#f87171' }}>{svc.bestLatencyMs}ms</span>
                              : <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* C) Shadow mode progress */}
          {cs?.shadowPhase && (
            <div className="mb-5 rounded-lg px-4 py-3 border" style={{ background: 'color-mix(in srgb, #6366f1 8%, transparent)', borderColor: 'color-mix(in srgb, #6366f1 30%, transparent)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold" style={{ color: '#818cf8' }}>
                  Shadow mode: {cs.shadowCompletedRuns}/{shadowRuns} rounds — GPU computing in background
                </span>
                <span className="text-xs" style={{ color: 'color-mix(in srgb, #818cf8 70%, transparent)' }}>
                  {Math.round((cs.shadowCompletedRuns / Math.max(1, shadowRuns)) * 100)}%
                </span>
              </div>
              <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, (cs.shadowCompletedRuns / Math.max(1, shadowRuns)) * 100)}%`,
                    background: '#6366f1',
                  }}
                />
              </div>
            </div>
          )}

          {/* D) Benchmark History */}
          <div>
            <button
              className="flex items-center gap-1.5 text-xs font-semibold mb-2 cursor-pointer"
              style={{ color: 'var(--color-text-secondary)' }}
              onClick={() => setHistoryExpanded(prev => !prev)}
            >
              <ChevronRight
                className="w-3.5 h-3.5 transition-transform"
                style={{ transform: historyExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
              />
              Benchmark History
              {recentHistory.length > 0 && (
                <span className="font-normal ml-1" style={{ color: 'var(--color-text-muted)' }}>
                  ({recentHistory.length} recent)
                </span>
              )}
            </button>
            {historyExpanded && (
              recentHistory.length === 0 ? (
                <div className="text-xs py-4 text-center" style={{ color: 'var(--color-text-muted)' }}>
                  No benchmark history yet.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)' }}>
                        <th className="px-3 py-2 text-left font-medium">Date</th>
                        <th className="px-3 py-2 text-left font-medium">Docker + GPU</th>
                        <th className="px-3 py-2 text-left font-medium">Stage</th>
                        <th className="px-3 py-2 text-right font-medium">Best ms</th>
                        <th className="px-3 py-2 text-right font-medium">Target ms</th>
                        <th className="px-3 py-2 text-right font-medium">Runs</th>
                        <th className="px-3 py-2 text-center font-medium">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentHistory.map(({ key, run }, i) => (
                        <tr key={i} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                          <td className="px-3 py-2 font-mono" style={{ color: 'var(--color-text-muted)' }}>
                            {new Date(run.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="px-3 py-2 max-w-[180px] truncate" style={{ color: 'var(--color-text-muted)' }} title={key}>
                            {key.split(':').map((p, j) => (
                              <span key={j} className={j === 0 ? 'text-[var(--color-text)]' : ''}>{j > 0 ? ' · ' : ''}{shortGpuName(p)}</span>
                            ))}
                          </td>
                          <td className="px-3 py-2 font-mono font-semibold uppercase text-[11px]" style={{ color: 'var(--color-text)' }}>
                            {run.stage}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold" style={{ color: run.bestLatencyMs <= run.targetMs ? '#34d399' : '#f87171' }}>
                            {run.bestLatencyMs}ms
                          </td>
                          <td className="px-3 py-2 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>
                            {run.targetMs}ms
                          </td>
                          <td className="px-3 py-2 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>
                            {run.runsUsed}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {run.passed
                              ? <span className="text-emerald-400 font-bold">✓</span>
                              : <span className="text-red-400 font-bold">✗</span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>
        </CardBody>
      </Card>

      {/* Selection Criteria */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Selection Criteria</span>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>— how offers are ranked when deploying a GPU</span>
            {savingSortBy && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Saving…</span>}
          </div>
        </CardHeader>
        <CardBody>
          <div className="flex gap-2">
            {([
              { id: 'price',    label: 'Cheapest',  icon: '💰', desc: 'Lowest price/hr across all offers' },
              { id: 'balanced', label: 'Balanced',  icon: '⚖️', desc: 'Price weighted by reliability & measured latency' },
              { id: 'latency',  label: 'Fastest',   icon: '⚡', desc: 'Lowest measured TCP latency from your location (already probed)' },
            ] as const).map(opt => {
              const active = gpuSortBy === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => void handleSaveSortBy(opt.id)}
                  title={opt.desc}
                  className="flex-1 flex flex-col items-center gap-1 px-3 py-3 rounded-xl border text-sm font-medium transition-all cursor-pointer"
                  style={{
                    background:  active ? 'color-mix(in srgb, #6366f1 12%, transparent)' : 'var(--color-surface-hover)',
                    borderColor: active ? 'color-mix(in srgb, #6366f1 50%, transparent)' : 'var(--color-border)',
                    color:       active ? '#818cf8' : 'var(--color-text-muted)',
                  }}
                >
                  <span className="text-xl leading-none">{opt.icon}</span>
                  <span>{opt.label}</span>
                  <span className="text-[10px] font-normal text-center leading-tight" style={{ color: active ? 'color-mix(in srgb, #818cf8 70%, transparent)' : 'var(--color-text-muted)' }}>{opt.desc}</span>
                </button>
              );
            })}
          </div>
          {gpuSortBy === 'latency' && (
            <div className="mt-3 text-xs rounded-lg px-3 py-2" style={{ background: 'color-mix(in srgb, #6366f1 8%, transparent)', color: '#818cf8' }}>
              ⚡ Using probed latency data — machines with the lowest TCP RTT from <strong>{myLocation ? `${myLocation.flag} ${myLocation.city}` : 'your location'}</strong> will be preferred.
              {(!myLocation) && ' Run a probe to populate location data.'}
            </div>
          )}
        </CardBody>
      </Card>

      {/* GPU Priority List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-sm font-semibold">GPU Priority</span>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>— tried in order on deploy, across all providers</span>
            </div>
            <div className="flex items-center gap-2">
              {defaults.length > 0 && (
                <Button variant="ghost" size="sm" onClick={resetToDefaults} title="Reset to defaults">
                  <RotateCcw className="w-3.5 h-3.5" />
                </Button>
              )}
              {gpuListDirty && (
                <Button variant="primary" size="sm" onClick={handleSaveGpuList} disabled={savingGpuList}>
                  {savingGpuList ? 'Saving...' : 'Save'}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="space-y-1 mb-3">
            {gpuList.map((gpu, idx) => (
              <div
                key={gpu}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
                style={{ background: 'var(--color-surface-hover)' }}
              >
                <span className="text-xs font-medium w-5 text-center" style={{ color: 'var(--color-text-muted)' }}>
                  {idx + 1}
                </span>
                <span className="flex-1 font-mono text-xs">{shortGpuName(gpu)}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{gpu}</span>
                <div className="flex items-center gap-0.5">
                  <button onClick={() => moveGpu(idx, -1)} disabled={idx === 0}
                    className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30 cursor-pointer"
                    title="Move up">
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button onClick={() => moveGpu(idx, 1)} disabled={idx === gpuList.length - 1}
                    className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30 cursor-pointer"
                    title="Move down">
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  <button onClick={() => removeGpu(idx)}
                    className="p-1 rounded hover:bg-red-900/40 text-red-400 cursor-pointer"
                    title="Remove">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {/* Add GPU row */}
          <div className="flex items-center gap-2">
            <select
              value={addGpuValue}
              onChange={e => setAddGpuValue(e.target.value)}
              className="flex-1 rounded-lg px-3 py-1.5 text-xs border"
              style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
            >
              <option value="">Select GPU to add...</option>
              {availableToAdd.map(g => (
                <option key={g} value={g}>{shortGpuName(g)}</option>
              ))}
            </select>
            <Button variant="ghost" size="sm" onClick={addGpu} disabled={!addGpuValue}>
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            On deploy, the gateway tries GPU types in this order. Each type is tried on all available providers (Vast.ai, RunPod, TensorDock) before moving to the next. Types with all hosts above the latency threshold are deprioritised automatically.
          </div>
        </CardBody>
      </Card>

      {/* Schedule + latency threshold */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-sm font-semibold">Probe Schedule</span>
            </div>
            <Button variant="primary" size="sm" onClick={handleRunNow} disabled={running}>
              {running
                ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />&nbsp;Running...</>
                : <><Play className="w-3.5 h-3.5" />&nbsp;Run Now</>
              }
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <FormSelect
                label="Probe interval"
                value={String(intervalMin)}
                onChange={e => { setIntervalMin(Number(e.target.value)); setScheduleDirty(true); }}
              >
                {INTERVAL_OPTIONS.map(o => (
                  <option key={o.value} value={String(o.value)}>{o.label}</option>
                ))}
              </FormSelect>
            </div>
            <div className="flex-1">
              <FormSelect
                label="Max deploy latency"
                value={String(maxLatencyMs)}
                onChange={e => { setMaxLatencyMs(Number(e.target.value)); setScheduleDirty(true); }}
              >
                {MAX_LATENCY_OPTIONS.map(o => (
                  <option key={o.value} value={String(o.value)}>{o.label}</option>
                ))}
              </FormSelect>
            </div>
            {scheduleDirty && (
              <Button variant="primary" size="sm" onClick={handleSaveSchedule} disabled={savingSchedule}>
                {savingSchedule ? 'Saving...' : 'Save'}
              </Button>
            )}
          </div>
          <div className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {maxLatencyMs > 0
              ? `Deploy: GPU types where all probed hosts exceed ${maxLatencyMs}ms are moved to the end of the priority list.`
              : 'Latency filter disabled — GPU types tried in priority order regardless of RTT.'}
          </div>
          {settings && (
            <div className="mt-3 flex gap-4 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              <span>Last run: <strong>{fmtAgo(settings.lastRunAt)}</strong></span>
              <span>Next run: <strong>{settings.running ? 'running now' : `in ${fmtTime(settings.nextRunAt - Date.now())}`}</strong></span>
              <span>History: <strong>{stats?.historyRows ?? 0} rows</strong></span>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Hosts table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">
              Host Latencies{hosts.length > 0 && (
                <span className="text-xs font-normal ml-1" style={{ color: 'var(--color-text-muted)' }}>
                  ({selectionCount}/{hosts.length} monitored)
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              {selectionDirty && (
                <Button variant="primary" size="sm" onClick={handleSaveSelection} disabled={savingSelection}>
                  {savingSelection ? 'Saving...' : 'Save selection'}
                </Button>
              )}
              <FormSelect
                value={regionFilter}
                onChange={e => { setRegionFilter(e.target.value); setSelection(null); }}
                className="!py-1.5 !text-xs"
              >
                <option value="">All regions</option>
                <option value="EU">Europe only</option>
              </FormSelect>
              <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
                <RefreshCw className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading...</div>
          ) : hosts.length === 0 ? (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              No hosts in DB yet. Click &quot;Run Now&quot; to discover and probe hosts.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left border-b" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
                    <th className="pb-2 pr-3 w-6">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={el => { if (el) el.indeterminate = !allChecked && someChecked; }}
                        onChange={e => toggleAll(e.target.checked)}
                        className="cursor-pointer"
                        title="Select / deselect all"
                      />
                    </th>
                    <th className="pb-2 font-medium">Host IP</th>
                    <th className="pb-2 font-medium">Location</th>
                    <th className="pb-2 font-medium">GPU</th>
                    <th className="pb-2 font-medium text-right">Median</th>
                    <th className="pb-2 font-medium text-right">P90</th>
                    <th className="pb-2 font-medium text-right">σ</th>
                    <th className="pb-2 font-medium text-right">OK rate</th>
                    <th className="pb-2 font-medium text-right">Price/h</th>
                    <th className="pb-2 font-medium text-right">Last probe</th>
                  </tr>
                </thead>
                <tbody>
                  {hosts.map(h => {
                    const checked = selection?.has(h.host_id) ?? h.monitored === 1;
                    return (
                      <tr
                        key={h.host_id}
                        className="border-b cursor-pointer"
                        style={{ borderColor: 'var(--color-border)', opacity: checked ? 1 : 0.4 }}
                        onClick={() => toggleHost(h.host_id)}
                      >
                        <td className="py-2 pr-3" onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={checked} onChange={() => toggleHost(h.host_id)} className="cursor-pointer" />
                        </td>
                        <td className="py-2 pr-3 font-mono">{h.host_ip}</td>
                        <td className="py-2 pr-3" style={{ color: 'var(--color-text-muted)' }}>{h.geolocation}</td>
                        <td className="py-2 pr-3" style={{ color: 'var(--color-text-muted)' }}>{shortGpuName(h.gpu_name)}</td>
                        <td className={`py-2 pr-3 text-right font-mono font-semibold ${rttColor(h.median_ms)}`}>
                          {h.median_ms !== null ? `${h.median_ms}ms` : '—'}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>
                          {h.p90_ms !== null ? `${h.p90_ms}ms` : '—'}
                        </td>
                        <td className={`py-2 pr-3 text-right font-mono ${h.stddev_ms !== null && h.stddev_ms > 20 ? 'text-amber-400' : ''}`}>
                          {h.stddev_ms !== null ? `${h.stddev_ms}ms` : '—'}
                        </td>
                        <td className={`py-2 pr-3 text-right ${h.consecutive_failures >= 3 ? 'text-red-400' : h.success_rate < 0.8 ? 'text-amber-400' : 'text-emerald-400'}`}>
                          {Math.round(h.success_rate * 100)}%
                        </td>
                        <td className="py-2 pr-3 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>
                          ${h.price_usd.toFixed(3)}
                        </td>
                        <td className="py-2 text-right" style={{ color: 'var(--color-text-muted)' }}>
                          {h.last_probed_at ? fmtAgo(h.last_probed_at) : 'never'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
