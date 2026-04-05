'use client';

import { useState, useEffect, useCallback, type ComponentType } from 'react';
import { getRequestLog, getMetrics, type RequestLogEntry, type MetricsResponse } from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, StatusBadge, AlertBanner, Spinner, Toggle } from '@/components/ui';
import { ScrollText, BarChart3, RefreshCw, ChevronDown, ChevronUp, Clock, AlertCircle, Activity, Cpu } from 'lucide-react';
import { PROVIDER_ICON } from './FallbackChainList';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export function LogsSection() {
  const [entries, setEntries] = useState<RequestLogEntry[]>([]);
  const [stats, setStats] = useState<{ totalRequests: number; gpuPercent: number; avgLatencyMs: number; errors: number } | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  const load = useCallback(async () => {
    try {
      const [logData, metricsData] = await Promise.all([
        getRequestLog(0, 100),
        getMetrics(),
      ]);
      setEntries(logData.entries);
      setStats(logData.stats);
      setMetrics(metricsData);
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
                      <>
                        <tr
                          key={e.id}
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
                            key={`${e.id}-expand`}
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
                      </>
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
