'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getRequestLog, getMetrics, getGpuStatus, getGpuReputation,
  type RequestLogEntry, type MetricsResponse, type GpuStatusResponse, type ReputationHost,
} from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, StatusBadge, AlertBanner, Spinner,
} from '@/components/ui';
import {
  BarChart3, TrendingUp, DollarSign, AlertTriangle, Cpu, Cloud,
  ArrowRight, Clock, Activity, Zap, Shield,
} from 'lucide-react';

interface ProviderStats {
  name: string;
  requests: number;
  avgLatencyMs: number;
  errorRate: number;
  errors: number;
  successRate: number;
  stages: Set<string>;
}

interface StagePercentile {
  stage: string;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  samples: number;
}

interface ErrorGroup {
  error: string;
  count: number;
  stage: string;
  provider: string;
  lastSeen: number;
}

function computeProviderStats(entries: RequestLogEntry[]): ProviderStats[] {
  const map = new Map<string, { latencies: number[]; errors: number; stages: Set<string> }>();
  for (const e of entries) {
    if (!map.has(e.provider)) map.set(e.provider, { latencies: [], errors: 0, stages: new Set() });
    const s = map.get(e.provider)!;
    s.latencies.push(e.latencyMs);
    s.stages.add(e.stage);
    if (!e.success) s.errors++;
  }
  return Array.from(map.entries()).map(([name, s]) => ({
    name,
    requests: s.latencies.length,
    avgLatencyMs: Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length),
    errors: s.errors,
    errorRate: s.errors / s.latencies.length,
    successRate: 1 - s.errors / s.latencies.length,
    stages: s.stages,
  })).sort((a, b) => b.requests - a.requests);
}

function computePercentiles(entries: RequestLogEntry[]): StagePercentile[] {
  const byStage = new Map<string, number[]>();
  for (const e of entries) {
    if (!e.success) continue;
    if (!byStage.has(e.stage)) byStage.set(e.stage, []);
    byStage.get(e.stage)!.push(e.latencyMs);
  }
  return Array.from(byStage.entries()).map(([stage, lats]) => {
    const sorted = [...lats].sort((a, b) => a - b);
    const p = (pct: number) => sorted[Math.min(Math.floor(sorted.length * pct), sorted.length - 1)] || 0;
    return { stage, p50: p(0.5), p75: p(0.75), p90: p(0.9), p99: p(0.99), samples: sorted.length };
  }).sort((a, b) => a.stage.localeCompare(b.stage));
}

function computeErrorGroups(entries: RequestLogEntry[]): ErrorGroup[] {
  const map = new Map<string, ErrorGroup>();
  for (const e of entries) {
    if (e.success || !e.error) continue;
    const key = `${e.error}|${e.stage}|${e.provider}`;
    if (!map.has(key)) {
      map.set(key, { error: e.error, count: 0, stage: e.stage, provider: e.provider, lastSeen: e.timestamp });
    }
    const g = map.get(key)!;
    g.count++;
    g.lastSeen = Math.max(g.lastSeen, e.timestamp);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

const STAGE_COLORS: Record<string, string> = {
  stt: '#38bdf8',
  llm: '#a78bfa',
  tts: '#fbbf24',
  pipeline: '#34d399',
};

export function ReportsSection() {
  const [entries, setEntries] = useState<RequestLogEntry[]>([]);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [gpu, setGpu] = useState<GpuStatusResponse | null>(null);
  const [hosts, setHosts] = useState<ReputationHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [logData, metricsData, gpuData, repData] = await Promise.all([
        getRequestLog(0, 500),
        getMetrics(),
        getGpuStatus().catch(() => null),
        getGpuReputation().catch(() => ({ hosts: [] })),
      ]);
      setEntries(logData.entries);
      setMetrics(metricsData);
      setGpu(gpuData);
      setHosts(repData.hosts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load report data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <AlertBanner variant="error" className="m-6">{error}</AlertBanner>;
  if (loading) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;

  const providerStats = computeProviderStats(entries);
  const percentiles = computePercentiles(entries);
  const errorGroups = computeErrorGroups(entries);
  const totalRequests = entries.length;
  const gpuRequests = entries.filter(e => e.provider === 'gpu').length;
  const cloudRequests = totalRequests - gpuRequests;
  const gpuPct = totalRequests > 0 ? (gpuRequests / totalRequests * 100) : 0;
  const cloudPct = totalRequests > 0 ? (cloudRequests / totalRequests * 100) : 0;
  const totalErrors = entries.filter(e => !e.success).length;
  const errorRate = totalRequests > 0 ? (totalErrors / totalRequests * 100) : 0;

  // Cost estimate
  const gpuCostPerHr = gpu?.costPerHr || 0;
  const gpuUptimeHrs = (gpu?.elapsedSec || 0) / 3600;
  const sessionCost = gpuCostPerHr * gpuUptimeHrs;
  const costPerRequest = gpuRequests > 0 ? sessionCost / gpuRequests : 0;

  // Max latency for bar scaling
  const maxLatency = Math.max(...providerStats.map(p => p.avgLatencyMs), 1);

  return (
    <div className="p-6 space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="report-summary">
        <SummaryCard
          icon={Activity} color="#60a5fa" label="Total Requests"
          value={String(totalRequests)}
        />
        <SummaryCard
          icon={AlertTriangle}
          color={errorRate > 5 ? '#f87171' : '#34d399'}
          label="Error Rate"
          value={`${errorRate.toFixed(1)}%`}
        />
        <SummaryCard
          icon={DollarSign} color="#fbbf24" label="Session Cost"
          value={sessionCost > 0 ? `$${sessionCost.toFixed(2)}` : '$0.00'}
        />
        <SummaryCard
          icon={Cpu} color="#a78bfa" label="GPU Routing"
          value={`${gpuPct.toFixed(0)}%`}
        />
      </div>

      {/* Provider Comparison */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in srgb, #60a5fa 15%, transparent)' }}>
              <BarChart3 className="w-4 h-4" style={{ color: '#60a5fa' }} />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Provider Comparison</h3>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Performance by provider</p>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {providerStats.length === 0 ? (
            <p className="text-center py-6 text-sm" style={{ color: 'var(--color-text-muted)' }}>No request data available</p>
          ) : (
            <div className="space-y-4" data-testid="provider-comparison">
              {providerStats.map(p => (
                <div key={p.name} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium capitalize">{p.name}</span>
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        {p.requests} requests
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm font-bold">{p.avgLatencyMs}ms</span>
                      <StatusBadge variant={p.errorRate > 0.1 ? 'red' : p.errorRate > 0 ? 'amber' : 'emerald'}>
                        {(p.successRate * 100).toFixed(0)}% OK
                      </StatusBadge>
                    </div>
                  </div>
                  {/* Latency bar */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                      <div
                        className="h-3 rounded-full transition-all duration-500"
                        style={{
                          width: `${(p.avgLatencyMs / maxLatency) * 100}%`,
                          background: p.avgLatencyMs < 150 ? '#34d399'
                            : p.avgLatencyMs < 300 ? '#60a5fa'
                            : p.avgLatencyMs < 500 ? '#fbbf24' : '#f87171',
                        }}
                      />
                    </div>
                  </div>
                  {/* Stages this provider serves */}
                  <div className="flex gap-1.5">
                    {Array.from(p.stages).map(s => (
                      <span key={s} className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase"
                        style={{
                          background: `color-mix(in srgb, ${STAGE_COLORS[s] || '#737373'} 15%, transparent)`,
                          color: STAGE_COLORS[s] || 'var(--color-text-muted)',
                        }}>
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Latency Distribution + GPU vs Cloud — side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Latency Distribution */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in srgb, #a78bfa 15%, transparent)' }}>
                <TrendingUp className="w-4 h-4" style={{ color: '#a78bfa' }} />
              </div>
              <div>
                <h3 className="text-sm font-semibold">Latency Distribution</h3>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Percentiles by stage</p>
              </div>
            </div>
          </CardHeader>
          <CardBody>
            {percentiles.length === 0 ? (
              <p className="text-center py-6 text-sm" style={{ color: 'var(--color-text-muted)' }}>No latency data</p>
            ) : (
              <div className="space-y-4" data-testid="latency-distribution">
                {percentiles.map(s => {
                  const color = STAGE_COLORS[s.stage] || '#737373';
                  const maxP = Math.max(s.p99, 1);
                  return (
                    <div key={s.stage} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase" style={{ color }}>{s.stage}</span>
                        <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{s.samples} samples</span>
                      </div>
                      {/* Percentile bars stacked */}
                      <div className="relative h-6 rounded-lg overflow-hidden" style={{ background: 'var(--color-border)' }}>
                        <div className="absolute inset-y-0 left-0 rounded-lg" style={{ width: `${(s.p99 / maxP) * 100}%`, background: `color-mix(in srgb, ${color} 15%, transparent)` }} />
                        <div className="absolute inset-y-0 left-0 rounded-lg" style={{ width: `${(s.p90 / maxP) * 100}%`, background: `color-mix(in srgb, ${color} 30%, transparent)` }} />
                        <div className="absolute inset-y-0 left-0 rounded-lg" style={{ width: `${(s.p75 / maxP) * 100}%`, background: `color-mix(in srgb, ${color} 50%, transparent)` }} />
                        <div className="absolute inset-y-0 left-0 rounded-lg" style={{ width: `${(s.p50 / maxP) * 100}%`, background: color }} />
                      </div>
                      <div className="flex justify-between text-[10px] font-mono" style={{ color: 'var(--color-text-muted)' }}>
                        <span>P50: {s.p50}ms</span>
                        <span>P75: {s.p75}ms</span>
                        <span>P90: {s.p90}ms</span>
                        <span>P99: {s.p99}ms</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>

        {/* GPU vs Cloud */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in srgb, #34d399 15%, transparent)' }}>
                <Zap className="w-4 h-4" style={{ color: '#34d399' }} />
              </div>
              <div>
                <h3 className="text-sm font-semibold">GPU vs Cloud</h3>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Request routing split</p>
              </div>
            </div>
          </CardHeader>
          <CardBody>
            <div className="space-y-4" data-testid="gpu-vs-cloud">
              {/* Visual donut-style split */}
              <div className="flex items-center gap-6">
                <div className="relative w-28 h-28 flex-shrink-0">
                  <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                    <circle cx="18" cy="18" r="14" fill="none" stroke="var(--color-border)" strokeWidth="4" />
                    {gpuPct > 0 && (
                      <circle
                        cx="18" cy="18" r="14" fill="none" stroke="#a78bfa" strokeWidth="4"
                        strokeDasharray={`${gpuPct * 0.88} ${100 - gpuPct * 0.88}`}
                        strokeDashoffset="0"
                      />
                    )}
                    {cloudPct > 0 && (
                      <circle
                        cx="18" cy="18" r="14" fill="none" stroke="#60a5fa" strokeWidth="4"
                        strokeDasharray={`${cloudPct * 0.88} ${100 - cloudPct * 0.88}`}
                        strokeDashoffset={`${-gpuPct * 0.88}`}
                      />
                    )}
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-bold font-mono">{totalRequests}</span>
                  </div>
                </div>
                <div className="space-y-3 flex-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-sm" style={{ background: '#a78bfa' }} />
                      <Cpu className="w-3.5 h-3.5" style={{ color: '#a78bfa' }} />
                      <span className="text-sm">GPU</span>
                    </div>
                    <div className="text-right">
                      <span className="font-mono font-bold text-sm">{gpuRequests}</span>
                      <span className="text-xs ml-1" style={{ color: 'var(--color-text-muted)' }}>({gpuPct.toFixed(0)}%)</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-sm" style={{ background: '#60a5fa' }} />
                      <Cloud className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />
                      <span className="text-sm">Cloud</span>
                    </div>
                    <div className="text-right">
                      <span className="font-mono font-bold text-sm">{cloudRequests}</span>
                      <span className="text-xs ml-1" style={{ color: 'var(--color-text-muted)' }}>({cloudPct.toFixed(0)}%)</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Stage breakdown */}
              {metrics && Object.keys(metrics.requestsByStage).length > 0 && (
                <div className="pt-3 border-t space-y-2" style={{ borderColor: 'var(--color-border-light)' }}>
                  <div className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>By Stage</div>
                  {Object.entries(metrics.requestsByStage).map(([stage, count]) => (
                    <div key={stage} className="flex items-center gap-2">
                      <span className="text-xs font-bold uppercase w-14" style={{ color: STAGE_COLORS[stage] || 'var(--color-text-muted)' }}>{stage}</span>
                      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                        <div className="h-2 rounded-full" style={{
                          width: `${(count / Math.max(...Object.values(metrics.requestsByStage), 1)) * 100}%`,
                          background: STAGE_COLORS[stage] || '#737373',
                        }} />
                      </div>
                      <span className="font-mono text-xs w-8 text-right">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Cost Analysis */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in srgb, #fbbf24 15%, transparent)' }}>
              <DollarSign className="w-4 h-4" style={{ color: '#fbbf24' }} />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Cost Analysis</h3>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>GPU compute costs</p>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="cost-analysis">
            <CostCard label="Rate" value={gpuCostPerHr > 0 ? `$${gpuCostPerHr.toFixed(3)}/hr` : 'N/A'} />
            <CostCard label="Uptime" value={gpuUptimeHrs > 0 ? `${gpuUptimeHrs.toFixed(1)}h` : '0h'} />
            <CostCard label="Session Cost" value={`$${sessionCost.toFixed(2)}`} highlight={sessionCost > 1} />
            <CostCard label="Cost/Request" value={costPerRequest > 0 ? `$${costPerRequest.toFixed(4)}` : 'N/A'} />
          </div>

          {/* Host cost leaderboard */}
          {hosts.length > 0 && (
            <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--color-border-light)' }}>
              <div className="text-xs font-medium mb-3" style={{ color: 'var(--color-text-muted)' }}>Historical Host Costs</div>
              <div className="space-y-2">
                {hosts.slice(0, 5).map(h => (
                  <div key={h.hostKey} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono truncate max-w-[120px]">{h.hostKey}</span>
                      <StatusBadge variant={h.reputationScore > 0.7 ? 'emerald' : h.reputationScore > 0.4 ? 'amber' : 'red'}>
                        {(h.reputationScore * 100).toFixed(0)}
                      </StatusBadge>
                    </div>
                    <div className="flex items-center gap-4">
                      <span style={{ color: 'var(--color-text-muted)' }}>{h.deployCount} deploys</span>
                      <span className="font-mono font-bold">${h.totalCostUsd.toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Error Analysis */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in srgb, #f87171 15%, transparent)' }}>
              <AlertTriangle className="w-4 h-4" style={{ color: '#f87171' }} />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Error Analysis</h3>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {totalErrors} errors out of {totalRequests} requests ({errorRate.toFixed(1)}%)
              </p>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {errorGroups.length === 0 ? (
            <div className="text-center py-6">
              <div className="text-2xl mb-2">&#10003;</div>
              <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No errors recorded</p>
            </div>
          ) : (
            <div className="space-y-3" data-testid="error-analysis">
              {errorGroups.map((g, i) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-lg" style={{ background: 'color-mix(in srgb, #f87171 4%, var(--color-surface))' }}>
                  <div className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center font-mono font-bold text-sm" style={{ background: 'color-mix(in srgb, #f87171 15%, transparent)', color: '#f87171' }}>
                    {g.count}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{g.error}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <StatusBadge variant={STAGE_COLORS[g.stage] ? 'blue' : 'gray'}>{g.stage}</StatusBadge>
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{g.provider}</span>
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        Last: {formatTimeAgo(g.lastSeen)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Host Reliability */}
      {hosts.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in srgb, #10b981 15%, transparent)' }}>
                <Shield className="w-4 h-4" style={{ color: '#10b981' }} />
              </div>
              <div>
                <h3 className="text-sm font-semibold">Host Reliability</h3>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Deployment success and performance</p>
              </div>
            </div>
          </CardHeader>
          <CardBody>
            <div className="space-y-4" data-testid="host-reliability">
              {hosts.map(h => {
                const successRate = h.deployCount > 0 ? (h.successCount / h.deployCount * 100) : 0;
                return (
                  <div key={h.hostKey} className="p-3 rounded-lg" style={{ background: 'var(--color-surface)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs truncate max-w-[140px]">{h.hostKey}</span>
                        <span className="text-xs capitalize px-1.5 py-0.5 rounded"
                          style={{
                            background: h.tier === 'gold' ? 'color-mix(in srgb, #fbbf24 15%, transparent)' : h.tier === 'silver' ? 'color-mix(in srgb, #94a3b8 15%, transparent)' : 'color-mix(in srgb, #cd7f32 15%, transparent)',
                            color: h.tier === 'gold' ? '#fbbf24' : h.tier === 'silver' ? '#94a3b8' : '#cd7f32',
                          }}>
                          {h.tier}
                        </span>
                      </div>
                      <div className="text-lg font-bold font-mono" style={{
                        color: h.reputationScore > 0.7 ? '#34d399' : h.reputationScore > 0.4 ? '#fbbf24' : '#f87171',
                      }}>
                        {(h.reputationScore * 100).toFixed(0)}
                      </div>
                    </div>
                    {/* Stats row */}
                    <div className="grid grid-cols-4 gap-2 text-xs">
                      <div>
                        <div style={{ color: 'var(--color-text-muted)' }}>Success</div>
                        <div className="font-mono font-bold">{successRate.toFixed(0)}%</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--color-text-muted)' }}>Boot</div>
                        <div className="font-mono font-bold">{h.avgBootTimeS.toFixed(0)}s</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--color-text-muted)' }}>Latency</div>
                        <div className="font-mono font-bold">{h.avgLatencyMs}ms</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--color-text-muted)' }}>GPU</div>
                        <div className="font-mono font-bold truncate">{h.gpuType.replace('NVIDIA ', '')}</div>
                      </div>
                    </div>
                    {/* Reliability bar */}
                    <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                      <div className="h-1.5 rounded-full" style={{
                        width: `${successRate}%`,
                        background: successRate > 80 ? '#34d399' : successRate > 50 ? '#fbbf24' : '#f87171',
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, color }: { icon: typeof Activity; label: string; value: string; color: string }) {
  return (
    <div className="p-4 rounded-xl border card-hover" style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
      </div>
      <div className="font-mono text-xl font-bold leading-none mb-1">{value}</div>
      <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
    </div>
  );
}

function CostCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="p-3 rounded-xl" style={{ background: 'var(--color-surface)' }}>
      <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
      <div className={`font-mono font-semibold ${highlight ? 'text-amber-400' : ''}`}>{value}</div>
    </div>
  );
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
