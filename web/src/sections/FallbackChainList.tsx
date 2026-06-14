'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import Sortable from 'sortablejs';
import { GripVertical, Plus, Trash2, ChevronDown, Cpu, Cloud, Zap, Server, Pencil, Mic2, Shuffle, Box, Globe, Flame, Rocket } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, Toggle, DropdownList, type DropdownOption } from '@/components/ui';
import { type PipelineChainEntry, type Service, PIPELINE_CATALOG, DEFAULT_DOCKER_IMAGES } from './provider-types';
import { latencySuffix, type ServiceStatsData } from '@/lib/service-stats';
import { getServiceStats } from '@/lib/gateway';

interface Accent { iconColor: string; dot: string; }

/** Provider → icon + color mapping */
export const PROVIDER_ICON: Record<string, { icon: LucideIcon; color: string }> = {
  gpu:          { icon: Cpu,     color: '#f59e0b' },
  groq:         { icon: Zap,     color: '#7ba896' },
  openai:       { icon: Globe,   color: '#8b8fc7' },
  deepgram:     { icon: Mic2,    color: '#6366f1' },
  elevenlabs:   { icon: Mic2,    color: '#f43f5e' },
  fireworks:    { icon: Flame,   color: '#e07a3a' },
  'qwen3-asr':  { icon: Mic2,    color: '#06b6d4' },
  modal:        { icon: Rocket,  color: '#a78bfa' },
  'modal-moss': { icon: Rocket,  color: '#c084fc' },
  openrouter:   { icon: Shuffle, color: '#34d399' },
  ollama:       { icon: Box,     color: '#94a3b8' },
};
const DEFAULT_ICON = { icon: Cloud, color: 'var(--color-text-muted)' };

interface ServiceOption {
  key: string;
  label: string;
  subtitle: string;
  provider: string;
  model: string;
  group: string;
  streaming?: boolean;
  icon?: LucideIcon;
  iconColor?: string;
}

interface FallbackChainListProps {
  stage: 'stt' | 'llm' | 'tts';
  chain: PipelineChainEntry[];
  setChain: (chain: PipelineChainEntry[]) => void;
  accent: Accent;
  /** GPU pod / cloud services from the profile */
  services?: Service[];
}

export default function FallbackChainList({ stage, chain, setChain, accent, services }: FallbackChainListProps) {
  const [addingFallback, setAddingFallback] = useState(false);
  const [selectedKey, setSelectedKey] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // Latency stats per `stage::provider` from /v1/metrics/service-stats.
  const [serviceStats, setServiceStats] = useState<ServiceStatsData | null>(null);

  const catalog = PIPELINE_CATALOG[stage];
  const providers = catalog.providers;

  // Fetch service latency stats via the typed gateway client (#949) — auth +
  // error handling are consistent and the payload is defensively normalized,
  // instead of a bare `fetch('/v1/...')` with untyped JSON.
  useEffect(() => {
    getServiceStats()
      .then(d => { if (d) setServiceStats(d); })
      .catch(() => {});
  }, []);

  const sortableContainerRef = useRef<HTMLDivElement>(null);
  const sortableInstanceRef = useRef<Sortable | null>(null);
  const chainRef = useRef(chain);
  useEffect(() => { chainRef.current = chain; }, [chain]);

  useEffect(() => {
    const el = sortableContainerRef.current;
    if (!el) return;
    if (sortableInstanceRef.current) sortableInstanceRef.current.destroy();
    sortableInstanceRef.current = Sortable.create(el, {
      handle: '.chain-drag-handle',
      animation: 150,
      ghostClass: 'opacity-50',
      onEnd: (evt) => {
        const { oldIndex, newIndex } = evt;
        if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
        const next = [...chainRef.current];
        const [moved] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, moved);
        setChain(next);
      },
    });
    return () => { try { sortableInstanceRef.current?.destroy(); } catch {} sortableInstanceRef.current = null; };
  }, [setChain]);

  const getIcon = (providerId: string) => PROVIDER_ICON[providerId] || DEFAULT_ICON;

  // Latency suffix logic lives in the pure `latencySuffix` helper (#950), called
  // directly inside the `serviceOptions` memo below.

  // Build flat list of all available service options
  // Order: Serverless (fast, few items) → Self-hosted → Cloud
  const serviceOptions = useMemo((): ServiceOption[] => {
    const opts: ServiceOption[] = [];
    const gi = PROVIDER_ICON['gpu'] || DEFAULT_ICON;
    const existing = new Set<string>();

    // 1. Serverless providers (Modal) — fast cold start, shown first
    const SERVERLESS_IDS = new Set(['modal', 'modal-moss']);
    for (const p of providers) {
      if (!SERVERLESS_IDS.has(p.id)) continue;
      const pi = PROVIDER_ICON[p.id] || DEFAULT_ICON;
      const models = (catalog.models as Record<string, { id: string; label: string; streaming?: boolean }[]>)[p.id] ?? [];
      for (const m of models) {
        const pAny = p as { id: string; label: string; streaming?: boolean };
        opts.push({
          key: `${p.id}::${m.id}`, label: `${p.label} — ${m.label}`, subtitle: m.label,
          provider: p.id, model: m.id, group: 'Serverless',
          streaming: pAny.streaming ?? m.streaming, icon: pi.icon, iconColor: pi.color,
        });
      }
    }

    // 2. Self-hosted services (Docker images on GPU pods)
    if (services) {
      for (const svc of services) {
        if (svc.kind !== 'container') continue;

        const knownImg = svc.dockerImage
          ? DEFAULT_DOCKER_IMAGES.find(i => i.url === svc.dockerImage)
          : undefined;
        const effectiveStt = svc.sttModel || knownImg?.sttModel;
        const effectiveLlm = svc.llmModel || knownImg?.llmModel;
        const effectiveTts = svc.ttsModel || knownImg?.ttsModel;
        const hasAnyModel = !!(effectiveStt || effectiveLlm || effectiveTts);

        const stageModel = stage === 'stt' ? effectiveStt
          : stage === 'llm' ? effectiveLlm
          : effectiveTts;

        if (stageModel) {
          const k = `gpu::${svc.id}`;
          existing.add(k);
          const dockerShort = svc.dockerImage ? svc.dockerImage.split('/').pop() || svc.dockerImage : '';
          opts.push({
            key: k, label: stageModel,
            subtitle: dockerShort,
            provider: 'gpu', model: svc.id, group: 'Self-hosted Services',
            icon: gi.icon, iconColor: gi.color,
          });
        } else if (!hasAnyModel) {
          const k = `gpu::${svc.id}`;
          existing.add(k);
          opts.push({
            key: k, label: svc.name,
            subtitle: svc.dockerImage ? svc.dockerImage.split('/').pop() || svc.dockerImage : '',
            provider: 'gpu', model: svc.id, group: 'Self-hosted Services',
            icon: gi.icon, iconColor: gi.color,
          });
        }
      }
    }

    // GPU models from catalog (fallback for services not in profile)
    const gpuProvider = providers.find(p => p.id === 'gpu');
    if (gpuProvider) {
      const models = (catalog.models as Record<string, { id: string; label: string; streaming?: boolean }[]>)['gpu'] ?? [];
      for (const m of models) {
        const k = `gpu::${m.id}`;
        if (!existing.has(k)) {
          existing.add(k);
          opts.push({
            key: k, label: m.label, subtitle: m.id,
            provider: 'gpu', model: m.id, group: 'Self-hosted Services',
            streaming: m.streaming, icon: gi.icon, iconColor: gi.color,
          });
        }
      }
      // Note: GPU options are NOT deduplicated against the chain — users can add
      // the same GPU multiple times for redundancy (gpu → gpu → cloud).
    }

    // 3. Cloud API providers
    for (const p of providers) {
      if (p.id === 'gpu' || SERVERLESS_IDS.has(p.id)) continue;
      const pi = PROVIDER_ICON[p.id] || DEFAULT_ICON;
      const models = (catalog.models as Record<string, { id: string; label: string; streaming?: boolean }[]>)[p.id] ?? [];
      for (const m of models) {
        const pAny = p as { id: string; label: string; streaming?: boolean };
        opts.push({
          key: `${p.id}::${m.id}`, label: `${p.label} — ${m.label}`, subtitle: m.label,
          provider: p.id, model: m.id, group: 'Cloud',
          streaming: pAny.streaming ?? m.streaming, icon: pi.icon, iconColor: pi.color,
        });
      }
    }

    // Enrich subtitles with latency data via the pure helper so this memo's
    // `serviceStats` dependency is honest (no stale closure — #950).
    return opts.map(o => {
      const suffix = latencySuffix(stage, o.provider, serviceStats);
      return suffix ? { ...o, subtitle: o.subtitle + suffix } : o;
    });
  }, [stage, services, providers, catalog.models, serviceStats]);

  /** Find the ServiceOption matching a chain entry */
  const findOption = (entry: PipelineChainEntry): ServiceOption | undefined =>
    serviceOptions.find(o => o.key === `${entry.provider}::${entry.model}`);

  /** Get display label for a chain entry */
  const getEntryLabel = (entry: PipelineChainEntry): string => {
    const opt = findOption(entry);
    if (opt) return opt.label;
    // Fallback for entries not in the options (e.g., manually created)
    const prov = providers.find(p => p.id === entry.provider);
    return prov?.label || entry.provider;
  };

  const getEntrySubtitle = (entry: PipelineChainEntry): string => {
    const opt = findOption(entry);
    if (opt) return opt.subtitle;
    return entry.model;
  };

  /** Determine if a provider entry supports streaming. */
  const getStreamingType = (entry: PipelineChainEntry): 'streaming' | 'batch' | null => {
    if (entry.sttType) return entry.sttType;
    const opt = findOption(entry);
    if (opt?.streaming !== undefined) return opt.streaming ? 'streaming' : 'batch';
    const prov = (providers as readonly { id: string; label: string; streaming?: boolean }[]).find(p => p.id === entry.provider);
    if (prov?.streaming !== undefined) return prov.streaming ? 'streaming' : 'batch';
    if (stage === 'stt') return 'batch';
    return null;
  };

  const removeEntry = (index: number) => {
    setChain(chain.filter((_, i) => i !== index));
  };

  const toggleEnabled = (index: number) => {
    setChain(chain.map((e, i) => i === index ? { ...e, enabled: !(e.enabled !== false) } : e));
  };

  const updateEntry = (index: number, key: string) => {
    const opt = serviceOptions.find(o => o.key === key);
    if (!opt) return;
    setChain(chain.map((e, i) => {
      if (i !== index) return e;
      const updated: PipelineChainEntry = { ...e, provider: opt.provider, model: opt.model };
      if (stage === 'stt') updated.sttType = opt.streaming ? 'streaming' : 'batch';
      return updated;
    }));
    setEditingIndex(null);
  };

  const handleAddFallback = () => {
    const opt = serviceOptions.find(o => o.key === selectedKey);
    if (!opt) return;
    const entry: PipelineChainEntry = { provider: opt.provider, model: opt.model, enabled: true };
    if (stage === 'stt') {
      entry.sttType = opt.streaming ? 'streaming' : 'batch';
    }
    setChain([...chain, entry]);
    setAddingFallback(false);
    setSelectedKey('');
  };

  const startAddFallback = () => {
    const existingNonGpu = new Set(
      chain.filter(e => e.provider !== 'gpu').map(e => `${e.provider}::${e.model}`)
    );
    // Pick first option not already in chain (GPU always allowed for redundancy)
    const first = serviceOptions.find(o =>
      o.provider === 'gpu' || !existingNonGpu.has(`${o.provider}::${o.model}`)
    );
    setSelectedKey(first?.key || serviceOptions[0]?.key || '');
    setAddingFallback(true);
  };

  // (grouping handled by DropdownList via option.group)

  return (
    <div>
      {chain.length > 1 && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-[10px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
            Tries top to bottom
          </span>
          <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        </div>
      )}

      <div ref={sortableContainerRef} className="space-y-1.5">
        {chain.map((entry, index) => {
          const isPrimary = index === 0;
          const isLast = index === chain.length - 1;
          const isEnabled = entry.enabled !== false;
          const streamType = getStreamingType(entry);
          const isEditing = editingIndex === index;

          return (
            <div key={`${entry.provider}-${entry.model}-${index}`} data-id={index}>
              <div
                className="group flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-all relative"
                style={{
                  borderColor: isEditing
                    ? accent.dot
                    : !isEnabled
                      ? 'var(--color-border-light)'
                      : isPrimary
                        ? `color-mix(in srgb, ${accent.dot} 30%, var(--color-border))`
                        : 'var(--color-border)',
                  background: !isEnabled
                    ? 'transparent'
                    : isPrimary
                      ? `color-mix(in srgb, ${accent.dot} 4%, var(--color-surface))`
                      : 'var(--color-surface)',
                  opacity: isEnabled ? 1 : 0.5,
                }}
              >
                {/* Drag handle */}
                <div className="chain-drag-handle cursor-grab active:cursor-grabbing flex-shrink-0 p-0.5 rounded hover:bg-white/5">
                  <GripVertical className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
                </div>

                {/* Order number */}
                <span className="text-[10px] font-bold w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
                  style={{
                    background: isPrimary && isEnabled
                      ? `color-mix(in srgb, ${accent.dot} 20%, transparent)`
                      : 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
                    color: isPrimary && isEnabled ? accent.dot : 'var(--color-text-muted)',
                  }}>
                  {index + 1}
                </span>

                {/* Role label */}
                <span className="text-[10px] font-semibold uppercase tracking-wide flex-shrink-0"
                  style={{ color: isPrimary && isEnabled ? accent.dot : 'var(--color-text-muted)', minWidth: '52px' }}>
                  {isPrimary ? 'Primary' : 'Fallback'}
                </span>

                {/* Service name + subtitle */}
                {(() => {
                  const pi = PROVIDER_ICON[entry.provider] || DEFAULT_ICON;
                  const EntryIcon = pi.icon;
                  return (
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                        style={{ background: `color-mix(in srgb, ${pi.color} 15%, transparent)` }}>
                        <EntryIcon className="w-3.5 h-3.5" style={{ color: pi.color }} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-xs font-semibold truncate ${!isEnabled ? 'line-through' : ''}`}>
                            {getEntryLabel(entry)}
                          </span>
                          {streamType === 'streaming' && (
                            <span className="text-[9px] font-medium bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded flex-shrink-0">streaming</span>
                          )}
                          {streamType === 'batch' && (
                            <span className="text-[9px] font-medium bg-gray-500/20 text-gray-400 px-1.5 py-0.5 rounded flex-shrink-0">batch</span>
                          )}
                        </div>
                        <div className="text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                          {getEntrySubtitle(entry)}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Enable/Disable toggle */}
                <Toggle checked={isEnabled} onChange={() => toggleEnabled(index)} size="sm" />

                {/* Edit */}
                <button type="button" onClick={() => setEditingIndex(editingIndex === index ? null : index)}
                  className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1 rounded hover:bg-white/10 transition-opacity cursor-pointer">
                  <Pencil className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
                </button>

                {/* Delete */}
                <button type="button" onClick={() => removeEntry(index)}
                  className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1 rounded hover:bg-red-500/10 transition-opacity cursor-pointer">
                  <Trash2 className="w-3 h-3 text-red-400" />
                </button>
              </div>

              {/* Inline edit dropdown */}
              {isEditing && (
                <div className="mt-2">
                  <DropdownList
                    options={serviceOptions as DropdownOption[]}
                    value={`${entry.provider}::${entry.model}`}
                    onChange={(key) => updateEntry(index, key)}
                    onClose={() => setEditingIndex(null)}
                    accent={accent.dot}
                    size="sm"
                    autoOpen
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add fallback */}
      <div className="mt-2">
        {addingFallback ? (
          <div className="flex flex-col gap-2 p-3 rounded-xl border border-dashed"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <DropdownList
              options={serviceOptions as DropdownOption[]}
              value={selectedKey}
              onChange={setSelectedKey}
              accent={accent.dot}
              placeholder="Select service..."
              size="sm"
            />
            <div className="flex items-center gap-1.5 justify-end">
              <Button variant="outline" size="sm" onClick={() => { setAddingFallback(false); setSelectedKey(''); }}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={handleAddFallback} disabled={!selectedKey}>Add</Button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={startAddFallback}
            className="flex items-center gap-1 w-full px-2 py-1.5 rounded-lg border border-dashed text-xs cursor-pointer transition-all hover:border-[var(--color-text-muted)]"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            <Plus className="w-3 h-3" /> Add fallback
          </button>
        )}
      </div>
    </div>
  );
}
