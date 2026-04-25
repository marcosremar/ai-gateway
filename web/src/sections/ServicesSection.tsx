'use client';

import { useState, useEffect } from 'react';
import { getProviderConfig } from '@/lib/gateway';
import { Spinner } from '@/components/ui';
import { deriveProvides, STAGE_ACCENTS, type Service, type App } from './provider-types';
import { Cloud, Server, Zap, HardDrive, Package, Cpu, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

// ── Stage badge ───────────────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, { label: string; short: string }> = {
  stt: { label: 'Speech-to-Text', short: 'STT' },
  llm: { label: 'Language Model', short: 'LLM' },
  tts: { label: 'Text-to-Speech', short: 'TTS' },
  image: { label: 'Image Generation', short: 'IMG' },
};

const STAGE_COLORS: Record<string, string> = {
  stt: '#0ea5e9',
  llm: '#8b5cf6',
  tts: '#f59e0b',
  image: '#10b981',
};

function StageBadge({ stage }: { stage: string }) {
  const color = STAGE_COLORS[stage] ?? '#71717a';
  const { short } = STAGE_LABELS[stage] ?? { short: stage.toUpperCase() };
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 25%, transparent)` }}
    >
      {short}
    </span>
  );
}

// ── Kind icon ─────────────────────────────────────────────────────────────────

function KindIcon({ kind }: { kind: Service['kind'] }) {
  if (kind === 'cloud') return <Cloud className="w-4 h-4" style={{ color: '#60a5fa' }} />;
  if (kind === 'container') return <Package className="w-4 h-4" style={{ color: '#a78bfa' }} />;
  if (kind === 'cpu') return <Cpu className="w-4 h-4" style={{ color: '#f59e0b' }} />;
  return <Zap className="w-4 h-4" style={{ color: '#34d399' }} />;
}

const KIND_COLOR: Record<string, string> = {
  cloud: '#60a5fa',
  container: '#a78bfa',
  serverless: '#34d399',
  cpu: '#f59e0b',
};

const KIND_LABEL: Record<string, string> = {
  cloud: 'Cloud API',
  container: 'Container GPU',
  serverless: 'Serverless',
  cpu: 'CPU Machine',
};

// ── Service card ──────────────────────────────────────────────────────────────

function ServiceCard({ service, usedByApps }: { service: Service; usedByApps: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const provides = deriveProvides(service);
  const color = KIND_COLOR[service.kind] ?? '#71717a';

  const models: { stage: string; model: string }[] = [
    service.sttModel ? { stage: 'stt', model: service.sttModel } : null,
    service.llmModel ? { stage: 'llm', model: service.llmModel } : null,
    service.ttsModel ? { stage: 'tts', model: service.ttsModel } : null,
  ].filter(Boolean) as { stage: string; model: string }[];

  return (
    <div
      className="rounded-xl border transition-all"
      style={{
        borderColor: `color-mix(in srgb, ${color} 20%, var(--color-border))`,
        background: 'var(--color-surface-elevated)',
        borderTop: `2px solid ${color}`,
      }}
    >
      {/* Header */}
      <button
        className="w-full text-left px-4 py-3 flex items-start gap-3"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Kind icon */}
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ background: `color-mix(in srgb, ${color} 12%, var(--color-surface))` }}
        >
          <KindIcon kind={service.kind} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{service.name}</span>
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
            >
              {KIND_LABEL[service.kind]}
            </span>
          </div>

          {/* Provides badges */}
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {provides.map(s => <StageBadge key={s} stage={s} />)}
            {provides.length === 0 && (
              <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>no stages defined</span>
            )}
          </div>

          {/* Cloud provider or Docker image (compact) */}
          {service.cloudProvider && (
            <p className="text-[11px] mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Provider: <span style={{ color: 'var(--color-text-secondary)' }}>{service.cloudProvider}</span>
            </p>
          )}
          {service.dockerImage && (
            <p className="text-[11px] mt-1 font-mono truncate" style={{ color: 'var(--color-text-muted)' }}>
              {service.dockerImage}
            </p>
          )}
        </div>

        {/* Used by count + expand */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {usedByApps.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}>
              {usedByApps.length} app{usedByApps.length !== 1 ? 's' : ''}
            </span>
          )}
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
            : <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          }
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t px-4 py-3 space-y-3" style={{ borderColor: 'var(--color-border)' }}>
          {/* Models */}
          {models.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase mb-1.5" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.08em' }}>Models</p>
              <div className="space-y-1">
                {models.map(({ stage, model }) => (
                  <div key={stage} className="flex items-center gap-2">
                    <StageBadge stage={stage} />
                    <code className="text-[11px] font-mono" style={{ color: 'var(--color-text-secondary)' }}>{model}</code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* CPU provider details */}
          {service.kind === 'cpu' && service.cpuProvider && (
            <div>
              <p className="text-[10px] font-semibold uppercase mb-1.5" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.08em' }}>CPU Provider</p>
              <KV label="Provider" value={service.cpuProvider} />
              {service.region && <KV label="Region" value={service.region} />}
              {service.dockerImage && <KV label="Image" value={service.dockerImage} />}
            </div>
          )}

          {/* GPU settings (containers only) */}
          {service.kind === 'container' && (
            <div>
              <p className="text-[10px] font-semibold uppercase mb-1.5" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.08em' }}>GPU Settings</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {service.gpuProvider && (
                  <KV label="Provider" value={service.gpuProvider} />
                )}
                {service.gpuTypes && service.gpuTypes.length > 0 && (
                  <KV label="GPU types" value={service.gpuTypes.join(', ')} />
                )}
                {service.minVramGb !== undefined && (
                  <KV label="Min VRAM" value={`${service.minVramGb}GB`} />
                )}
                {service.diskGb !== undefined && (
                  <KV label="Disk" value={`${service.diskGb}GB`} />
                )}
                {service.raceCount !== undefined && service.raceCount > 1 && (
                  <KV label="Race count" value={String(service.raceCount)} />
                )}
                {service.idleTimeoutMin !== undefined && (
                  <KV label="Idle timeout" value={service.idleTimeoutMin === 0 ? 'never' : `${service.idleTimeoutMin}m`} />
                )}
                {service.spotInstance && <KV label="Spot instance" value="yes" />}
                {service.useSnapgpu && <KV label="SnapGPU" value="enabled" />}
              </div>
            </div>
          )}

          {/* Latency targets */}
          {(service.sttTargetMs || service.llmTargetMs || service.ttsTargetMs) && (
            <div>
              <p className="text-[10px] font-semibold uppercase mb-1.5" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.08em' }}>Latency Targets</p>
              <div className="flex gap-3">
                {service.sttTargetMs && <KV label="STT" value={`${service.sttTargetMs}ms`} />}
                {service.llmTargetMs && <KV label="LLM" value={`${service.llmTargetMs}ms`} />}
                {service.ttsTargetMs && <KV label="TTS" value={`${service.ttsTargetMs}ms`} />}
              </div>
            </div>
          )}

          {/* Used by */}
          {usedByApps.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase mb-1.5" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.08em' }}>Used by apps</p>
              <div className="flex flex-wrap gap-1.5">
                {usedByApps.map(name => (
                  <span key={name} className="text-[11px] px-2 py-0.5 rounded-full"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}>
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{label}: </span>
      <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{value}</span>
    </div>
  );
}

// ── Group header ──────────────────────────────────────────────────────────────

function GroupHeader({ kind, count }: { kind: string; count: number }) {
  const color = KIND_COLOR[kind] ?? '#71717a';
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="w-5 h-5 rounded flex items-center justify-center" style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
        <KindIcon kind={kind as Service['kind']} />
      </div>
      <span className="text-[11px] font-bold uppercase" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.1em' }}>
        {KIND_LABEL[kind]} <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>({count})</span>
      </span>
      <div className="flex-1 h-px" style={{ background: 'var(--color-border)' }} />
    </div>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

export function ServicesSection() {
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProviderConfig()
      .then(cfg => { setApps(cfg.apps ?? []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;

  // Extract all services from all apps, deduplicated by id
  const serviceMap = new Map<string, { service: Service; usedBy: string[] }>();
  for (const app of apps) {
    for (const svc of app.services ?? []) {
      if (!svc.id) continue;
      if (serviceMap.has(svc.id)) {
        serviceMap.get(svc.id)!.usedBy.push(app.name);
      } else {
        serviceMap.set(svc.id, { service: svc, usedBy: [app.name] });
      }
    }
  }

  const allServices = [...serviceMap.values()];
  const byKind: Record<string, typeof allServices> = { cloud: [], container: [], cpu: [], serverless: [] };
  for (const entry of allServices) {
    const k = entry.service.kind ?? 'cloud';
    if (!byKind[k]) byKind[k] = [];
    byKind[k].push(entry);
  }

  const totalServices = allServices.length;
  const totalApps = apps.length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'rgba(96,165,250,0.15)' }}>
            <Server className="w-4 h-4" style={{ color: '#60a5fa' }} />
          </div>
          <h2 className="text-lg font-bold">Services</h2>
        </div>
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Unidades de deploy — APIs cloud, containers Docker e funções serverless que fornecem STT, LLM e TTS.
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total de serviços', value: totalServices, color: '#60a5fa' },
          { label: 'Apps configurados', value: totalApps, color: '#a78bfa' },
          { label: 'Containers GPU', value: byKind.container?.length ?? 0, color: '#a78bfa' },
          { label: 'Máquinas CPU', value: byKind.cpu?.length ?? 0, color: '#f59e0b' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl border p-4 text-center"
            style={{ borderColor: `color-mix(in srgb, ${color} 20%, var(--color-border))`, background: 'var(--color-surface-elevated)' }}>
            <div className="font-mono text-2xl font-bold mb-0.5" style={{ color }}>{value}</div>
            <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg p-3 text-sm" style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
          {error}
        </div>
      )}

      {/* Empty state */}
      {totalServices === 0 && !error && (
        <div className="rounded-xl border p-10 text-center" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <Server className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p className="font-medium mb-1">Nenhum serviço configurado</p>
          <p className="text-sm mb-4" style={{ color: 'var(--color-text-muted)' }}>
            Crie um App e adicione serviços a ele para que apareçam aqui.
          </p>
          <a
            href="/dashboard/config/apps"
            onClick={e => { e.preventDefault(); window.history.pushState(null, '', '/config/apps'); window.dispatchEvent(new PopStateEvent('popstate')); }}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg"
            style={{ background: 'var(--color-primary)', color: '#fff' }}
          >
            Ir para Apps
          </a>
        </div>
      )}

      {/* Services grouped by kind */}
      {(['cloud', 'container', 'cpu', 'serverless'] as const).map(kind => {
        const entries = byKind[kind] ?? [];
        if (entries.length === 0) return null;
        return (
          <div key={kind}>
            <GroupHeader kind={kind} count={entries.length} />
            <div className="space-y-2">
              {entries.map(({ service, usedBy }) => (
                <ServiceCard key={service.id} service={service} usedByApps={usedBy} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Link to Apps */}
      {totalServices > 0 && (
        <div className="rounded-xl border p-4 flex items-center justify-between"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
          <div>
            <p className="text-sm font-medium">Configurar pipelines</p>
            <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              Defina quais serviços usar em cada estágio STT → LLM → TTS.
            </p>
          </div>
          <button
            onClick={() => { window.history.pushState(null, '', '/config/apps'); window.dispatchEvent(new PopStateEvent('popstate')); }}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg flex-shrink-0"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            Abrir Apps <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
