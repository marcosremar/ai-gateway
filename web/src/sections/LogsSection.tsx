'use client';

import { useState, useEffect, useCallback, useRef, Fragment, type ComponentType } from 'react';
import { getRequestLog, getMetrics, getTurnLatencies, type RequestLogEntry, type MetricsResponse, type TurnLatencyEntry } from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, StatusBadge, AlertBanner, Spinner, Toggle } from '@/components/ui';
import { ScrollText, BarChart3, RefreshCw, ChevronDown, ChevronUp, Clock, AlertCircle, Activity, Cpu } from 'lucide-react';
import { PROVIDER_ICON } from './FallbackChainList';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export function LogsSection() {
  const [entries, setEntries] = useState<RequestLogEntry[]>([]);
  const [stats, setStats] = useState<{ totalRequests: number; gpuPercent: number; avgLatencyMs: number; errors: number } | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [turnLatencies, setTurnLatencies] = useState<TurnLatencyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  const load = useCallback(async () => {
    try {
      const [logData, metricsData, turnData] = await Promise.all([
        getRequestLog(0, 100),
        getMetrics(),
        getTurnLatencies().catch(() => ({ count: 0, items: [] as TurnLatencyEntry[] })),
      ]);
      setEntries(logData.entries);
      setStats(logData.stats);
      setMetrics(metricsData);
      setTurnLatencies(turnData.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  // Reset to first page whenever the entries list changes
  useEffect(() => { setPage(0); }, [entries.length]);

  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const pagedEntries = entries.slice(page * pageSize, page * pageSize + pageSize);

  function toggleRowExpand(id: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (error) return <AlertBanner variant="error" className="m-6">{error}</AlertBanner>;
  if (loading) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;

  return (
    <div className="p-6 space-y-6">
      {/* Frame Inspector — live frame stream from /v1/observability/frames WS */}
      <FrameInspector />

      {/* Metrics Summary */}
      {metrics && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <BarChart3 className="w-5 h-5 text-blue-400" />
              <h3 className="font-semibold">Metrics</h3>
            </div>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <MetricCard
                label="Total Requests"
                value={String(metrics.requestsTotal)}
                accent="amber"
                icon={Activity}
                nonZero={metrics.requestsTotal > 0}
              />
              <MetricCard
                label="Errors"
                value={String(metrics.errorsTotal)}
                accent="red"
                icon={AlertCircle}
                variant={metrics.errorsTotal > 0 ? 'red' : 'emerald'}
                nonZero={metrics.errorsTotal > 0}
              />
              <MetricCard
                label="P50 Latency"
                value={`${metrics.latencyP50Ms}ms`}
                accent="blue"
                icon={Clock}
                nonZero={metrics.latencyP50Ms > 0}
              />
              <MetricCard
                label="P95 Latency"
                value={`${metrics.latencyP95Ms}ms`}
                accent="blue"
                icon={Clock}
                nonZero={metrics.latencyP95Ms > 0}
              />
              <MetricCard
                label="GPU Status"
                value={metrics.gpuStatus}
                accent="emerald"
                icon={Cpu}
                nonZero={metrics.gpuStatus !== 'idle' && metrics.gpuStatus !== 'none'}
              />
            </div>

            {Object.keys(metrics.requestsByStage || {}).length > 0 && (
              <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
                <div className="text-xs mb-3 font-medium" style={{ color: 'var(--color-text-muted)' }}>By Stage</div>
                <div className="flex gap-3 flex-wrap">
                  {Object.entries(metrics.requestsByStage || {}).map(([stage, count]) => (
                    <div key={stage} className="flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: 'var(--color-surface)' }}>
                      <span
                        className="w-2 h-2 rounded-sm flex-shrink-0"
                        style={{ background: stageBgColor(stage) }}
                      />
                      <span className="text-xs uppercase font-medium" style={{ color: 'var(--color-text-muted)' }}>{stage}</span>
                      <span className="font-mono text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{String(count)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Object.keys(metrics.requestsByProvider || {}).length > 0 && (
              <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
                <div className="text-xs mb-3 font-medium" style={{ color: 'var(--color-text-muted)' }}>By Provider</div>
                <div className="flex gap-3 flex-wrap">
                  {Object.entries(metrics.requestsByProvider || {}).map(([prov, count]) => {
                    const pi = PROVIDER_ICON[prov];
                    const Icon = pi?.icon;
                    return (
                      <div key={prov} className="flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: 'var(--color-surface)' }}>
                        {Icon && <Icon className="w-3 h-3 flex-shrink-0" style={{ color: pi.color }} />}
                        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{prov}</span>
                        <span className="font-mono text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{String(count)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Turn Latency (User-Bot) */}
      {turnLatencies.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Activity className="w-5 h-5" style={{ color: '#a78bfa' }} />
              <h3 className="font-semibold">Turn Latency</h3>
              <span className="text-xs px-2 py-0.5 rounded-full font-mono"
                style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}>
                {turnLatencies.length} turns
              </span>
            </div>
          </CardHeader>
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: 'var(--color-text-muted)' }}>
                    <th className="text-left pb-2 pr-3 font-medium">When</th>
                    <th className="text-right pb-2 pr-3 font-medium">Total</th>
                    <th className="text-right pb-2 pr-3 font-medium">STT TTFB</th>
                    <th className="text-right pb-2 pr-3 font-medium">STT Final</th>
                    <th className="text-right pb-2 pr-3 font-medium">LLM TTFT</th>
                    <th className="text-right pb-2 pr-3 font-medium">TTS TTFA</th>
                    <th className="text-left pb-2 font-medium">Providers</th>
                  </tr>
                </thead>
                <tbody>
                  {turnLatencies.slice(-20).reverse().map((t, i) => {
                    const totalColor = t.totalMs < 1500 ? '#34d399' : t.totalMs < 3000 ? '#fbbf24' : '#f87171';
                    const fmt = (n: number | null) => n == null ? '—' : `${Math.round(n)}ms`;
                    return (
                      <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td className="py-1.5 pr-3 font-mono" style={{ color: 'var(--color-text-muted)' }}>
                          {new Date(t.ts).toLocaleTimeString()}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono font-bold" style={{ color: totalColor }}>
                          {Math.round(t.totalMs)}ms
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono" style={{ color: 'var(--color-text-secondary)' }}>{fmt(t.sttTtfbMs)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono" style={{ color: 'var(--color-text-secondary)' }}>{fmt(t.sttFinalMs)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono" style={{ color: 'var(--color-text-secondary)' }}>{fmt(t.llmTtftMs)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono" style={{ color: 'var(--color-text-secondary)' }}>{fmt(t.ttsTtfaMs)}</td>
                        <td className="py-1.5 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                          {[t.providers.stt, t.providers.llm, t.providers.tts].filter(Boolean).join(' → ') || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Request Log */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ScrollText className="w-5 h-5" style={{ color: 'var(--color-text-muted)' }} />
              <h3 className="font-semibold">Request Log</h3>
              {stats && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-mono"
                  style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}
                >
                  {stats.totalRequests} total
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Toggle checked={autoRefresh} onChange={setAutoRefresh} />
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Auto-refresh</span>
              </div>
              <Button variant="ghost" size="sm" onClick={load}><RefreshCw className="w-3 h-3" /></Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {entries.length === 0 ? (
            <div className="flex flex-col items-center py-12 gap-3">
              <ScrollText className="w-10 h-10 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
              <p style={{ color: 'var(--color-text-muted)' }}>No requests logged yet.</p>
            </div>
          ) : (
            <>
            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-left text-xs"
                    style={{ color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' }}
                  >
                    <th className="pb-2 pr-4 font-medium">Time</th>
                    <th className="pb-2 pr-4 font-medium">Stage</th>
                    <th className="pb-2 pr-4 font-medium">Provider</th>
                    <th className="pb-2 pr-4 font-medium">Model</th>
                    <th className="pb-2 pr-4 font-medium">Latency</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 font-medium">Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedEntries.map(e => {
                    const isExpanded = expandedRows.has(String(e.id));
                    const rowTint = stageRowTint(e.stage);
                    const pi = PROVIDER_ICON[e.provider];
                    const ProviderIcon = pi?.icon;
                    return (
                      <Fragment key={e.id}>
                        <tr
                          style={{
                            borderTop: '1px solid var(--color-border)',
                            background: rowTint,
                          }}
                        >
                          <td className="py-2 pr-4 font-mono text-xs" style={{ color: 'var(--color-text-muted)' }}>
                            {new Date(e.timestamp).toLocaleTimeString()}
                          </td>
                          <td className="py-2 pr-4">
                            <StageBadge stage={e.stage} />
                          </td>
                          <td className="py-2 pr-4">
                            <div className="flex items-center gap-1.5">
                              {ProviderIcon && (
                                <ProviderIcon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: pi.color }} />
                              )}
                              <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{e.provider}</span>
                            </div>
                          </td>
                          <td className="py-2 pr-4 font-mono text-xs truncate max-w-[100px]" style={{ color: 'var(--color-text-muted)' }}>
                            {e.model || '-'}
                          </td>
                          <td className="py-2 pr-4 font-mono text-xs" style={{ color: 'var(--color-text)' }}>
                            {e.latencyMs}ms
                          </td>
                          <td className="py-2 pr-4">
                            {e.success ? (
                              <span className="text-emerald-400 text-xs font-medium">OK</span>
                            ) : (
                              <span className="text-red-400 text-xs font-medium" title={e.error || ''}>ERR</span>
                            )}
                          </td>
                          <td className="py-2">
                            {e.outputPreview ? (
                              <button
                                className="flex items-center gap-1 text-xs hover:opacity-80 transition-opacity"
                                style={{ color: 'var(--color-text-muted)' }}
                                onClick={() => toggleRowExpand(String(e.id))}
                              >
                                <span className="truncate max-w-[140px]">{e.outputPreview.slice(0, 40)}{e.outputPreview.length > 40 ? '…' : ''}</span>
                                {isExpanded
                                  ? <ChevronUp className="w-3 h-3 flex-shrink-0" />
                                  : <ChevronDown className="w-3 h-3 flex-shrink-0" />
                                }
                              </button>
                            ) : (
                              <span style={{ color: 'var(--color-text-muted)' }} className="text-xs">-</span>
                            )}
                          </td>
                        </tr>
                        {isExpanded && e.outputPreview && (
                          <tr
                            style={{ background: rowTint, borderTop: '1px solid var(--color-border)' }}
                          >
                            <td colSpan={7} className="pb-3 pt-1 px-2">
                              <div
                                className="text-xs rounded-lg p-3 font-mono leading-relaxed break-all"
                                style={{
                                  background: 'color-mix(in srgb, var(--color-surface) 80%, transparent)',
                                  color: 'var(--color-text-secondary)',
                                  border: '1px solid var(--color-border)',
                                }}
                              >
                                {e.outputPreview}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination controls */}
            <div
                className="flex items-center justify-between mt-3 pt-3"
                style={{ borderTop: '1px solid var(--color-border)' }}
              >
                {/* Page size selector */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Rows</span>
                  <div className="flex gap-1">
                    {PAGE_SIZE_OPTIONS.map(size => (
                      <button
                        key={size}
                        onClick={() => { setPageSize(size); setPage(0); }}
                        className="px-2 py-0.5 rounded text-[10px] font-mono transition-all cursor-pointer"
                        style={{
                          background: pageSize === size ? 'var(--color-btn-primary-bg)' : 'var(--color-surface)',
                          color: pageSize === size ? '#fff' : 'var(--color-text-muted)',
                          border: '1px solid',
                          borderColor: pageSize === size ? 'var(--color-btn-primary-bg)' : 'var(--color-border)',
                        }}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Page indicator + Prev/Next */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono" style={{ color: 'var(--color-text-muted)' }}>
                    Page {page + 1} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    className="text-[11px] px-2.5 py-1"
                  >
                    Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    className="text-[11px] px-2.5 py-1"
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function stageBgColor(stage: string): string {
  if (stage === 'stt') return '#38bdf8';
  if (stage === 'llm') return '#a78bfa';
  if (stage === 'tts') return '#fbbf24';
  if (stage === 'pipeline') return '#34d399';
  return 'var(--color-text-muted)';
}

function stageRowTint(stage: string): string {
  if (stage === 'stt') return 'color-mix(in srgb, #38bdf8 4%, transparent)';
  if (stage === 'llm') return 'color-mix(in srgb, #a78bfa 4%, transparent)';
  if (stage === 'tts') return 'color-mix(in srgb, #fbbf24 4%, transparent)';
  if (stage === 'pipeline') return 'color-mix(in srgb, #34d399 4%, transparent)';
  return 'transparent';
}

function stageColor(stage: string): 'emerald' | 'blue' | 'violet' | 'amber' | 'gray' {
  if (stage === 'stt') return 'blue';
  if (stage === 'llm') return 'violet';
  if (stage === 'tts') return 'amber';
  if (stage === 'pipeline') return 'emerald';
  return 'gray';
}

function StageBadge({ stage }: { stage: string }) {
  const color = stageBgColor(stage);
  return (
    <span
      className="inline-flex items-center text-xs font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md"
      style={{
        borderLeft: `3px solid ${color}`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color: color,
      }}
    >
      {stage}
    </span>
  );
}

function MetricCard({
  label,
  value,
  variant,
  accent,
  icon: Icon,
  nonZero,
}: {
  label: string;
  value: string;
  variant?: string;
  accent: 'blue' | 'red' | 'amber' | 'emerald';
  icon: ComponentType<{ className?: string }>;
  nonZero?: boolean;
}) {
  const accentColor = {
    blue:    '#38bdf8',
    red:     '#f87171',
    amber:   '#fbbf24',
    emerald: '#34d399',
  }[accent];

  const valueColor =
    variant === 'red'     ? '#f87171' :
    variant === 'emerald' ? '#34d399' :
    'var(--color-text)';

  return (
    <div
      className="rounded-xl p-3 relative overflow-hidden"
      style={{
        background: 'var(--color-surface)',
        borderTop: `2px solid ${accentColor}`,
        boxShadow: `0 0 12px color-mix(in srgb, ${accentColor} 10%, transparent)`,
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
        <div className="flex items-center gap-1.5">
          {nonZero && (
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: accentColor }}
            />
          )}
          <span style={{ color: accentColor }}><Icon className="w-3.5 h-3.5 opacity-40" /></span>
        </div>
      </div>
      <div className="font-mono font-semibold text-base" style={{ color: valueColor }}>{value}</div>
    </div>
  );
}

// ── Frame Inspector ─────────────────────────────────────────────────────────

interface FrameMessage {
  type: 'frame';
  frame: {
    kind: string;
    ts: number;
    stage?: string;
    provider?: string;
    meta?: Record<string, unknown>;
  };
}

function FrameInspector() {
  const [frames, setFrames] = useState<FrameMessage['frame'][]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const wsHost = window.location.hostname;
    const wsPort = parseInt(window.location.port || '443', 10) === 3000 ? 4001 : (parseInt(window.location.port || '443', 10) + 1);
    const apiKey = process.env.NEXT_PUBLIC_GATEWAY_API_KEY || '';
    const url = `ws://${wsHost}:${wsPort}/v1/observability/frames${apiKey ? `?token=${encodeURIComponent(apiKey)}` : ''}`;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => setConnected(true);
        ws.onclose = () => {
          setConnected(false);
          if (!stopped) setTimeout(connect, 2000);
        };
        ws.onerror = () => { try { ws.close(); } catch { /* no-op */ } };
        ws.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data) as FrameMessage | { type: 'connected' };
            if (data.type !== 'frame') return;
            setFrames((prev) => {
              const next = [...prev, data.frame];
              if (next.length > 200) next.splice(0, next.length - 200);
              return next;
            });
          } catch { /* ignore */ }
        };
      } catch {
        if (!stopped) setTimeout(connect, 2000);
      }
    };
    connect();
    return () => {
      stopped = true;
      try { wsRef.current?.close(); } catch { /* no-op */ }
    };
  }, []);

  const visible = frames.filter((f) => {
    if (paused) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return f.kind.toLowerCase().includes(q)
      || (f.stage || '').toLowerCase().includes(q)
      || (f.provider || '').toLowerCase().includes(q);
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Activity className="w-5 h-5" style={{ color: connected ? '#34d399' : '#71717a' }} />
            <h3 className="font-semibold">Frame Inspector</h3>
            <span className="text-xs px-2 py-0.5 rounded-full font-mono"
              style={{ background: 'var(--color-surface)', color: connected ? '#34d399' : 'var(--color-text-muted)' }}>
              {connected ? 'live' : 'reconnecting'}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full font-mono"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}>
              {frames.length} frames
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="filter kind/stage/provider"
              className="text-[11px] rounded-md border px-2 py-1 outline-none w-48"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text)' }}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Button size="sm" variant="ghost" onClick={() => setPaused(p => !p)}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFrames([])}>Clear</Button>
          </div>
        </div>
      </CardHeader>
      <CardBody>
        {visible.length === 0 ? (
          <p className="text-center py-6 text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {paused ? 'Paused — resume to see live frames.' : 'No frames yet. Trigger /v1/translate or /v1/speech to see activity.'}
          </p>
        ) : (
          <div className="overflow-y-auto max-h-80 font-mono text-[11px]" style={{ borderTop: '1px solid var(--color-border)' }}>
            {visible.slice(-100).reverse().map((f, i) => {
              const kindColor = f.kind.startsWith('user_') ? '#60a5fa'
                : f.kind.startsWith('stt_') ? '#3b82f6'
                : f.kind.startsWith('llm_') ? '#a78bfa'
                : f.kind.startsWith('tts_') ? '#fbbf24'
                : f.kind.startsWith('bot_') ? '#34d399'
                : '#f87171';
              return (
                <div key={`${f.ts}-${i}`} className="flex items-baseline gap-2 py-1 px-2"
                  style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {new Date(f.ts).toLocaleTimeString()}.{String(f.ts % 1000).padStart(3, '0')}
                  </span>
                  <span className="font-bold" style={{ color: kindColor }}>{f.kind}</span>
                  {f.stage && <span style={{ color: 'var(--color-text-muted)' }}>[{f.stage}]</span>}
                  {f.provider && <span style={{ color: 'var(--color-text-secondary)' }}>{f.provider}</span>}
                  {f.meta && (
                    <span className="truncate flex-1" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
                      {JSON.stringify(f.meta).slice(0, 200)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
