'use client';

import { useState, useEffect, useCallback } from 'react';
import { Mic, Bot, Volume2, AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardHeader, CardBody, StatusBadge } from '@/components/ui';
import { getProviderConfig, getReadinessStatus } from '@/lib/gateway';
import type { HealthResponse, ProviderConfigResponse, ReadinessStatusResponse, PipelineChainEntry } from '@/lib/gateway';
import { PROVIDER_ICON } from './FallbackChainList';

// ── Types ─────────────────────────────────────────────────────────────────────

type ServicePhase = 'idle' | 'benchmarking' | 'ready' | 'degraded' | 'failed' | 'repechage' | 'condemned';

type ProviderPhase = 'active' | 'ok' | 'benchmarking' | 'ready' | 'degraded' | 'repechage' | 'error' | 'idle';

interface ProviderStatus {
  phase: ProviderPhase;
  avgLatencyMs?: number | null;
}

const STAGE_META: Record<'stt' | 'llm' | 'tts', { label: string; icon: LucideIcon; color: string }> = {
  stt: { label: 'STT', icon: Mic,    color: '#38bdf8' },
  llm: { label: 'LLM', icon: Bot,    color: '#a78bfa' },
  tts: { label: 'TTS', icon: Volume2, color: '#fbbf24' },
};

// ── Status helpers ────────────────────────────────────────────────────────────

function dotColor(phase: ProviderPhase): string {
  switch (phase) {
    case 'active':
    case 'ok':
    case 'ready':        return '#10b981';
    case 'benchmarking': return '#fbbf24';
    case 'degraded':     return '#f97316';
    case 'repechage':    return '#a78bfa';
    case 'error':        return '#ef4444';
    default:             return '#52525b';
  }
}

function phaseLabel(phase: ProviderPhase): string {
  if (phase === 'active') return 'active';
  if (phase === 'ok') return 'ok';
  if (phase === 'ready') return 'ready';
  if (phase === 'benchmarking') return 'bench…';
  if (phase === 'degraded') return 'degraded';
  if (phase === 'repechage') return 'retry';
  if (phase === 'error') return 'error';
  return 'idle';
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function deriveStatus(
  provider: string,
  stage: 'stt' | 'llm' | 'tts',
  activeProvider: string,
  metrics: HealthResponse['providerMetrics'],
  gpuPhase: ServicePhase | null,
  isActiveProfile: boolean,
  configuredProviders: Record<string, boolean>,
): ProviderStatus {
  const m = metrics[provider] ?? metrics[`${provider}-${stage}`] ?? null;
  const avgLatencyMs = m?.avgLatencyMs ?? null;

  if (!isActiveProfile) {
    if (provider === 'gpu' || provider === 'local') return { phase: 'idle' };
    return { phase: (configuredProviders[provider] ?? false) ? 'ok' : 'idle' };
  }

  if (provider === 'gpu' || provider === 'local') {
    if (!gpuPhase || gpuPhase === 'idle') return { phase: 'idle', avgLatencyMs };
    if (gpuPhase === 'benchmarking') return { phase: 'benchmarking', avgLatencyMs };
    if (gpuPhase === 'degraded')     return { phase: 'degraded', avgLatencyMs };
    if (gpuPhase === 'repechage')    return { phase: 'repechage', avgLatencyMs };
    if (gpuPhase === 'failed' || gpuPhase === 'condemned') return { phase: 'error', avgLatencyMs };
    if (gpuPhase === 'ready') {
      return { phase: activeProvider === provider ? 'active' : 'ready', avgLatencyMs };
    }
  }

  if ((m?.errorRate ?? 0) > 0.2) return { phase: 'error', avgLatencyMs };
  if (activeProvider === provider) return { phase: 'active', avgLatencyMs };
  if (m && m.requests > 0) return { phase: 'ok', avgLatencyMs };
  return { phase: 'idle', avgLatencyMs };
}

// ── Inline chain ──────────────────────────────────────────────────────────────

function InlineChain({
  chain, stage, activeProvider, metrics, gpuPhase, isActiveProfile, configuredProviders,
}: {
  chain: PipelineChainEntry[];
  stage: 'stt' | 'llm' | 'tts';
  activeProvider: string;
  metrics: HealthResponse['providerMetrics'];
  gpuPhase: ServicePhase | null;
  isActiveProfile: boolean;
  configuredProviders: Record<string, boolean>;
}) {
  if (!chain.length) return <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>—</span>;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {chain.map((entry, i) => {
        const s = deriveStatus(entry.provider, stage, activeProvider, metrics, gpuPhase, isActiveProfile, configuredProviders);
        const color = dotColor(s.phase);
        const isActive = s.phase === 'active';
        const pi = PROVIDER_ICON[entry.provider];
        const ProvIcon = pi?.icon;
        const provColor = pi?.color ?? 'var(--color-text-muted)';

        return (
          <div key={i} className="flex items-center gap-1">
            {i > 0 && <ArrowRight className="w-2.5 h-2.5" style={{ color: 'var(--color-border)' }} />}
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px]"
              style={{
                borderColor: isActive ? `color-mix(in srgb, ${color} 40%, var(--color-border))` : 'var(--color-border)',
                background: isActive ? `color-mix(in srgb, ${color} 6%, var(--color-surface-elevated))` : 'var(--color-surface-elevated)',
              }}
            >
              {ProvIcon
                ? <ProvIcon className="w-3 h-3 flex-shrink-0" style={{ color: provColor }} />
                : <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
              }
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
              <span className="font-medium capitalize">{entry.provider}</span>
              {i > 0 && (
                <span className="text-[9px] font-bold uppercase px-0.5 rounded"
                  style={{ color: '#f59e0b', background: 'color-mix(in srgb, #f59e0b 10%, transparent)' }}>
                  fb
                </span>
              )}
              {isActiveProfile && s.phase !== 'idle' && (
                <span className="text-[9px] font-mono" style={{ color }}>
                  {phaseLabel(s.phase)}
                </span>
              )}
              {isActiveProfile && s.avgLatencyMs != null && s.avgLatencyMs > 0 && (
                <span className="text-[9px] font-mono" style={{ color: 'var(--color-text-muted)' }}>
                  {Math.round(s.avgLatencyMs)}ms
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Profile row ───────────────────────────────────────────────────────────────

function ProfileRow({
  profile, isActive, activeProviders, metrics, gpuPhases, defaultOpen, configuredProviders,
}: {
  profile: ProviderConfigResponse['profiles'][0];
  isActive: boolean;
  activeProviders: Record<'stt' | 'llm' | 'tts', string>;
  metrics: HealthResponse['providerMetrics'];
  gpuPhases: Record<'stt' | 'llm' | 'tts', ServicePhase | null>;
  defaultOpen: boolean;
  configuredProviders: Record<string, boolean>;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const stages = (['stt', 'llm', 'tts'] as const).filter(s => {
    const chain = (profile as any)[s] as PipelineChainEntry[] | undefined;
    return chain && chain.length > 0;
  });

  // Detect issues (only meaningful for active profile)
  let hasIssue = false;
  if (isActive) {
    for (const stage of stages) {
      const chain = (profile as any)[stage] as PipelineChainEntry[];
      const primary = chain[0];
      const active = activeProviders[stage];
      if (active && active !== primary.provider) hasIssue = true;
      if (gpuPhases[stage] === 'degraded') hasIssue = true;
    }
  }

  // For non-active profiles: derive availability from configured providers
  let availableStages = 0;
  if (!isActive) {
    for (const stage of stages) {
      const chain = (profile as any)[stage] as PipelineChainEntry[];
      const hasConfigured = chain.some(e => e.provider !== 'gpu' && e.provider !== 'local' && (configuredProviders[e.provider] ?? false));
      if (hasConfigured) availableStages++;
    }
  }
  const isAvailable = !isActive && stages.length > 0 && availableStages === stages.length;
  const isPartial = !isActive && availableStages > 0 && availableStages < stages.length;

  // Last used: prefer lastRequestAt (actual requests) over lastActivatedAt
  const lastUsed = profile.lastRequestAt ?? profile.lastActivatedAt ?? null;

  const accentColor = isActive ? '#10b981' : 'var(--color-text-muted)';

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{
        borderColor: isActive ? 'color-mix(in srgb, #10b981 30%, var(--color-border))' : 'var(--color-border)',
        background: isActive ? 'color-mix(in srgb, #10b981 3%, var(--color-surface-elevated))' : 'var(--color-surface-elevated)',
      }}
    >
      {/* Profile header */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Chevron toggle */}
        <button type="button" className="flex-shrink-0 cursor-pointer" onClick={() => setOpen(o => !o)}>
          {open
            ? <ChevronDown className="w-3 h-3" style={{ color: accentColor }} />
            : <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
          }
        </button>

        {/* Active dot */}
        {isActive && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#10b981' }} />}

        {/* Name — click navigates to profiles page */}
        <button
          type="button"
          className="text-xs font-semibold flex-1 text-left truncate cursor-pointer hover:underline"
          style={{ color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
          onClick={() => {
            window.history.pushState(null, '', `/config/profiles/edit/${profile.id}`);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
        >
          {profile.name}
        </button>

        {/* Stage pills summary (collapsed) */}
        {!open && (
          <div className="flex items-center gap-1">
            {stages.map(s => {
              const meta = STAGE_META[s];
              const Icon = meta.icon;
              return (
                <span key={s} className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold uppercase"
                  style={{ background: `color-mix(in srgb, ${meta.color} 10%, transparent)`, color: meta.color }}>
                  <Icon className="w-2.5 h-2.5" />
                  {meta.label}
                </span>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Non-active: availability + last used */}
          {!isActive && (
            <>
              {isAvailable && (
                <span className="text-[9px] px-1 py-0.5 rounded font-semibold"
                  style={{ background: 'color-mix(in srgb, #10b981 10%, transparent)', color: '#10b981' }}>
                  available
                </span>
              )}
              {isPartial && (
                <span className="text-[9px] px-1 py-0.5 rounded font-semibold"
                  style={{ background: 'color-mix(in srgb, #f59e0b 10%, transparent)', color: '#f59e0b' }}>
                  partial
                </span>
              )}
              <span className="text-[9px] font-mono" style={{ color: 'var(--color-text-muted)' }}>
                {lastUsed ? relativeTime(lastUsed) : 'never used'}
              </span>
            </>
          )}
          {/* Active: health + badge */}
          {isActive && (
            hasIssue
              ? <span className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: '#f59e0b' }}>
                  <AlertTriangle className="w-3 h-3" /> issues
                </span>
              : <span className="flex items-center gap-1 text-[10px]" style={{ color: '#34d399' }}>
                  <CheckCircle2 className="w-3 h-3" /> ok
                </span>
          )}
          {isActive && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase"
              style={{ background: 'color-mix(in srgb, #10b981 12%, transparent)', color: '#10b981' }}>
              active
            </span>
          )}
          {/* Edit link */}
          <button
            type="button"
            className="flex-shrink-0 cursor-pointer opacity-40 hover:opacity-100 transition-opacity"
            title="Edit profile"
            onClick={() => {
              window.history.pushState(null, '', '/config/profiles');
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
          >
            <ExternalLink className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>
      </div>

      {/* Stages detail */}
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
          {stages.map(stage => {
            const meta = STAGE_META[stage];
            const Icon = meta.icon;
            const chain = (profile as any)[stage] as PipelineChainEntry[];
            const primaryProvider = chain[0]?.provider ?? '';
            const activeProvider = activeProviders[stage];
            const usingFallback = isActive && activeProvider && activeProvider !== primaryProvider && chain.some(e => e.provider === activeProvider);

            return (
              <div key={stage} className="flex items-start gap-2 pt-2">
                {/* Stage label */}
                <div className="flex items-center gap-1 w-14 flex-shrink-0 mt-0.5">
                  <div className="flex items-center justify-center w-4 h-4 rounded flex-shrink-0"
                    style={{ background: `color-mix(in srgb, ${meta.color} 15%, transparent)` }}>
                    <Icon className="w-2.5 h-2.5" style={{ color: meta.color }} />
                  </div>
                  <span className="text-[10px] font-bold uppercase" style={{ color: meta.color }}>{meta.label}</span>
                </div>

                {/* Chain */}
                <InlineChain
                  chain={chain}
                  stage={stage}
                  activeProvider={activeProviders[stage]}
                  metrics={metrics}
                  gpuPhase={gpuPhases[stage]}
                  isActiveProfile={isActive}
                  configuredProviders={configuredProviders}
                />

                {/* Fallback warning */}
                {usingFallback && (
                  <span className="ml-auto text-[10px] font-semibold flex items-center gap-0.5 flex-shrink-0"
                    style={{ color: '#f59e0b' }}>
                    <AlertTriangle className="w-2.5 h-2.5" /> fallback
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface PipelineHealthCardProps {
  health: HealthResponse;
}

export function PipelineHealthCard({ health }: PipelineHealthCardProps) {
  const [config, setConfig] = useState<ProviderConfigResponse | null>(null);
  const [readiness, setReadiness] = useState<ReadinessStatusResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfg, rdns] = await Promise.all([
        getProviderConfig(),
        getReadinessStatus().catch(() => null),
      ]);
      setConfig(cfg);
      setReadiness(rdns);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [load]);

  if (!config) return null;

  const profiles = config.profiles ?? [];
  if (profiles.length === 0) return null;

  const activeProviders: Record<'stt' | 'llm' | 'tts', string> = {
    stt: health.components.stt?.provider ?? '',
    llm: health.components.llm?.provider ?? '',
    tts: health.components.tts?.provider ?? '',
  };

  const gpuPhases: Record<'stt' | 'llm' | 'tts', ServicePhase | null> = {
    stt: (readiness?.readinessState.stt.phase as ServicePhase) ?? null,
    llm: (readiness?.readinessState.llm.phase as ServicePhase) ?? null,
    tts: (readiness?.readinessState.tts.phase as ServicePhase) ?? null,
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Profiles</h3>
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {profiles.length} profile{profiles.length !== 1 ? 's' : ''}
          </span>
        </div>
      </CardHeader>
      <CardBody>
        <div className="space-y-2">
          {profiles.map(profile => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              isActive={profile.id === config.activeProfileId}
              activeProviders={activeProviders}
              metrics={health.providerMetrics}
              gpuPhases={gpuPhases}
              defaultOpen={profile.id === config.activeProfileId}
              configuredProviders={health.providers}
            />
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
