'use client';

import { useState, useEffect, useCallback } from 'react';
import { getRequestLog, getMetrics, type RequestLogEntry, type MetricsResponse } from '@/lib/gateway';
import { Card, CardHeader, CardBody, Button, StatusBadge, AlertBanner, Spinner, Toggle } from '@/components/ui';
import { ScrollText, BarChart3, RefreshCw } from 'lucide-react';

export function LogsSection() {
  const [entries, setEntries] = useState<RequestLogEntry[]>([]);
  const [stats, setStats] = useState<{ totalRequests: number; gpuPercent: number; avgLatencyMs: number; errors: number } | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

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
              <MetricCard label="Total Requests" value={String(metrics.requestsTotal)} />
              <MetricCard label="Errors" value={String(metrics.errorsTotal)} variant={metrics.errorsTotal > 0 ? 'red' : 'emerald'} />
              <MetricCard label="P50 Latency" value={`${metrics.latencyP50Ms}ms`} />
              <MetricCard label="P95 Latency" value={`${metrics.latencyP95Ms}ms`} />
              <MetricCard label="GPU Status" value={metrics.gpuStatus} />
            </div>
            {Object.keys(metrics.requestsByStage).length > 0 && (
              <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--color-border-light)' }}>
                <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>By Stage</div>
                <div className="flex gap-3">
                  {Object.entries(metrics.requestsByStage).map(([stage, count]) => (
                    <div key={stage} className="flex items-center gap-2">
                      <span className="text-xs uppercase" style={{ color: 'var(--color-text-muted)' }}>{stage}</span>
                      <span className="font-mono text-sm">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(metrics.requestsByProvider).length > 0 && (
              <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-border-light)' }}>
                <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>By Provider</div>
                <div className="flex gap-3">
                  {Object.entries(metrics.requestsByProvider).map(([prov, count]) => (
                    <div key={prov} className="flex items-center gap-2">
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{prov}</span>
                      <span className="font-mono text-sm">{count}</span>
                    </div>
                  ))}
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
              {stats && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{stats.totalRequests} total</span>}
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
            <p className="text-center py-8" style={{ color: 'var(--color-text-muted)' }}>No requests logged yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    <th className="pb-2 font-medium">Time</th>
                    <th className="pb-2 font-medium">Stage</th>
                    <th className="pb-2 font-medium">Provider</th>
                    <th className="pb-2 font-medium">Model</th>
                    <th className="pb-2 font-medium">Latency</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => (
                    <tr key={e.id} className="border-t" style={{ borderColor: 'var(--color-border-light)' }}>
                      <td className="py-2 font-mono text-xs">{new Date(e.timestamp).toLocaleTimeString()}</td>
                      <td className="py-2"><StatusBadge variant={stageColor(e.stage)}>{e.stage}</StatusBadge></td>
                      <td className="py-2 text-xs">{e.provider}</td>
                      <td className="py-2 font-mono text-xs truncate max-w-[100px]">{e.model || '-'}</td>
                      <td className="py-2 font-mono text-xs">{e.latencyMs}ms</td>
                      <td className="py-2">
                        {e.success ? (
                          <span className="text-emerald-400 text-xs">OK</span>
                        ) : (
                          <span className="text-red-400 text-xs" title={e.error || ''}>ERR</span>
                        )}
                      </td>
                      <td className="py-2 text-xs truncate max-w-[200px]" style={{ color: 'var(--color-text-muted)' }} title={e.outputPreview || ''}>
                        {e.outputPreview || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function stageColor(stage: string): 'emerald' | 'blue' | 'violet' | 'amber' | 'gray' {
  if (stage === 'stt') return 'blue';
  if (stage === 'llm') return 'violet';
  if (stage === 'tts') return 'amber';
  if (stage === 'pipeline') return 'emerald';
  return 'gray';
}

function MetricCard({ label, value, variant }: { label: string; value: string; variant?: string }) {
  return (
    <div className="p-3 rounded-xl" style={{ background: 'var(--color-surface)' }}>
      <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
      <div className={`font-mono font-semibold ${variant === 'red' ? 'text-red-400' : variant === 'emerald' ? 'text-emerald-400' : ''}`}>{value}</div>
    </div>
  );
}
