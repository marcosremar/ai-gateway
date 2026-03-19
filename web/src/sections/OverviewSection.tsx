'use client';

import { useState, useEffect, useCallback } from 'react';
import { useGateway } from '@/hooks/useGateway';
import { useGpuStatus } from '@/hooks/useGpuStatus';
import { useGpuList } from '@/hooks/useGpuList';
import { useBotStatus } from '@/hooks/useBotStatus';
import { getRequestLog, type RequestLogEntry } from '@/lib/gateway';
import { Card, CardHeader, CardBody, StatusBadge, AlertBanner, Spinner, IconBox, KV, StatusDot } from '@/components/ui';
import { PipelineHealthCard } from './PipelineHealthCard';
import {
  Activity, Cpu, Bot, Clock, Zap, DollarSign, ArrowRight,
  Mic, Volume2, Wifi, WifiOff, Snowflake, Flame,
  type LucideIcon,
} from 'lucide-react';

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function gpuVariant(status: string): 'emerald' | 'amber' | 'red' | 'gray' {
  if (status === 'ready') return 'emerald';
  if (['creating', 'booting', 'installing'].includes(status)) return 'amber';
  if (status === 'error') return 'red';
  return 'gray';
}

// Compute cold/warm latency from request log entries for a stage
interface StageLatency {
  cold: number | null;  // first request (or after >60s gap)
  warm: number | null;  // average of subsequent requests
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
    // Sort by timestamp ascending
    const sorted = [...stageEntries].sort((a, b) => a.timestamp - b.timestamp);
    const provider = sorted[sorted.length - 1]?.provider || '';

    if (sorted.length === 0) {
      result[stage] = { cold: null, warm: null, samples: 0, provider };
      continue;
    }

    // Cold = first request or requests after a gap > 60s
    // Warm = the rest
    const coldLatencies: number[] = [];
    const warmLatencies: number[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const gap = i === 0 ? Infinity : sorted[i].timestamp - sorted[i - 1].timestamp;
      if (gap > 60000) {
        coldLatencies.push(sorted[i].latencyMs);
      } else {
        warmLatencies.push(sorted[i].latencyMs);
      }
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

export function OverviewSection() {
  const { health, error } = useGateway();
  const { gpu } = useGpuStatus(true, 10000);
  const { instances: gpuInstances } = useGpuList(true, 10000);
  const { bot } = useBotStatus(true, 10000);
  const [stageLatencies, setStageLatencies] = useState<Record<string, StageLatency>>({});

  // Load request log for latency data
  const loadLatencies = useCallback(async () => {
    try {
      const log = await getRequestLog(0, 100);
      setStageLatencies(computeStageLatencies(log.entries));
    } catch {}
  }, []);

  useEffect(() => { loadLatencies(); }, [loadLatencies]);
  // Refresh every 30s
  useEffect(() => {
    const id = setInterval(loadLatencies, 30000);
    return () => clearInterval(id);
  }, [loadLatencies]);

  if (error) return <AlertBanner variant="error" className="m-6">Gateway unavailable: {error}</AlertBanner>;
  if (!health) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;

  const isGpuReady = gpu?.status === 'ready';

  // Always show the 3 pipeline stages — STT, LLM, TTS
  const pipelineStages: Array<{
    key: string; label: string; fg: string; icon: LucideIcon;
    status: string; provider: string;
  }> = [
    {
      key: 'stt', label: 'Speech-to-Text', fg: '#38bdf8', icon: Mic,
      status: health.components.stt?.status || 'unavailable',
      provider: health.components.stt?.provider || '—',
    },
    {
      key: 'llm', label: 'Translation', fg: '#a78bfa', icon: Bot,
      status: health.components.llm?.status || 'unavailable',
      provider: health.components.llm?.provider || '—',
    },
    {
      key: 'tts', label: 'Text-to-Speech', fg: '#fbbf24', icon: Volume2,
      status: health.components.tts?.status || 'unavailable',
      provider: health.components.tts?.provider || (isGpuReady ? 'gpu' : 'cloud fallback'),
    },
  ];

  return (
    <div className="p-6 space-y-5">
      {/* Status bar */}
      <div
        className="flex items-center gap-4 px-5 py-3 rounded-xl border"
        style={{
          borderColor: health.status === 'ok'
            ? 'color-mix(in srgb, #10b981 25%, var(--color-border))'
            : 'color-mix(in srgb, #f59e0b 25%, var(--color-border))',
          background: health.status === 'ok'
            ? 'color-mix(in srgb, #10b981 4%, var(--color-surface-elevated))'
            : 'color-mix(in srgb, #f59e0b 4%, var(--color-surface-elevated))',
        }}
      >
        {health.status === 'ok'
          ? <Wifi className="w-4 h-4" style={{ color: '#10b981' }} />
          : <WifiOff className="w-4 h-4" style={{ color: '#f59e0b' }} />
        }
        <span className="text-sm font-semibold" style={{ color: health.status === 'ok' ? '#34d399' : '#fbbf24' }}>
          {health.status === 'ok' ? 'All Systems Operational' : 'Degraded'}
        </span>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Uptime {formatUptime(health.uptime_sec)}
        </span>
        {(health as any).reason && (
          <span className="text-xs ml-auto" style={{ color: '#fbbf24' }}>{(health as any).reason}</span>
        )}
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Clock} label="Uptime" value={formatUptime(health.uptime_sec)} color="#34d399" />
        <StatCard icon={Zap} label="P50 Latency" value={`${health.latency.p50_ms}ms`} color="#60a5fa" />
        <StatCard icon={Zap} label="P95 Latency" value={`${health.latency.p95_ms}ms`} color="#a78bfa" />
        <StatCard icon={Activity} label="Requests" value={String(health.latency.samples)} color="#fbbf24" />
      </div>

      {/* GPU Instances + Bot — half-width each */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <IconBox icon={Cpu} color="#60a5fa" />
                <h3 className="text-sm font-semibold">GPU Instances</h3>
                {gpuInstances.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                    style={{ background: 'rgba(96,165,250,0.1)', color: '#60a5fa' }}>
                    {gpuInstances.length}
                  </span>
                )}
              </div>
            </div>
          </CardHeader>
          <CardBody>
            {gpuInstances.length === 0 ? (
              <div className="text-center py-4">
                <Cpu className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)', opacity: 0.3 }} />
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No GPU deployed</p>
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--color-border-light)' }}>
                {gpuInstances.map(inst => {
                  const isReady = inst.isActive || inst.status === 'ready';
                  return (
                    <div key={inst.instanceId} className="py-3 first:pt-0 last:pb-0 flex items-center gap-3">
                      <StatusDot status={isReady ? 'ready' : ['creating','booting','loading'].includes(inst.status) ? 'booting' : 'idle'} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold capitalize truncate">
                          {inst.gpuType || inst.provider}
                          {inst.isActive && (
                            <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded font-bold uppercase"
                              style={{ background: 'rgba(16,185,129,0.12)', color: '#34d399' }}>active</span>
                          )}
                        </div>
                        <div className="text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                          {inst.provider}{inst.elapsedSec != null ? ` · ${formatUptime(inst.elapsedSec)}` : ''}
                          {inst.costPerHr ? ` · $${inst.costPerHr.toFixed(3)}/hr` : ''}
                        </div>
                      </div>
                      <StatusBadge variant={gpuVariant(inst.status)} dot>{inst.status}</StatusBadge>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <IconBox icon={Bot} color="#a78bfa" />
                <h3 className="text-sm font-semibold">Bot</h3>
              </div>
              {bot && <StatusBadge variant={bot.status === 'idle' ? 'gray' : bot.status === 'joined' ? 'emerald' : 'amber'} dot>{bot.status}</StatusBadge>}
            </div>
          </CardHeader>
          <CardBody>
            {bot && bot.status !== 'idle' ? (
              <div className="space-y-2 text-xs">
                {bot.podId && <KV label="Pod" value={bot.podId} mono />}
                {bot.meetingUrl && <KV label="Meeting" value={bot.meetingUrl} mono />}
                <KV label="Uptime" value={formatUptime(bot.elapsedSec)} />
              </div>
            ) : (
              <div className="text-center py-3">
                <Bot className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)', opacity: 0.3 }} />
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No bot active</p>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Active Pipeline — always show STT → LLM → TTS */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Active Pipeline</h3>
            <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
              <span className="flex items-center gap-1"><Snowflake className="w-3 h-3" style={{ color: '#60a5fa' }} /> Cold start</span>
              <span className="flex items-center gap-1"><Flame className="w-3 h-3" style={{ color: '#f59e0b' }} /> Warm</span>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {/* Routing mode flow bar */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-4 px-3 py-2 rounded-lg text-xs overflow-x-auto"
            style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}
          >
            <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>Routing:</span>
            {(['stt', 'llm', 'tts'] as const).map((s, i) => {
              const r = gpu?.pipelineRouting;
              const dest = (r ? { stt: r.stt, llm: r.llm, tts: r.tts }[s] : null) ?? 'cloud';
              return (
                <span key={s} className="flex items-center gap-1 flex-shrink-0">
                  {i > 0 && <ArrowRight className="w-2.5 h-2.5" style={{ color: 'var(--color-border)' }} />}
                  <span className="uppercase font-mono text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{s}</span>
                  <span className="font-semibold" style={{ color: dest === 'gpu' ? '#10b981' : '#8b949e' }}>
                    → {dest}
                  </span>
                </span>
              );
            })}
            <span className="ml-auto flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-bold"
              style={{
                background: gpu?.pipelineRouting?.mode === 'atomic-gpu' ? 'color-mix(in srgb, #10b981 12%, transparent)' :
                            gpu?.pipelineRouting?.mode === 'hybrid' ? 'color-mix(in srgb, #f59e0b 12%, transparent)' :
                            'var(--color-surface)',
                color: gpu?.pipelineRouting?.mode === 'atomic-gpu' ? '#10b981' :
                       gpu?.pipelineRouting?.mode === 'hybrid' ? '#f59e0b' : 'var(--color-text-muted)',
                border: '1px solid currentColor',
              }}
            >
              {gpu?.pipelineRouting?.mode ?? 'cloud'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {pipelineStages.map((stage) => {
              const StageIcon = stage.icon;
              const lat = stageLatencies[stage.key];
              const isOk = stage.status === 'ok' || stage.status === 'ready';

              return (
                <div
                  key={stage.key}
                  className="rounded-xl border p-4 transition-all"
                  style={{
                    borderColor: isOk
                      ? `color-mix(in srgb, ${stage.fg} 25%, var(--color-border))`
                      : 'var(--color-border)',
                    background: isOk
                      ? `color-mix(in srgb, ${stage.fg} 3%, var(--color-surface))`
                      : 'var(--color-surface)',
                    opacity: isOk ? 1 : 0.5,
                  }}
                >
                  {/* Header */}
                  <div className="flex items-center gap-2.5 mb-3">
                    <IconBox icon={StageIcon} color={stage.fg} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold uppercase tracking-wide" style={{ color: isOk ? stage.fg : 'var(--color-text-muted)' }}>
                        {stage.key}
                      </div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                        {stage.label}
                      </div>
                    </div>
                  </div>

                  {/* Provider */}
                  <div className="text-xs font-medium mb-3 capitalize">{stage.provider}</div>

                  {/* Latency */}
                  {lat && lat.samples > 0 ? (
                    <div className="space-y-2 pt-3 border-t" style={{ borderColor: 'var(--color-border-light)' }}>
                      {lat.cold !== null && (
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1.5 text-xs" style={{ color: '#60a5fa' }}>
                            <Snowflake className="w-3 h-3" /> Cold
                          </span>
                          <span className="text-sm font-mono font-bold">{lat.cold}ms</span>
                        </div>
                      )}
                      {lat.warm !== null && (
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1.5 text-xs" style={{ color: '#f59e0b' }}>
                            <Flame className="w-3 h-3" /> Warm
                          </span>
                          <span className="text-sm font-mono font-bold">{lat.warm}ms</span>
                        </div>
                      )}
                      <div className="text-[10px] text-right" style={{ color: 'var(--color-text-muted)' }}>
                        {lat.samples} samples
                      </div>
                    </div>
                  ) : (
                    <div className="pt-3 border-t" style={{ borderColor: 'var(--color-border-light)' }}>
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        {isOk ? 'No latency data yet' : 'Unavailable'}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Flow arrows between stages — visual indicator */}
          <div className="flex items-center justify-center gap-1 mt-3">
            <span className="text-[10px] font-mono" style={{ color: '#38bdf8' }}>STT</span>
            <ArrowRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)', opacity: 0.4 }} />
            <span className="text-[10px] font-mono" style={{ color: '#a78bfa' }}>LLM</span>
            <ArrowRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)', opacity: 0.4 }} />
            <span className="text-[10px] font-mono" style={{ color: '#fbbf24' }}>TTS</span>
          </div>
        </CardBody>
      </Card>

      {/* Pipeline health — profile → stage → provider hierarchy */}
      <PipelineHealthCard health={health} />

      {/* Full pipeline latency (if pipeline stage data exists) */}
      {stageLatencies.pipeline && stageLatencies.pipeline.samples > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="p-4 rounded-xl border card-hover" style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <Snowflake className="w-4 h-4" style={{ color: '#60a5fa' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Full Pipeline — Cold</span>
            </div>
            <div className="font-mono text-xl font-bold">
              {stageLatencies.pipeline.cold !== null ? `${stageLatencies.pipeline.cold}ms` : '—'}
            </div>
          </div>
          <div className="p-4 rounded-xl border card-hover" style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <Flame className="w-4 h-4" style={{ color: '#f59e0b' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Full Pipeline — Warm</span>
            </div>
            <div className="font-mono text-xl font-bold">
              {stageLatencies.pipeline.warm !== null ? `${stageLatencies.pipeline.warm}ms` : '—'}
            </div>
          </div>
        </div>
      )}

      {/* Budget */}
      {health.budget && health.budget.dailySpendUsd > 0 && (
        <Card>
          <CardBody>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <IconBox icon={DollarSign} color="#fbbf24" />
                <div>
                  <div className="text-sm font-medium">Daily Spend</div>
                  <div className="text-lg font-mono font-bold" style={{ color: health.budget.exceeded ? '#f87171' : 'var(--color-text)' }}>
                    ${health.budget.dailySpendUsd.toFixed(2)}
                    {health.budget.dailyLimitUsd && (
                      <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}> / ${health.budget.dailyLimitUsd.toFixed(2)}</span>
                    )}
                  </div>
                </div>
              </div>
              {health.budget.exceeded && <StatusBadge variant="red" dot>EXCEEDED</StatusBadge>}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Provider Metrics */}
      {Object.keys(health.providerMetrics).length > 0 && (
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Provider Performance</h3></CardHeader>
          <CardBody>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: 'var(--color-text-muted)' }}>
                  <th className="pb-2 text-left font-medium">Provider</th>
                  <th className="pb-2 text-right font-medium">Requests</th>
                  <th className="pb-2 text-right font-medium">Avg Latency</th>
                  <th className="pb-2 text-right font-medium">Error Rate</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(health.providerMetrics).map(([name, m]) => (
                  <tr key={name} className="border-t" style={{ borderColor: 'var(--color-border-light)' }}>
                    <td className="py-2 font-medium capitalize">{name}</td>
                    <td className="py-2 font-mono text-right">{m.requests}</td>
                    <td className="py-2 font-mono text-right">{m.avgLatencyMs.toFixed(0)}ms</td>
                    <td className="py-2 text-right">
                      <StatusBadge variant={m.errorRate > 0.1 ? 'red' : m.errorRate > 0 ? 'amber' : 'emerald'}>
                        {(m.errorRate * 100).toFixed(1)}%
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: LucideIcon; label: string; value: string; color: string }) {
  return (
    <div className="p-4 rounded-xl border card-hover" style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)' }}>
      <div className="flex items-center justify-between mb-3">
        <IconBox icon={Icon} color={color} />
      </div>
      <div className="font-mono text-xl font-bold leading-none mb-1">{value}</div>
      <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
    </div>
  );
}
