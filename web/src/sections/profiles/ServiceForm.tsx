'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  inspectDockerImage, getGpuTypes, type GpuTypeInfo, type DockerManifest,
} from '@/lib/gateway';
import {
  Button, FormInput, IconBox, DropdownList,
} from '@/components/ui';
import {
  Check, Package, Server, Bot, Volume2, Mic, Loader2,
  Cpu, ScanSearch, AlertCircle, X as XIcon, Cloud, Zap,
} from 'lucide-react';
import {
  DEFAULT_DOCKER_IMAGES, GPU_TYPES, GPU_TYPES_BY_PROVIDER, PIPELINE_CATALOG, GPU_PROVIDERS,
  CLOUD_API_PROVIDERS, SERVERLESS_PROVIDERS,
  type PipelineChainEntry, type ProfileService, type ServiceKind,
} from '../provider-types';
import { PROVIDER_ICON } from '../FallbackChainList';
import { uid } from './constants';

interface ServiceFormProps {
  initial?: ProfileService;
  onSave: (s: ProfileService) => void;
  onCancel: () => void;
}

function ServiceForm({ initial, onSave, onCancel }: ServiceFormProps) {
  // Derive initial kind — migrate modal-cloud → serverless
  const deriveKind = (s?: ProfileService): ServiceKind => {
    if (!s) return 'gpu-pod';
    if (s.kind === 'cloud' && s.cloudProvider === 'modal') return 'serverless';
    return s.kind;
  };

  const [name, setName] = useState(initial?.name || '');
  const [kind, setKind] = useState<ServiceKind>(deriveKind(initial));
  const [cloudProvider, setCloudProvider] = useState(initial?.cloudProvider || 'groq');
  const [serverlessProvider, setServerlessProvider] = useState(
    (initial?.kind === 'cloud' && initial?.cloudProvider === 'modal') ? 'modal'
    : initial?.kind === 'serverless' ? (initial?.cloudProvider || 'modal')
    : 'modal'
  );

  // Docker image: either a known preset or custom URL
  const initDockerUrl = initial?.dockerImage || DEFAULT_DOCKER_IMAGES[0].url;
  const isKnownUrl = (url: string) => DEFAULT_DOCKER_IMAGES.some(img => img.url === url);
  const [dockerImage, setDockerImage] = useState(initDockerUrl);
  const [customDockerUrl, setCustomDockerUrl] = useState(isKnownUrl(initDockerUrl) ? '' : initDockerUrl);
  const [useCustom, setUseCustom] = useState(!isKnownUrl(initDockerUrl));

  const [gpuTypes, setGpuTypes] = useState<string[]>(initial?.gpuTypes || []);
  const [gpuCloudProvider, setGpuCloudProvider] = useState(initial?.gpuCloudProvider || GPU_PROVIDERS[0].id);

  // Auto-fill models from known Docker image (works for both new and edit)
  const knownImg = DEFAULT_DOCKER_IMAGES.find(img => img.url === dockerImage);
  const [sttModel, setSttModel] = useState(initial?.sttModel || knownImg?.sttModel || '');
  const [llmModel, setLlmModel] = useState(initial?.llmModel || knownImg?.llmModel || '');
  const [ttsModel, setTtsModel] = useState(initial?.ttsModel || knownImg?.ttsModel || '');

  // Docker inspect
  const [inspecting, setInspecting] = useState(false);
  const [inspectResult, setInspectResult] = useState<DockerManifest | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const handleInspect = async () => {
    if (!dockerImage.trim()) return;
    setInspecting(true);
    setInspectError(null);
    setInspectResult(null);
    try {
      const result = await inspectDockerImage(dockerImage.trim());
      if (!mountedRef.current) return;
      setInspectResult(result);
      if (result.sttModel) setSttModel(result.sttModel);
      if (result.llmModel) setLlmModel(result.llmModel);
      if (result.ttsModel) setTtsModel(result.ttsModel);
    } catch (err) {
      if (!mountedRef.current) return;
      setInspectError(err instanceof Error ? err.message : 'Inspect failed');
    } finally {
      if (mountedRef.current) setInspecting(false);
    }
  };

  // Live GPU catalog from provider (only for self-hosted)
  const [liveGpus, setLiveGpus] = useState<GpuTypeInfo[]>([]);
  const [gpuLoading, setGpuLoading] = useState(false);

  useEffect(() => {
    if (kind !== 'gpu-pod') return;
    setGpuLoading(true);
    setLiveGpus([]);
    getGpuTypes(gpuCloudProvider)
      .then(data => setLiveGpus(data.gpuTypes))
      .catch(() => {
        // fall back to static list
        const ids = GPU_TYPES_BY_PROVIDER[gpuCloudProvider] ?? GPU_TYPES.map(g => g.id);
        setLiveGpus(ids.map(id => {
          const meta = GPU_TYPES.find(g => g.id === id);
          return { name: id, shortName: meta?.label ?? id.replace(/NVIDIA\s*/i, '').replace(/GeForce\s*/i, ''), vram: parseInt(meta?.vram ?? '0') };
        }));
      })
      .finally(() => setGpuLoading(false));
  }, [gpuCloudProvider, kind]);

  const toggleGpu = (id: string) =>
    setGpuTypes(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);


  const handleSave = () => {
    if (!name.trim()) return;
    const base = { id: initial?.id || uid(), name: name.trim(), kind };
    const modelFields = {
      ...(sttModel ? { sttModel } : {}),
      ...(llmModel ? { llmModel } : {}),
      ...(ttsModel ? { ttsModel } : {}),
    };
    let s: ProfileService;
    if (kind === 'cloud') {
      s = { ...base, cloudProvider };
    } else if (kind === 'serverless') {
      s = { ...base, cloudProvider: serverlessProvider, dockerImage, ...modelFields };
    } else {
      s = { ...base, dockerImage, gpuTypes, gpuCloudProvider, ...modelFields };
    }
    onSave(s);
  };

  return (
    <div className="rounded-xl border border-dashed overflow-hidden"
      style={{ borderColor: 'color-mix(in srgb, #a78bfa 30%, var(--color-border))', background: 'var(--color-surface)' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, #a78bfa 4%, transparent)' }}>
        <div className="flex items-center gap-2">
          <IconBox icon={Server} color="#a78bfa" size="sm" />
          <span className="text-sm font-semibold">{initial ? 'Edit Service' : 'New Service'}</span>
        </div>
        <div className="flex gap-1.5">
          {([
            { k: 'gpu-pod' as ServiceKind, label: 'Self-hosted', TabIcon: Server },
            { k: 'serverless' as ServiceKind, label: 'Serverless', TabIcon: Cloud },
            { k: 'cloud' as ServiceKind, label: 'Cloud API', TabIcon: Zap },
          ]).map(tab => {
            const sel = kind === tab.k;
            return (
              <button key={tab.k} type="button" onClick={() => setKind(tab.k)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all cursor-pointer"
                style={{
                  background: sel ? 'color-mix(in srgb, #a78bfa 12%, transparent)' : 'transparent',
                  borderColor: sel ? '#a78bfa' : 'var(--color-border)',
                  color: sel ? '#c4b5fd' : 'var(--color-text-muted)',
                }}>
                <tab.TabIcon className="w-3 h-3" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-4 space-y-3">

        {/* ── Name ── */}
        <FormInput label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="Service name" />

        {kind === 'cloud' ? (
          /* ── Cloud API provider buttons ── */
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>Cloud Provider</p>
            <div className="flex flex-wrap gap-1.5">
              {CLOUD_API_PROVIDERS.map(p => {
                const provIcon = PROVIDER_ICON[p.id];
                const ProvIcon = provIcon?.icon ?? Package;
                const provColor = provIcon?.color ?? p.color;
                const sel = cloudProvider === p.id;
                return (
                  <button key={p.id} type="button" onClick={() => setCloudProvider(p.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
                    style={{
                      background: sel ? `color-mix(in srgb, ${provColor} 12%, transparent)` : 'var(--color-surface-elevated)',
                      borderColor: sel ? provColor : 'var(--color-border)',
                      color: sel ? provColor : 'var(--color-text-muted)',
                    }}>
                    <ProvIcon className="w-3.5 h-3.5" />
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {/* ── Serverless provider buttons ── */}
            {kind === 'serverless' && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>Provider</p>
                <div className="flex flex-wrap gap-1.5">
                  {SERVERLESS_PROVIDERS.map(p => {
                    const provIcon = PROVIDER_ICON[p.id];
                    const PIcon = provIcon?.icon ?? Cloud;
                    const pColor = provIcon?.color ?? p.color;
                    const sel = serverlessProvider === p.id;
                    return (
                      <button key={p.id} type="button" onClick={() => setServerlessProvider(p.id)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
                        style={{
                          background: sel ? `color-mix(in srgb, ${pColor} 12%, transparent)` : 'var(--color-surface-elevated)',
                          borderColor: sel ? pColor : 'var(--color-border)',
                          color: sel ? pColor : 'var(--color-text-muted)',
                        }}>
                        <PIcon className="w-3.5 h-3.5" />
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Docker Image (shared: self-hosted + serverless) ── */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Docker Image</p>
              {!useCustom ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <DropdownList
                      options={DEFAULT_DOCKER_IMAGES.map(img => ({
                        key: img.url,
                        label: img.label,
                        subtitle: img.description,
                      }))}
                      value={dockerImage}
                      onChange={key => {
                        const img = DEFAULT_DOCKER_IMAGES.find(i => i.url === key);
                        setDockerImage(key);
                        setInspectResult(null);
                        setInspectError(null);
                        if (img) {
                          setSttModel(img.sttModel || '');
                          setLlmModel(img.llmModel || '');
                          setTtsModel(img.ttsModel || '');
                          if (!name || DEFAULT_DOCKER_IMAGES.some(i => `Babelcast ${i.label}` === name)) {
                            setName(`Babelcast ${img.label}`);
                          }
                        }
                      }}
                      accent="#a78bfa"
                      size="sm"
                      placeholder="Select Docker image..."
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => { setUseCustom(true); setCustomDockerUrl(dockerImage); }}
                    className="text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap px-2 py-1.5 rounded-md border"
                    style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border)' }}
                    title="Use a custom Docker image URL"
                  >
                    Custom
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      className="flex-1 text-xs rounded-lg border px-3 py-2 outline-none focus:ring-1"
                      style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                      value={customDockerUrl}
                      onChange={e => {
                        const url = e.target.value;
                        setCustomDockerUrl(url);
                        setDockerImage(url);
                        setInspectResult(null);
                        setInspectError(null);
                      }}
                      placeholder="namespace/image:tag"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handleInspect}
                      disabled={inspecting || !customDockerUrl.trim()}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
                      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text-secondary)' }}
                      title="Read service capabilities from Docker Hub labels"
                    >
                      {inspecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                      Inspect
                    </button>
                    <button
                      type="button"
                      onClick={() => { setUseCustom(false); setDockerImage(DEFAULT_DOCKER_IMAGES[0].url); }}
                      className="px-2 py-2 rounded-lg border text-xs transition-colors cursor-pointer"
                      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text-muted)' }}
                      title="Back to presets"
                    >
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {inspectResult && (
                    <div className="p-2 rounded-lg border text-[11px] space-y-0.5"
                      style={{ borderColor: 'color-mix(in srgb, #10b981 30%, var(--color-border))', background: 'color-mix(in srgb, #10b981 4%, var(--color-surface-elevated))' }}>
                      <div className="font-semibold" style={{ color: '#34d399' }}>
                        Services: {inspectResult.services.length > 0 ? inspectResult.services.join(', ') : '\u2014'}
                        {inspectResult.protocol !== 'rest' && <span className="ml-2" style={{ color: 'var(--color-text-muted)' }}>({inspectResult.protocol})</span>}
                      </div>
                      {[inspectResult.sttModel, inspectResult.llmModel, inspectResult.ttsModel].some(Boolean) && (
                        <div style={{ color: 'var(--color-text-muted)' }}>Models auto-filled</div>
                      )}
                    </div>
                  )}
                  {inspectError && (
                    <div className="p-2 rounded-lg border text-[11px] flex items-center gap-1.5"
                      style={{ borderColor: 'color-mix(in srgb, #f87171 30%, var(--color-border))', color: '#f87171', background: 'color-mix(in srgb, #f87171 4%, var(--color-surface-elevated))' }}>
                      <AlertCircle className="w-3 h-3 flex-shrink-0" />
                      {inspectResult === null && 'No babelcast labels found \u2014 '}
                      {inspectError}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Services (read-only, auto-detected from Docker image) ── */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Services</p>
              <div className="flex flex-wrap gap-1.5">
                {([
                  { stage: 'stt' as const, model: sttModel, StageIcon: Mic, color: '#38bdf8' },
                  { stage: 'llm' as const, model: llmModel, StageIcon: Bot, color: '#a78bfa' },
                  { stage: 'tts' as const, model: ttsModel, StageIcon: Volume2, color: '#fbbf24' },
                ]).filter(s => s.model).map(s => {
                  const models = (PIPELINE_CATALOG[s.stage].models as Record<string, { id: string; label: string }[]>).gpu ?? [];
                  const modelLabel = models.find(m => m.id === s.model)?.label ?? s.model;
                  return (
                    <div key={s.stage}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px]"
                      style={{
                        borderColor: `color-mix(in srgb, ${s.color} 30%, var(--color-border))`,
                        background: `color-mix(in srgb, ${s.color} 6%, transparent)`,
                      }}>
                      <s.StageIcon className="w-3 h-3" style={{ color: s.color }} />
                      <span className="font-semibold uppercase" style={{ color: s.color }}>{s.stage}</span>
                      <span style={{ color: 'var(--color-text-secondary)' }}>{modelLabel}</span>
                    </div>
                  );
                })}
                {!sttModel && !llmModel && !ttsModel && (
                  <span className="text-[11px] italic" style={{ color: 'var(--color-text-muted)' }}>No services detected</span>
                )}
              </div>
            </div>

            {/* ── Infrastructure (self-hosted only) ── */}
            {kind === 'gpu-pod' && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Infrastructure</p>

                {/* GPU Cloud Provider */}
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {GPU_PROVIDERS.map(p => {
                    const provIcon = PROVIDER_ICON[p.id];
                    const PIcon = provIcon?.icon ?? Cpu;
                    const pColor = provIcon?.color ?? p.color;
                    const sel = gpuCloudProvider === p.id;
                    return (
                      <button key={p.id} type="button"
                        onClick={() => { setGpuCloudProvider(p.id); setGpuTypes([]); }}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all cursor-pointer"
                        style={{
                          background: sel ? `color-mix(in srgb, ${pColor} 12%, transparent)` : 'transparent',
                          borderColor: sel ? pColor : 'var(--color-border)',
                          color: sel ? pColor : 'var(--color-text-muted)',
                        }}>
                        <PIcon className="w-3 h-3" />
                        {p.name}
                      </button>
                    );
                  })}
                </div>

                {/* GPU type selection */}
                <div>
                  {gpuTypes.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {gpuTypes.map((id, idx) => {
                        const info = liveGpus.find(g => g.name === id);
                        const label = info?.shortName ?? id.replace(/NVIDIA\s*/i, '').replace(/GeForce\s*/i, '');
                        const latMs = info?.bestLatencyMs;
                        const latColor = latMs == null ? 'var(--color-text-muted)' : latMs < 100 ? '#34d399' : latMs < 250 ? '#fbbf24' : '#f87171';
                        return (
                          <span key={id}
                            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium"
                            style={{ background: 'color-mix(in srgb, #a78bfa 12%, transparent)', color: '#c4b5fd', border: '1px solid color-mix(in srgb, #a78bfa 30%, transparent)' }}>
                            <span className="text-[9px] font-bold opacity-60">#{idx + 1}</span>
                            {label}
                            {latMs != null && (
                              <span className="text-[9px] font-mono" style={{ color: latColor }}>{Math.round(latMs)}ms</span>
                            )}
                            <button type="button" onClick={() => toggleGpu(id)} className="ml-0.5 hover:opacity-70 cursor-pointer">&times;</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <DropdownList
                    options={liveGpus
                      .filter(g => !gpuTypes.includes(g.name))
                      .map(g => {
                        const vramGb = g.vramGb ?? (g.vram > 0 ? g.vram : null);
                        const latMs = g.bestLatencyMs;
                        const latLabel = latMs != null ? `${Math.round(latMs)}ms` : null;
                        return {
                          key: g.name,
                          label: g.shortName,
                          subtitle: [vramGb ? `${vramGb}GB` : null, g.minPricePerHr != null ? `$${g.minPricePerHr.toFixed(2)}/hr` : null, latLabel].filter(Boolean).join(' \u00b7 ') || undefined,
                        };
                      })}
                    value=""
                    onChange={key => toggleGpu(key)}
                    accent="#a78bfa"
                    size="sm"
                    placeholder={gpuLoading ? 'Loading GPUs...' : gpuTypes.length > 0 ? 'Add GPU...' : 'Select GPU type...'}
                  />
                </div>
              </div>
            )}
          </>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 justify-end pt-1">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={!name.trim()}>
            <Check className="w-3.5 h-3.5" /> {initial ? 'Update' : 'Add'}
          </Button>
        </div>
      </div>{/* end form body */}
    </div>
  );
}

export { ServiceForm };
export type { ServiceFormProps };
