'use client';

import { useState, useEffect, useCallback } from 'react';
import { useGateway } from '@/hooks/useGateway';
import { useGpuStatus } from '@/hooks/useGpuStatus';
import { useGpuList } from '@/hooks/useGpuList';
import { useBotStatus } from '@/hooks/useBotStatus';
import { getRequestLog, type RequestLogEntry } from '@/lib/gateway';
import { AlertBanner, Spinner } from '@/components/ui';
import { PipelineHealthCard } from './PipelineHealthCard';
import {
  Activity, Cpu, Bot, Clock, Zap, DollarSign,
  Wifi, WifiOff, Snowflake, Flame, TrendingUp, Server,
  type LucideIcon,
} from 'lucide-react';

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface StageLatency {
  cold: number | null;
  warm: number | null;
  samples: number;
  provider: string;
}

function computeStageLatencies(entries: RequestLogEntry[]): Record<string, StageLatency> {
  const byStage: Record<string, RequestLogEntry[]> = {};
  for (const e of entries) {
    if (!e.success) continue;
    if (!byStage[e.stage]) byStage[e.stage] = [];
    byStage[e.stage].push(e);
  }
  const result: Record<string, StageLatency> = {};
  for (const [stage, stageEntries] of Object.entries(byStage)) {
    const sorted = [...stageEntries].sort((a, b) => a.timestamp - b.timestamp);
    const provider = sorted[sorted.length - 1]?.provider || '';
    if (sorted.length === 0) { result[stage] = { cold: null, warm: null, samples: 0, provider }; continue; }
    const coldLatencies: number[] = [];
    const warmLatencies: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const gap = i === 0 ? Infinity : sorted[i].timestamp - sorted[i - 1].timestamp;
      if (gap > 60000) coldLatencies.push(sorted[i].latencyMs);
      else warmLatencies.push(sorted[i].latencyMs);
    }
    result[stage] = {
      cold: coldLatencies.length > 0 ? Math.round(coldLatencies.reduce((a, b) => a + b, 0) / coldLatencies.length) : null,
      warm: warmLatencies.length > 0 ? Math.round(warmLatencies.reduce((a, b) => a + b, 0) / warmLatencies.length) : null,
      samples: sorted.length,
      provider,
    };
  }
  return result;
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color, sub }: {
  icon: LucideIcon; label: string; value: string; color: string; sub?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border p-4 transition-all"
      style={{
        borderColor: `color-mix(in srgb, ${color} 18%, var(--color-border))`,
        background: 'var(--color-surface-elevated)',
        borderTop: `2px solid ${color}`,
      }}>
      {/* Subtle glow in corner */}
      <div className="absolute top-0 right-0 w-20 h-20 pointer-events-none"
        style={{
          background: `radial-gradient(circle at 100% 0%, color-mix(in srgb, ${color} 8%, transparent) 0%, transparent 70%)`,
        }} />
      <div className="flex items-start justify-between mb-2.5">
        <span className="text-[10px] font-semibold uppercase"
          style={{ color: 'var(--color-text-muted)', letterSpacing: '0.1em' }}>
          {label}
        </span>
        <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
          <Icon className="w-3.5 h-3.5" style={{ color }} />
        </div>
      </div>
      <div className="font-mono text-2xl font-bold leading-none tracking-tight mb-1">
        {value}
      </div>
      {sub && (
        <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{sub}</div>
      )}
    </div>
  );
}

// ── GPU Instance Tile ─────────────────────────────────────────────────────────

function GpuTile({ inst }: { inst: ReturnType<typeof useGpuList>['instances'][0] }) {
  const isReady = inst.isActive || inst.status === 'ready';
  const isBooting = ['creating', 'booting', 'loading', 'installing'].includes(inst.status);
  const isError = inst.status === 'error';

  const dotColor = isError ? '#ef4444' : isReady ? '#10b981' : isBooting ? '#f59e0b' : '#52525b';
  const bgAccent = isError
    ? 'color-mix(in srgb, #ef4444 5%, transparent)'
    : isReady
      ? 'color-mix(in srgb, #10b981 5%, transparent)'
      : isBooting
        ? 'color-mix(in srgb, #f59e0b 5%, transparent)'
        : 'transparent';

  const elapsed = inst.elapsedSec ?? 0;
  const bootPct = isBooting ? Math.min(90, Math.max(5, elapsed * 0.5)) : 0;

  return (
    <div className="rounded-lg border p-2.5 transition-all"
      style={{
        borderColor: `color-mix(in srgb, ${dotColor} 22%, var(--color-border))`,
        background: bgAccent,
      }}>
      <div className="flex items-center gap-2 mb-1.5">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isBooting ? 'animate-pulse' : ''}`}
          style={{ background: dotColor }} />
        <span className="text-[11px] font-semibold truncate flex-1" style={{ color: 'var(--color-text)' }}>
          {inst.gpuType?.replace('NVIDIA ', '').replace('GeForce ', '') || inst.provider}
        </span>
        {inst.isActive && (
          <span className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{ background: 'color-mix(in srgb, #10b981 14%, transparent)', color: '#34d399', letterSpacing: '0.08em' }}>
            ACTIVE
          </span>
        )}
      </div>
      <div className="flex items-center justify-between text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
        <span className="capitalize">{inst.provider}{elapsed > 0 ? ` · ${formatUptime(elapsed)}` : ''}</span>
        {inst.costPerHr ? (
          <span className="font-mono font-semibold" style={{ color: '#fbbf24' }}>
            ${inst.costPerHr.toFixed(3)}/hr
          </span>
        ) : (
          <span className="capitalize font-medium" style={{ color: dotColor }}>{inst.status}</span>
        )}
      </div>
      {isBooting && (
        <div className="mt-2 w-full rounded-full overflow-hidden" style={{ height: '3px', background: 'var(--color-border)' }}>
          <div className="h-full rounded-full animate-pulse transition-all duration-1000"
            style={{ width: `${bootPct}%`, background: '#f59e0b' }} />
        </div>
      )}
    </div>
  );
}

// ── Provider Bar Row ──────────────────────────────────────────────────────────

function ProviderBar({ name, requests, avgLatencyMs, errorRate, maxRequests }: {
  name: string; requests: number; avgLatencyMs: number; errorRate: number; maxRequests: number;
}) {
  const barPct = maxRequests > 0 ? (requests / maxRequests) * 100 : 0;
  const latColor = avgLatencyMs < 300 ? '#10b981' : avgLatencyMs < 800 ? '#f59e0b' : '#ef4444';
  const errColor = errorRate > 0.1 ? '#ef4444' : errorRate > 0 ? '#f59e0b' : '#10b981';

  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-0"
      style={{ borderColor: 'var(--color-border)' }}>
      <span className="text-[11px] font-semibold capitalize w-20 flex-shrink-0" style={{ color: 'var(--color-text)' }}>
        {name}
      </span>
      {/* Mini bar */}
      <div className="flex-1 h-1.5 rounded-full overflow-hidden"
        style={{ background: 'var(--color-border)' }}>
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${barPct}%`, background: 'color-mix(in srgb, #60a5fa 70%, #a78bfa)' }} />
      </div>
      <span className="text-[10px] font-mono w-8 text-right flex-shrink-0"
        style={{ color: 'var(--color-text-muted)' }}>
        {requests}
      </span>
      <span className="text-[10px] font-mono w-14 text-right flex-shrink-0 font-semibold"
        style={{ color: latColor }}>
        {avgLatencyMs.toFixed(0)}ms
      </span>
      <span className="text-[10px] font-mono w-8 text-right flex-shrink-0"
        style={{ color: errColor }}>
        {(errorRate * 100).toFixed(0)}%
      </span>
    </div>
  );
}

// ── Main Section ──────────────────────────────────────────────────────────────

export function OverviewSection() {
  const { health, error } = useGateway();
  const { gpu } = useGpuStatus(true, 10000);
  const { instances: gpuInstances } = useGpuList(true, 10000);
  const { bot } = useBotStatus(true, 10000);
  const [stageLatencies, setStageLatencies] = useState<Record<string, StageLatency>>({});

  const loadLatencies = useCallback(async () => {
    try {
      const log = await getRequestLog(0, 100);
      setStageLatencies(computeStageLatencies(log.entries));
    } catch {}
  }, []);

  useEffect(() => { loadLatencies(); }, [loadLatencies]);
  useEffect(() => {
    const id = setInterval(loadLatencies, 30000);
    return () => clearInterval(id);
  }, [loadLatencies]);

  if (error) return <AlertBanner variant="error" className="m-6">Gateway unavailable: {error}</AlertBanner>;
  if (!health) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;

  const isOnline = health.status === 'ok';
  const statusColor = isOnline ? '#10b981' : '#f59e0b';
  const providerEntries = Object.entries(health.providerMetrics);
  const maxRequests = Math.max(...providerEntries.map(([, m]) => m.requests), 1);

  return (
    <div className="p-6 space-y-5">

      {/* ── Status strip ── */}
      <div className="flex items-stretch rounded-xl border overflow-hidden"
        style={{
          borderColor: `color-mix(in srgb, ${statusColor} 22%, var(--color-border))`,
          background: 'var(--color-surface-elevated)',
        }}>
        {/* Status pill */}
        <div className="flex items-center gap-2.5 px-4 py-2.5 border-r flex-shrink-0"
          style={{
            borderColor: `color-mix(in srgb, ${statusColor} 22%, var(--color-border))`,
            background: `color-mix(in srgb, ${statusColor} 6%, transparent)`,
          }}>
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isOnline ? 'animate-pulse' : ''}`}
            style={{ background: statusColor }} />
          <span className="text-[11px] font-bold uppercase tracking-widest"
            style={{ color: statusColor, letterSpacing: '0.12em' }}>
            {isOnline ? 'Online' : 'Degraded'}
          </span>
        </div>
        {/* Metrics inline */}
        <div className="flex items-center gap-6 px-5 py-2.5 flex-1 flex-wrap">
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            uptime <span className="font-mono font-semibold" style={{ color: 'var(--color-text)' }}>{formatUptime(health.uptime_sec)}</span>
          </span>
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            p50 <span className="font-mono font-semibold" style={{ color: '#60a5fa' }}>{health.latency.p50_ms}ms</span>
          </span>
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            p95 <span className="font-mono font-semibold" style={{ color: '#a78bfa' }}>{health.latency.p95_ms}ms</span>
          </span>
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            <span className="font-mono font-semibold" style={{ color: '#fbbf24' }}>{health.latency.samples}</span> requests
          </span>
          {health.budget && health.budget.dailySpendUsd > 0 && (
            <span className="text-[11px] ml-auto" style={{ color: 'var(--color-text-muted)' }}>
              spend today <span className="font-mono font-semibold" style={{ color: health.budget.exceeded ? '#ef4444' : '#fbbf24' }}>
                ${health.budget.dailySpendUsd.toFixed(2)}
                {health.budget.dailyLimitUsd ? ` / $${health.budget.dailyLimitUsd.toFixed(2)}` : ''}
              </span>
            </span>
          )}
          {(health as any).reason && (
            <span className="text-[11px] ml-auto font-medium" style={{ color: '#fbbf24' }}>{(health as any).reason}</span>
          )}
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Clock} label="Uptime" value={formatUptime(health.uptime_sec)} color="#34d399" />
        <StatCard icon={Zap} label="P50 Latency" value={`${health.latency.p50_ms}ms`} color="#60a5fa"
          sub="median response" />
        <StatCard icon={TrendingUp} label="P95 Latency" value={`${health.latency.p95_ms}ms`} color="#a78bfa"
          sub="tail latency" />
        <StatCard icon={Activity} label="Requests" value={String(health.latency.samples)} color="#fbbf24"
          sub="in-memory ring buffer" />
      </div>

      {/* ── Infrastructure: GPU + Bot ── */}
      <div className="grid grid-cols-2 gap-3">
        {/* GPU */}
        <div className="rounded-xl border overflow-hidden"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
          <div className="flex items-center justify-between px-4 py-2.5 border-b"
            style={{ borderColor: 'var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(96,165,250,0.12)' }}>
                <Cpu className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />
              </div>
              <span className="text-[12px] font-semibold">GPU Instances</span>
              {gpuInstances.length > 0 && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}>
                  {gpuInstances.length}
                </span>
              )}
            </div>
          </div>
          <div className="p-3">
            {gpuInstances.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-5 gap-2">
                <Server className="w-7 h-7" style={{ color: 'var(--color-text-muted)', opacity: 0.2 }} />
                <p className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>No GPU deployed</p>
              </div>
            ) : (
              <div className="space-y-2">
                {gpuInstances.map(inst => <GpuTile key={inst.instanceId} inst={inst} />)}
              </div>
            )}
          </div>
        </div>

        {/* Bot */}
        <div className="rounded-xl border overflow-hidden"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
          <div className="flex items-center justify-between px-4 py-2.5 border-b"
            style={{ borderColor: 'var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(167,139,250,0.12)' }}>
                <Bot className="w-3.5 h-3.5" style={{ color: '#a78bfa' }} />
              </div>
              <span className="text-[12px] font-semibold">Meeting Bot</span>
            </div>
            {bot && (
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${bot.status === 'joined' ? 'animate-pulse' : ''}`}
                  style={{
                    background: bot.status === 'joined' ? '#10b981'
                      : bot.status === 'idle' ? '#52525b'
                        : '#f59e0b',
                  }} />
                <span className="text-[10px] font-semibold capitalize" style={{
                  color: bot.status === 'joined' ? '#34d399'
                    : bot.status === 'idle' ? 'var(--color-text-muted)'
                      : '#fbbf24',
                }}>
                  {bot.status}
                </span>
              </div>
            )}
          </div>
          <div className="p-3">
            {bot && bot.status !== 'idle' ? (
              <div className="space-y-2">
                {bot.podId && (
                  <div className="flex items-center justify-between text-[11px]">
                    <span style={{ color: 'var(--color-text-muted)' }}>Pod</span>
                    <span className="font-mono font-medium truncate max-w-[140px]" style={{ color: 'var(--color-text)' }}>
                      {bot.podId}
                    </span>
                  </div>
                )}
                {bot.meetingUrl && (
                  <div className="flex items-center justify-between text-[11px] gap-2">
                    <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>Meeting</span>
                    <span className="font-mono text-[9px] truncate" style={{ color: '#60a5fa' }}>
                      {bot.meetingUrl}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between text-[11px]">
                  <span style={{ color: 'var(--color-text-muted)' }}>Uptime</span>
                  <span className="font-mono font-semibold" style={{ color: 'var(--color-text)' }}>
                    {formatUptime(bot.elapsedSec)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-5 gap-2">
                <Bot className="w-7 h-7" style={{ color: 'var(--color-text-muted)', opacity: 0.2 }} />
                <p className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>No bot active</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Pipeline Health ── */}
      <PipelineHealthCard health={health} />

      {/* ── Pipeline Cold/Warm latency ── */}
      {stageLatencies.pipeline && stageLatencies.pipeline.samples > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Full Pipeline — Cold', icon: Snowflake, color: '#60a5fa', value: stageLatencies.pipeline.cold },
            { label: 'Full Pipeline — Warm', icon: Flame, color: '#f59e0b', value: stageLatencies.pipeline.warm },
          ].map(({ label, icon: Icon, color, value }) => (
            <div key={label} className="rounded-xl border p-4 transition-all"
              style={{
                background: 'var(--color-surface-elevated)',
                borderColor: `color-mix(in srgb, ${color} 18%, var(--color-border))`,
                borderTop: `2px solid ${color}`,
              }}>
              <div className="flex items-center gap-1.5 mb-2">
                <Icon className="w-3.5 h-3.5" style={{ color }} />
                <span className="text-[10px] font-semibold uppercase"
                  style={{ color: 'var(--color-text-muted)', letterSpacing: '0.08em' }}>
                  {label}
                </span>
              </div>
              <div className="font-mono text-2xl font-bold">
                {value !== null ? `${value}ms` : '—'}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Provider Performance ── */}
      {providerEntries.length > 0 && (
        <div className="rounded-xl border overflow-hidden"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
          <div className="flex items-center justify-between px-4 py-2.5 border-b"
            style={{ borderColor: 'var(--color-border)' }}>
            <span className="text-[12px] font-semibold">Provider Performance</span>
            <div className="flex items-center gap-4 text-[9px] font-semibold uppercase"
              style={{ color: 'var(--color-text-muted)', letterSpacing: '0.1em' }}>
              <span className="w-8 text-right">reqs</span>
              <span className="w-14 text-right">avg lat</span>
              <span className="w-8 text-right">err%</span>
            </div>
          </div>
          <div className="px-4 py-1">
            {providerEntries
              .sort((a, b) => b[1].requests - a[1].requests)
              .map(([name, m]) => (
                <ProviderBar
                  key={name}
                  name={name}
                  requests={m.requests}
                  avgLatencyMs={m.avgLatencyMs}
                  errorRate={m.errorRate}
                  maxRequests={maxRequests}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
