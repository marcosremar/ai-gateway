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
  Cpu, ScanSearch, AlertCircle, X as XIcon, Cloud,
} from 'lucide-react';
import {
  DEFAULT_DOCKER_IMAGES, GPU_TYPES, GPU_TYPES_BY_PROVIDER, PIPELINE_CATALOG, GPU_PROVIDERS,
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
  const [name, setName] = useState(initial?.name || '');
  const [kind, setKind] = useState<ServiceKind>(initial?.kind || 'gpu-pod');
  const [cloudProvider, setCloudProvider] = useState(initial?.cloudProvider || 'groq');

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

  // Live GPU catalog from provider
  const [liveGpus, setLiveGpus] = useState<GpuTypeInfo[]>([]);
  const [gpuLoading, setGpuLoading] = useState(false);

  useEffect(() => {
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
  }, [gpuCloudProvider]);

  const toggleGpu = (id: string) =>
    setGpuTypes(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);


  const handleSave = () => {
    if (!name.trim()) return;
    const s: ProfileService = {
      id: initial?.id || uid(),
      name: name.trim(),
      kind,
      ...(kind === 'cloud'
        ? { cloudProvider }
        : {
            dockerImage, gpuTypes, gpuCloudProvider,
            ...(sttModel ? { sttModel } : {}),
            ...(llmModel ? { llmModel } : {}),
            ...(ttsModel ? { ttsModel } : {}),
          }),
    };
    onSave(s);
  };

  return (
    <div className="rounded-xl border border-dashed overflow-hidden"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b"
        style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 3%, transparent)' }}>
        <IconBox icon={Server} color="#a78bfa" size="sm" />
        <span className="text-sm font-semibold">{initial ? 'Edit Service' : 'New Service'}</span>
      </div>

      <div className="p-4 space-y-4">

        {/* ── Identity section ── */}
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Identity</p>
          <FormInput label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="GPU Pod A" />
          {/* Kind toggle */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Type</label>
            <div className="flex gap-2">
              {(['gpu-pod', 'cloud'] as const).map(k => {
                const sel = kind === k;
                const KIcon = k === 'gpu-pod' ? Cpu : Cloud;
                return (
                  <button key={k} type="button" onClick={() => setKind(k)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
                    style={{
                      background: sel ? 'color-mix(in srgb, #a78bfa 12%, transparent)' : 'var(--color-surface-elevated)',
                      borderColor: sel ? '#a78bfa' : 'var(--color-border)',
                      color: sel ? '#c4b5fd' : 'var(--color-text-muted)',
                    }}>
                    <KIcon className="w-3.5 h-3.5" />
                    {k === 'gpu-pod' ? 'GPU Pod' : 'Cloud API'}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {kind === 'cloud' ? (
          /* ── Cloud provider buttons ── */
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>Cloud Provider</p>
            <div className="flex flex-wrap gap-2">
              {(['groq', 'openai', 'deepgram', 'fireworks', 'modal', 'tensordock'] as const).map(pid => {
                const provIcon = PROVIDER_ICON[pid];
                const ProvIcon = provIcon?.icon ?? Package;
                const provColor = provIcon?.color ?? '#7ba896';
                const sel = cloudProvider === pid;
                return (
                  <button key={pid} type="button" onClick={() => setCloudProvider(pid)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer capitalize"
                    style={{
                      background: sel ? `color-mix(in srgb, ${provColor} 12%, transparent)` : 'var(--color-surface-elevated)',
                      borderColor: sel ? provColor : 'var(--color-border)',
                      color: sel ? provColor : 'var(--color-text-muted)',
                    }}>
                    <ProvIcon className="w-3.5 h-3.5" />
                    {pid}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {/* ── Docker Image section ── */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>Docker Image</p>
              {!useCustom ? (
                <>
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
                  <button
                    type="button"
                    onClick={() => { setUseCustom(true); setCustomDockerUrl(dockerImage); }}
                    className="text-[10px] font-medium transition-colors cursor-pointer mt-1.5"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Use a custom Docker image URL"
                  >
                    + Custom image URL
                  </button>
                </>
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
                  {/* Inspect result */}
                  {inspectResult && (
                    <div className="p-2 rounded-lg border text-[11px] space-y-0.5"
                      style={{ borderColor: 'color-mix(in srgb, #10b981 30%, var(--color-border))', background: 'color-mix(in srgb, #10b981 4%, var(--color-surface-elevated))' }}>
                      <div className="font-semibold" style={{ color: '#34d399' }}>
                        Services: {inspectResult.services.length > 0 ? inspectResult.services.join(', ') : '—'}
                        {inspectResult.protocol !== 'rest' && <span className="ml-2" style={{ color: 'var(--color-text-muted)' }}>({inspectResult.protocol})</span>}
                      </div>
                      {[inspectResult.sttModel, inspectResult.llmModel, inspectResult.ttsModel].some(Boolean) && (
                        <div style={{ color: 'var(--color-text-muted)' }}>Models auto-filled ↓</div>
                      )}
                    </div>
                  )}
                  {inspectError && (
                    <div className="p-2 rounded-lg border text-[11px] flex items-center gap-1.5"
                      style={{ borderColor: 'color-mix(in srgb, #f87171 30%, var(--color-border))', color: '#f87171', background: 'color-mix(in srgb, #f87171 4%, var(--color-surface-elevated))' }}>
                      <AlertCircle className="w-3 h-3 flex-shrink-0" />
                      {inspectResult === null && 'No babelcast labels found — '}
                      {inspectError}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Models section ── */}
            <div className="rounded-lg border overflow-hidden"
              style={{ borderColor: 'var(--color-border)' }}>
              <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 4%, transparent)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Models provided by this pod</p>
              </div>
              <div className="p-3 space-y-2.5">
                {(['stt', 'llm', 'tts'] as const).map(stage => {
                  const stageModels = (PIPELINE_CATALOG[stage].models as Record<string, { id: string; label: string }[]>).gpu ?? [];
                  const currentVal = stage === 'stt' ? sttModel : stage === 'llm' ? llmModel : ttsModel;
                  const setter = stage === 'stt' ? setSttModel : stage === 'llm' ? setLlmModel : setTtsModel;
                  const hasUnknown = currentVal && !stageModels.find(m => m.id === currentVal);
                  const stageColor = stage === 'stt' ? '#38bdf8' : stage === 'llm' ? '#a78bfa' : '#fbbf24';
                  const StageIcon = stage === 'stt' ? Mic : stage === 'llm' ? Bot : Volume2;
                  return (
                    <div key={stage} className="flex items-center gap-2.5">
                      <div className="flex items-center gap-1.5 w-12 flex-shrink-0">
                        <StageIcon className="w-3 h-3 flex-shrink-0" style={{ color: stageColor }} />
                        <span className="text-[10px] font-semibold uppercase" style={{ color: stageColor }}>{stage}</span>
                      </div>
                      <select
                        className="flex-1 text-xs rounded-lg border px-2 py-1.5 outline-none focus:ring-1 cursor-pointer"
                        style={{ background: 'var(--color-surface-elevated)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                        value={currentVal}
                        onChange={e => setter(e.target.value)}
                      >
                        <option value="">— none —</option>
                        {hasUnknown && <option value={currentVal}>{currentVal} (current)</option>}
                        {stageModels.map(m => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Infrastructure section ── */}
            <div className="rounded-lg border overflow-hidden"
              style={{ borderColor: 'var(--color-border)' }}>
              <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--color-border)', background: 'color-mix(in srgb, var(--color-text-muted) 4%, transparent)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Infrastructure</p>
              </div>
              <div className="p-3 space-y-3">
                {/* GPU Cloud Provider as icon buttons */}
                <div>
                  <label className="block text-[10px] font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>GPU Cloud Provider</label>
                  <div className="flex gap-2 flex-wrap">
                    {GPU_PROVIDERS.map(p => {
                      const provIcon = PROVIDER_ICON[p.id];
                      const PIcon = provIcon?.icon ?? Cpu;
                      const pColor = provIcon?.color ?? p.color;
                      const sel = gpuCloudProvider === p.id;
                      return (
                        <button key={p.id} type="button"
                          onClick={() => { setGpuCloudProvider(p.id); setGpuTypes([]); }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer"
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

                {/* GPU type selection */}
                <div>
                  <label className="block text-[10px] font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                    GPU Types
                    {gpuTypes.length > 0 && (
                      <span className="ml-2 px-1.5 py-0.5 rounded-md text-[10px] font-bold"
                        style={{ background: 'color-mix(in srgb, #a78bfa 12%, transparent)', color: '#c4b5fd' }}>
                        {gpuTypes.length} selected
                      </span>
                    )}
                  </label>

                  {/* Selected chips (priority order) */}
                  {gpuTypes.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {gpuTypes.map((id, idx) => {
                        const info = liveGpus.find(g => g.name === id);
                        const label = info?.shortName ?? id.replace(/NVIDIA\s*/i, '').replace(/GeForce\s*/i, '');
                        return (
                          <span key={id}
                            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium"
                            style={{ background: 'color-mix(in srgb, #a78bfa 12%, transparent)', color: '#c4b5fd', border: '1px solid color-mix(in srgb, #a78bfa 30%, transparent)' }}>
                            <span className="text-[9px] font-bold opacity-60">#{idx + 1}</span>
                            {label}
                            <button type="button" onClick={() => toggleGpu(id)} className="ml-0.5 hover:opacity-70 cursor-pointer">×</button>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {/* Add GPU via DropdownList */}
                  <DropdownList
                    options={liveGpus
                      .filter(g => !gpuTypes.includes(g.name))
                      .map(g => {
                        const vramGb = g.vramGb ?? (g.vram > 0 ? g.vram : null);
                        return {
                          key: g.name,
                          label: g.shortName,
                          subtitle: [vramGb ? `${vramGb}GB` : null, g.minPricePerHr != null ? `$${g.minPricePerHr.toFixed(2)}/hr` : null].filter(Boolean).join(' · ') || undefined,
                        };
                      })}
                    value=""
                    onChange={key => toggleGpu(key)}
                    accent="#a78bfa"
                    size="sm"
                    placeholder={gpuLoading ? 'Loading GPUs...' : gpuTypes.length > 0 ? 'Add another GPU type...' : 'Select GPU type...'}
                  />
                </div>
              </div>{/* end Infrastructure inner */}
            </div>{/* end Infrastructure card */}
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
