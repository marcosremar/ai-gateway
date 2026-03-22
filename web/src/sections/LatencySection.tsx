'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getLatencySettings, patchLatencySettings, triggerLatencyRun,
  getLatencyHosts, patchLatencyHosts,
  type LatencySettings, type LatencyHost, type GpuSortBy,
} from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, AlertBanner, Spinner, Toggle } from '@/components/ui';
import { Activity, RefreshCw, Play, ArrowUpDown, Filter, Settings2, Clock, Wifi } from 'lucide-react';

const PROVIDERS = ['', 'vast', 'tensordock', 'runpod'] as const;
const PROVIDER_LABELS: Record<string, string> = { '': 'All', vast: 'Vast.ai', tensordock: 'TensorDock', runpod: 'RunPod' };

type SortKey = 'median_ms' | 'p90_ms' | 'stddev_ms' | 'success_rate' | 'price_usd';

function fmtAgo(ts: number | null): string {
  if (!ts) return '—';
  const sec = (Date.now() - ts) / 1000;
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function latColor(ms: number | null): string {
  if (ms == null) return 'var(--color-text-muted)';
  if (ms < 80) return '#34d399';
  if (ms < 150) return '#60a5fa';
  if (ms < 300) return '#fbbf24';
  return '#f87171';
}

export function LatencySection() {
  const [settings, setSettings] = useState<LatencySettings | null>(null);
  const [hosts, setHosts] = useState<LatencyHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [providerFilter, setProviderFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('median_ms');
  const [sortAsc, setSortAsc] = useState(true);
  const [gpuFilter, setGpuFilter] = useState('');
  const [showMonitoredOnly, setShowMonitoredOnly] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, h] = await Promise.all([getLatencySettings(), getLatencyHosts()]);
      setSettings(s);
      setHosts(h.hosts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRunNow = async () => {
    setRunning(true);
    try {
      await triggerLatencyRun();
      // Wait a bit then refresh
      setTimeout(load, 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Trigger failed');
    } finally {
      setRunning(false);
    }
  };

  const handlePatchSetting = async (patch: Partial<LatencySettings>) => {
    setSaving(true);
    try {
      const updated = await patchLatencySettings(patch);
      setSettings(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleMonitored = async (hostIds: string[], monitored: boolean) => {
    try {
      await patchLatencyHosts(hostIds, monitored);
      setHosts(prev => prev.map(h => hostIds.includes(h.host_id) ? { ...h, monitored: monitored ? 1 : 0 } : h));
    } catch {}
  };

  // Sorting
  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(true); }
  }

  // Filter + sort hosts
  const filtered = hosts
    .filter(h => !providerFilter || h.provider === providerFilter)
    .filter(h => !gpuFilter || h.gpu_type?.toLowerCase().includes(gpuFilter.toLowerCase()))
    .filter(h => !showMonitoredOnly || h.monitored);
  const sorted = [...filtered].sort((a, b) => {
    const mul = sortAsc ? 1 : -1;
    const av = a[sortKey] ?? (sortAsc ? Infinity : -Infinity);
    const bv = b[sortKey] ?? (sortAsc ? Infinity : -Infinity);
    return ((av as number) - (bv as number)) * mul;
  });

  // Unique GPU types for filter
  const gpuTypes = [...new Set(hosts.map(h => h.gpu_type).filter(Boolean))].sort();

  function SortTh({ k, label, minW }: { k: SortKey; label: string; minW?: number }) {
    const active = sortKey === k;
    return (
      <th className="pb-2 font-medium cursor-pointer select-none whitespace-nowrap text-right pr-4"
        style={{ color: active ? 'var(--color-text-secondary)' : 'var(--color-text-muted)', minWidth: minW }}
        onClick={() => toggleSort(k)}>
        <span className="inline-flex items-center gap-1">
          {label}
          <ArrowUpDown className="w-2.5 h-2.5" style={{ opacity: active ? 1 : 0.3 }} />
        </span>
      </th>
    );
  }

  if (error && !settings) return <AlertBanner variant="error" className="m-6">{error}</AlertBanner>;

  return (
    <div className="p-6 space-y-4">
      {/* ── Settings card ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(96,165,250,0.12)' }}>
                <Activity className="w-4 h-4 text-blue-400" />
              </div>
              <div>
                <h3 className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>Latency Probing</h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {settings
                    ? `${settings.dbStats?.monitoredHosts ?? 0} monitored · ${settings.dbStats?.totalHosts ?? 0} total hosts`
                    : 'Loading...'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {settings && (
                <span className="text-[11px] font-mono" style={{ color: 'var(--color-text-muted)' }}>
                  Last: {fmtAgo(settings.lastRunAt)} · Next: {settings.nextRunAt > Date.now() ? fmtAgo(settings.nextRunAt).replace('ago', '') : 'now'}
                </span>
              )}
              <Button variant="outline" size="sm" onClick={handleRunNow} isLoading={running} loadingText="Probing...">
                <Play className="w-3 h-3" /> Run Now
              </Button>
              <Button variant="ghost" size="sm" onClick={load}>
                <RefreshCw className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {loading && !settings ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : settings && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {/* Probe interval */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-muted)' }}>
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Probe Interval</span>
                </label>
                <div className="flex gap-1">
                  {[15, 30, 60, 120].map(min => (
                    <button key={min} onClick={() => handlePatchSetting({ intervalMin: min })}
                      className="px-2 py-[3px] rounded-md text-[11px] font-medium transition-all cursor-pointer"
                      style={{
                        background: settings.intervalMin === min ? '#3b82f6' : 'transparent',
                        color: settings.intervalMin === min ? '#fff' : 'var(--color-text-muted)',
                        border: `1px solid ${settings.intervalMin === min ? '#3b82f6' : 'var(--color-border)'}`,
                      }}>
                      {min}m
                    </button>
                  ))}
                </div>
              </div>

              {/* Max latency threshold */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-muted)' }}>
                  <span className="flex items-center gap-1"><Wifi className="w-3 h-3" /> Max Latency</span>
                </label>
                <div className="flex gap-1">
                  {[0, 50, 100, 200, 400].map(ms => (
                    <button key={ms} onClick={() => handlePatchSetting({ maxLatencyMs: ms })}
                      className="px-2 py-[3px] rounded-md text-[11px] font-medium transition-all cursor-pointer"
                      style={{
                        background: settings.maxLatencyMs === ms ? '#10b981' : 'transparent',
                        color: settings.maxLatencyMs === ms ? '#fff' : 'var(--color-text-muted)',
                        border: `1px solid ${settings.maxLatencyMs === ms ? '#10b981' : 'var(--color-border)'}`,
                      }}>
                      {ms === 0 ? 'Off' : `${ms}ms`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sort by */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-muted)' }}>
                  <span className="flex items-center gap-1"><Settings2 className="w-3 h-3" /> GPU Sort</span>
                </label>
                <div className="flex gap-1">
                  {(['balanced', 'latency', 'price'] as GpuSortBy[]).map(mode => (
                    <button key={mode} onClick={() => handlePatchSetting({ gpuSortBy: mode })}
                      className="px-2 py-[3px] rounded-md text-[11px] font-medium transition-all cursor-pointer capitalize"
                      style={{
                        background: settings.gpuSortBy === mode ? '#a78bfa' : 'transparent',
                        color: settings.gpuSortBy === mode ? '#fff' : 'var(--color-text-muted)',
                        border: `1px solid ${settings.gpuSortBy === mode ? '#a78bfa' : 'var(--color-border)'}`,
                      }}>
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* DB stats */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-muted)' }}>
                  DB Stats
                </label>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                  {settings.dbStats && (
                    <>
                      <span>{settings.dbStats.totalHosts} hosts</span>
                      {settings.dbStats.unstable > 0 && (
                        <span style={{ color: '#fbbf24' }}>{settings.dbStats.unstable} unstable</span>
                      )}
                      {settings.dbStats.failing > 0 && (
                        <span style={{ color: '#f87171' }}>{settings.dbStats.failing} failing</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── Hosts table ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <h3 className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>
              Probed Hosts
              <span className="font-normal text-xs ml-2" style={{ color: 'var(--color-text-muted)' }}>
                {sorted.length}{filtered.length !== hosts.length ? ` / ${hosts.length}` : ''}
              </span>
            </h3>
            <div className="flex items-center gap-2">
              {/* GPU type filter */}
              <div className="relative">
                <Filter className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
                <input
                  className="text-[11px] rounded-md border pl-6 pr-2 py-1 outline-none w-32"
                  style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                  placeholder="Filter GPU..."
                  value={gpuFilter}
                  onChange={e => setGpuFilter(e.target.value)}
                  list="gpu-type-list"
                />
                <datalist id="gpu-type-list">
                  {gpuTypes.map(g => <option key={g} value={g} />)}
                </datalist>
              </div>

              {/* Provider filter */}
              <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
                {PROVIDERS.map(p => (
                  <button key={p} type="button" onClick={() => setProviderFilter(p)}
                    className="px-2 py-1 text-[10px] font-medium transition-all cursor-pointer"
                    style={{
                      background: providerFilter === p ? 'color-mix(in srgb, #60a5fa 15%, var(--color-surface-elevated))' : 'transparent',
                      color: providerFilter === p ? '#93c5fd' : 'var(--color-text-muted)',
                      borderRight: p !== 'runpod' ? '1px solid var(--color-border)' : 'none',
                    }}>
                    {PROVIDER_LABELS[p]}
                  </button>
                ))}
              </div>

              {/* Monitored only toggle */}
              <label className="flex items-center gap-1.5 cursor-pointer">
                <Toggle checked={showMonitoredOnly} onChange={setShowMonitoredOnly} size="sm" />
                <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Monitored</span>
              </label>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : sorted.length === 0 ? (
            <p className="text-center py-8 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              No hosts found. Run a latency probe to discover hosts.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide">
                    <th className="pb-2 font-semibold pr-3" style={{ color: 'var(--color-text-muted)', width: 30 }}>
                      <span title="Monitored">M</span>
                    </th>
                    <th className="pb-2 font-semibold pr-3" style={{ color: 'var(--color-text-muted)', minWidth: 80 }}>Provider</th>
                    <th className="pb-2 font-semibold pr-3" style={{ color: 'var(--color-text-muted)', minWidth: 120 }}>GPU</th>
                    <th className="pb-2 font-semibold pr-3" style={{ color: 'var(--color-text-muted)', minWidth: 80 }}>Region</th>
                    <SortTh k="median_ms" label="Median" minW={70} />
                    <SortTh k="p90_ms" label="P90" minW={60} />
                    <SortTh k="stddev_ms" label="Jitter" minW={60} />
                    <SortTh k="success_rate" label="Success" minW={70} />
                    <SortTh k="price_usd" label="Price" minW={60} />
                    <th className="pb-2 font-semibold pr-3 text-right" style={{ color: 'var(--color-text-muted)', minWidth: 80 }}>Last Probe</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(h => {
                    const failState = h.consecutive_failures >= 3;
                    return (
                      <tr key={h.host_id}
                        className="border-t transition-colors hover:bg-white/[0.02]"
                        style={{
                          borderColor: 'var(--color-border)',
                          opacity: failState ? 0.5 : 1,
                        }}>
                        <td className="py-1.5 pr-3">
                          <Toggle
                            checked={!!h.monitored}
                            onChange={v => handleToggleMonitored([h.host_id], v)}
                            size="sm"
                          />
                        </td>
                        <td className="py-1.5 pr-3 font-medium capitalize" style={{ color: 'var(--color-text-secondary)' }}>
                          {h.provider}
                        </td>
                        <td className="py-1.5 pr-3 font-medium" style={{ color: 'var(--color-text)' }}>
                          {h.gpu_type || h.gpu_name || '—'}
                        </td>
                        <td className="py-1.5 pr-3" style={{ color: 'var(--color-text-muted)' }}>
                          {h.geolocation || h.region || '—'}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono font-semibold" style={{ color: latColor(h.median_ms) }}>
                          {h.median_ms != null ? `${Math.round(h.median_ms)}ms` : '—'}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono" style={{ color: latColor(h.p90_ms) }}>
                          {h.p90_ms != null ? `${Math.round(h.p90_ms)}ms` : '—'}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono" style={{ color: h.stddev_ms != null && h.stddev_ms > 20 ? '#fbbf24' : 'var(--color-text-muted)' }}>
                          {h.stddev_ms != null ? `±${Math.round(h.stddev_ms)}` : '—'}
                        </td>
                        <td className="py-1.5 pr-4 text-right">
                          {h.success_rate != null ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                                <div className="h-full rounded-full" style={{
                                  width: `${Math.round(h.success_rate * 100)}%`,
                                  background: h.success_rate >= 0.9 ? '#34d399' : h.success_rate >= 0.7 ? '#fbbf24' : '#f87171',
                                }} />
                              </div>
                              <span className="font-mono" style={{ color: h.success_rate >= 0.9 ? '#34d399' : h.success_rate >= 0.7 ? '#fbbf24' : '#f87171' }}>
                                {Math.round(h.success_rate * 100)}%
                              </span>
                            </div>
                          ) : '—'}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>
                          {h.price_usd > 0 ? `$${h.price_usd.toFixed(2)}` : '—'}
                        </td>
                        <td className="py-1.5 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>
                          {fmtAgo(h.last_probed_at)}
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

      {/* ── Streaming STT Benchmark Reference ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgba(6,182,212,0.12)' }}>
              <Wifi className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <h3 className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>Streaming STT Benchmark</h3>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Qwen3-ASR 1.7B vs Fireworks Whisper v3 — real-time mic simulation, 2026-03-21
              </p>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="space-y-3">
            {/* Provider comparison */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: 'var(--color-text-muted)' }}>
                    <th className="text-left py-1 pr-3">Corpus</th>
                    <th className="text-right py-1 px-2" colSpan={2}>Qwen3-ASR</th>
                    <th className="text-right py-1 px-2" colSpan={2}>Fireworks</th>
                    <th className="text-center py-1 px-2">Winner</th>
                  </tr>
                  <tr style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}>
                    <th></th>
                    <th className="text-right px-2">TTFR</th>
                    <th className="text-right px-2">WER</th>
                    <th className="text-right px-2">TTFR</th>
                    <th className="text-right px-2">WER</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {[
                    { corpus: 'VoxPopuli FR', qTtfr: 2503, qWer: 11.6, fTtfr: 784, fWer: 12.4, winner: 'Qwen3' },
                    { corpus: 'VoxPopuli EN', qTtfr: 2487, qWer: 6.8, fTtfr: 729, fWer: 13.1, winner: 'Qwen3' },
                    { corpus: 'FLEURS FR', qTtfr: 2698, qWer: 9.3, fTtfr: 1663, fWer: 26.0, winner: 'Qwen3' },
                    { corpus: 'FLEURS EN', qTtfr: 2488, qWer: 3.1, fTtfr: 1277, fWer: 5.5, winner: 'Qwen3' },
                  ].map(r => (
                    <tr key={r.corpus} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                      <td className="py-1.5 pr-3" style={{ color: 'var(--color-text)' }}>{r.corpus}</td>
                      <td className="py-1.5 px-2 text-right" style={{ color: 'var(--color-text-muted)' }}>{r.qTtfr}ms</td>
                      <td className="py-1.5 px-2 text-right font-semibold" style={{ color: r.qWer < r.fWer ? '#34d399' : 'var(--color-text)' }}>{r.qWer}%</td>
                      <td className="py-1.5 px-2 text-right" style={{ color: 'var(--color-text-muted)' }}>{r.fTtfr}ms</td>
                      <td className="py-1.5 px-2 text-right" style={{ color: r.fWer < r.qWer ? '#34d399' : 'var(--color-text)' }}>{r.fWer}%</td>
                      <td className="py-1.5 px-2 text-center" style={{ color: '#34d399' }}>{r.winner}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Chunk size tradeoff */}
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
                Chunk Size vs Accuracy (VoxPopuli FR, default: 1.0s)
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr style={{ color: 'var(--color-text-muted)' }}>
                      <th className="text-left py-1">Chunk</th>
                      <th className="text-right py-1">TTFR</th>
                      <th className="text-right py-1">WER</th>
                      <th className="text-right py-1">Est. RTX 4090</th>
                      <th className="text-left py-1 pl-3">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { chunk: '0.5s', ttfr: 980, wer: 13.7, est4090: '~625ms', note: 'Fastest, some accuracy loss' },
                      { chunk: '1.0s', ttfr: 1439, wer: 10.1, est4090: '~700ms', note: 'Best tradeoff (default)', active: true },
                      { chunk: '2.0s', ttfr: 2489, wer: 9.1, est4090: '~1150ms', note: 'Best accuracy' },
                      { chunk: '4.0s', ttfr: 4763, wer: 9.1, est4090: '~2200ms', note: 'No gain vs 2.0s' },
                    ].map(r => (
                      <tr key={r.chunk} className="border-t" style={{
                        borderColor: 'var(--color-border)',
                        background: r.active ? 'rgba(6,182,212,0.06)' : undefined,
                      }}>
                        <td className="py-1" style={{ color: r.active ? '#06b6d4' : 'var(--color-text)' }}>
                          {r.active ? `${r.chunk} *` : r.chunk}
                        </td>
                        <td className="py-1 text-right" style={{ color: 'var(--color-text-muted)' }}>{r.ttfr}ms</td>
                        <td className="py-1 text-right" style={{ color: r.wer <= 10.1 ? '#34d399' : '#fbbf24' }}>{r.wer}%</td>
                        <td className="py-1 text-right" style={{ color: 'var(--color-text-muted)' }}>{r.est4090}</td>
                        <td className="py-1 pl-3 text-left" style={{ color: 'var(--color-text-muted)', fontFamily: 'inherit' }}>{r.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* GPU recommendation */}
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
              <p className="text-xs font-semibold mb-1" style={{ color: 'var(--color-text)' }}>
                GPU Recommendation (Vast.ai, chunk=1.0s)
              </p>
              <div className="grid grid-cols-3 gap-2 text-xs">
                {[
                  { gpu: 'RTX 5090', price: '$0.31/hr', ttfr: '~800ms', label: 'Best value' },
                  { gpu: 'RTX 4090', price: '$0.59/hr', ttfr: '~700ms', label: 'Fastest' },
                  { gpu: 'L40S', price: '$0.47/hr', ttfr: '~750ms', label: 'Most VRAM' },
                ].map(g => (
                  <div key={g.gpu} className="rounded-lg p-2" style={{ background: 'var(--color-card-bg)', border: '1px solid var(--color-border)' }}>
                    <div className="font-semibold" style={{ color: 'var(--color-text)' }}>{g.gpu}</div>
                    <div style={{ color: 'var(--color-text-muted)' }}>{g.price} &middot; {g.ttfr}</div>
                    <div style={{ color: '#06b6d4', fontSize: '10px' }}>{g.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
