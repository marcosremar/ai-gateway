'use client';

import { useState, useEffect } from 'react';
import { useGpuStatus } from '@/hooks/useGpuStatus';
import { getProviderConfig, patchProviderConfig } from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, FormSelect, FormInput, Button,
  StatusBadge, Spinner, SectionHeader, SaveBar,
} from '@/components/ui';
import { Cloud, Cpu, Mic, Server, Plus, X, Check, Package, Circle, CircleDot, CircleCheck, Trash2, Loader2, ImagePlus } from 'lucide-react';
import {
  DEFAULT_DOCKER_IMAGES, GPU_TYPES,
  type DockerImage, type PipelineChainEntry,
} from './provider-types';
import PipelineStageConfig from './PipelineStageConfig';

const DEFAULT_STT: PipelineChainEntry[] = [{ provider: 'groq', model: 'whisper-large-v3-turbo' }];
const DEFAULT_LLM: PipelineChainEntry[] = [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }];
const DEFAULT_TTS: PipelineChainEntry[] = [{ provider: 'gpu', model: 'qwen3-tts' }];

export function ProvidersSection() {
  const { gpu } = useGpuStatus(true, 5000);

  const [mode, setMode] = useState<'pipeline' | 'gpu'>('pipeline');

  // Pipeline
  const [pipelineStt, setPipelineStt] = useState<PipelineChainEntry[]>(DEFAULT_STT);
  const [pipelineLlm, setPipelineLlm] = useState<PipelineChainEntry[]>(DEFAULT_LLM);
  const [pipelineTts, setPipelineTts] = useState<PipelineChainEntry[]>(DEFAULT_TTS);

  // GPU
  const [dockerImages, setDockerImages] = useState<DockerImage[]>(DEFAULT_DOCKER_IMAGES);
  const [gpuImage, setGpuImage] = useState(DEFAULT_DOCKER_IMAGES[0].url);
  const [gpuTypes, setGpuTypes] = useState<string[]>([GPU_TYPES[0].id]);
  const [gpuProvider, setGpuProvider] = useState('');
  const [idleTimeoutMin, setIdleTimeoutMin] = useState(15);

  // Add image form
  const [showAddImage, setShowAddImage] = useState(false);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [newImageLabel, setNewImageLabel] = useState('');
  const [newImageDesc, setNewImageDesc] = useState('');

  const [configLoaded, setConfigLoaded] = useState(false);

  // Dirty / save
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load
  useEffect(() => {
    getProviderConfig()
      .then((cfg: any) => {
        if (cfg.mode) setMode(cfg.mode);
        if (cfg.pipelineStt?.length) setPipelineStt(cfg.pipelineStt);
        if (cfg.pipelineLlm?.length) setPipelineLlm(cfg.pipelineLlm);
        if (cfg.pipelineTts?.length) setPipelineTts(cfg.pipelineTts);
        if (cfg.gpuImage) setGpuImage(cfg.gpuImage);
        if (cfg.gpuTypes?.length) setGpuTypes(cfg.gpuTypes);
        if (cfg.gpuProvider !== undefined) setGpuProvider(cfg.gpuProvider);
        if (cfg.dockerImages?.length) setDockerImages(cfg.dockerImages);
        if (typeof cfg.idleTimeoutMin === 'number') setIdleTimeoutMin(cfg.idleTimeoutMin);
        setConfigLoaded(true);
      })
      .catch(() => setConfigLoaded(true));
  }, []);

  // Track dirty
  useEffect(() => {
    if (configLoaded) setDirty(true);
  }, [mode, pipelineStt, pipelineLlm, pipelineTts, gpuImage, gpuTypes, gpuProvider, dockerImages, idleTimeoutMin]);

  // Save
  const handleSave = async () => {
    setSaving(true);
    try {
      await patchProviderConfig({
        mode,
        pipelineStt, pipelineLlm, pipelineTts,
        gpuImage, gpuTypes, gpuProvider, dockerImages,
        idleTimeoutMin,
      } as any);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {} finally { setSaving(false); }
  };

  const toggleGpu = (id: string) => setGpuTypes(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);

  const addImage = () => {
    if (!newImageUrl.trim()) return;
    const img: DockerImage = {
      url: newImageUrl.trim(),
      label: newImageLabel.trim() || newImageUrl.trim().split('/').pop()?.replace(':latest', '') || 'Custom',
      description: newImageDesc.trim(),
    };
    setDockerImages(prev => [...prev, img]);
    setGpuImage(img.url);
    setNewImageUrl(''); setNewImageLabel(''); setNewImageDesc('');
    setShowAddImage(false);
  };

  const removeImage = (url: string) => {
    setDockerImages(prev => prev.filter(d => d.url !== url));
    if (gpuImage === url) {
      setGpuImage(dockerImages.find(d => d.url !== url)?.url || '');
    }
  };

  const isGpuReady = gpu?.status === 'ready';
  const pipelineRouting = gpu?.pipelineRouting;

  return (
    <div className="p-6 space-y-5 pb-20">
      <SectionHeader
        title="Provider Configuration"
        subtitle="Pipeline fallback chains or GPU deployment profiles"
        action={
          <StatusBadge variant={isGpuReady ? 'emerald' : 'blue'} dot>
            {isGpuReady ? (
              <span className="flex items-center gap-1"><Cpu className="w-3 h-3" /> GPU {pipelineRouting?.mode || 'active'}</span>
            ) : (
              <span className="flex items-center gap-1"><Cloud className="w-3 h-3" /> Cloud</span>
            )}
          </StatusBadge>
        }
      />

      {/* Mode toggle */}
      <div className="flex gap-0 rounded-lg overflow-hidden border" style={{ borderColor: 'var(--color-border)' }}>
        <button onClick={() => setMode('pipeline')}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-all cursor-pointer"
          style={{
            background: mode === 'pipeline' ? 'color-mix(in srgb, #0ea5e9 10%, var(--color-surface))' : 'var(--color-surface)',
            color: mode === 'pipeline' ? '#7dd3fc' : 'var(--color-text-muted)',
            borderRight: '1px solid var(--color-border)',
          }}>
          <Mic className="w-4 h-4" /> Pipeline
          {mode === 'pipeline' && <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />}
        </button>
        <button onClick={() => setMode('gpu')}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-all cursor-pointer"
          style={{
            background: mode === 'gpu' ? 'color-mix(in srgb, #a78bfa 10%, var(--color-surface))' : 'var(--color-surface)',
            color: mode === 'gpu' ? '#c4b5fd' : 'var(--color-text-muted)',
          }}>
          <Server className="w-4 h-4" /> GPU Deploy
          {mode === 'gpu' && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />}
        </button>
      </div>

      {/* Config section */}
      {mode === 'pipeline' ? (
        <PipelineStageConfig
          pipelineStt={pipelineStt} setPipelineStt={setPipelineStt}
          pipelineLlm={pipelineLlm} setPipelineLlm={setPipelineLlm}
          pipelineTts={pipelineTts} setPipelineTts={setPipelineTts}
        />
      ) : (
        <div className="space-y-4">
          {/* Docker Images */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Docker Images</h3>
                <Button variant="outline" size="sm" onClick={() => setShowAddImage(!showAddImage)}>
                  <ImagePlus className="w-3.5 h-3.5" /> Add Image
                </Button>
              </div>
            </CardHeader>
            <CardBody className="space-y-2">
              {/* Image list */}
              {dockerImages.map(img => {
                const isSelected = gpuImage === img.url;
                return (
                  <div
                    key={img.url}
                    className="group flex items-start gap-3 p-3 rounded-lg border transition-all cursor-pointer"
                    onClick={() => setGpuImage(img.url)}
                    style={{
                      borderColor: isSelected ? 'color-mix(in srgb, #a78bfa 40%, transparent)' : 'var(--color-border)',
                      background: isSelected ? 'color-mix(in srgb, #a78bfa 4%, var(--color-surface))' : 'var(--color-surface)',
                    }}
                  >
                    {/* Selection indicator */}
                    <div className="flex-shrink-0 mt-0.5">
                      {isSelected
                        ? <CircleDot className="w-[18px] h-[18px]" style={{ color: '#a78bfa' }} />
                        : <Circle className="w-[18px] h-[18px]" style={{ color: 'var(--color-border)' }} />
                      }
                    </div>

                    {/* Icon */}
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ background: 'color-mix(in srgb, #a78bfa 10%, transparent)' }}>
                      <Package className="w-4 h-4" style={{ color: '#a78bfa' }} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold">{img.label}</div>
                      <div className="text-[11px] font-mono truncate" style={{ color: 'var(--color-text-muted)' }}>{img.url}</div>
                      {img.description && (
                        <div className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                          {img.description}
                        </div>
                      )}
                    </div>

                    {/* Remove */}
                    <button type="button"
                      onClick={e => { e.stopPropagation(); removeImage(img.url); }}
                      className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1.5 rounded-md hover:bg-red-500/10 transition-opacity cursor-pointer mt-0.5"
                      title="Remove image">
                      <Trash2 className="w-4 h-4 text-red-400" />
                    </button>
                  </div>
                );
              })}

              {dockerImages.length === 0 && (
                <p className="text-xs text-center py-4" style={{ color: 'var(--color-text-muted)' }}>
                  No images configured. Add one below.
                </p>
              )}

              {/* Add image form */}
              {showAddImage && (
                <div className="p-3 rounded-lg border border-dashed space-y-2.5"
                  style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
                  <FormInput label="Docker Image URL" value={newImageUrl} onChange={e => setNewImageUrl(e.target.value)}
                    placeholder="myrepo/my-image:latest" />
                  <FormInput label="Label" value={newImageLabel} onChange={e => setNewImageLabel(e.target.value)}
                    placeholder="Short name (e.g. My Custom Image)" />
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Description</label>
                    <textarea value={newImageDesc} onChange={e => setNewImageDesc(e.target.value)}
                      placeholder="What this image contains and when to use it..."
                      rows={2}
                      className="w-full border rounded-lg text-sm p-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500"
                      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)', color: 'var(--color-text)' }} />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" size="sm" onClick={() => { setShowAddImage(false); setNewImageUrl(''); setNewImageLabel(''); setNewImageDesc(''); }}>
                      Cancel
                    </Button>
                    <Button variant="primary" size="sm" onClick={addImage} disabled={!newImageUrl.trim()}>
                      <Check className="w-3.5 h-3.5" /> Add Image
                    </Button>
                  </div>
                </div>
              )}
            </CardBody>
          </Card>

          {/* Provider + GPU Types */}
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold">GPU Hardware</h3>
            </CardHeader>
            <CardBody className="space-y-4">
              <FormSelect label="Cloud Provider" value={gpuProvider} onChange={e => setGpuProvider(e.target.value)}>
                <option value="">Auto (best available)</option>
                <option value="vast">Vast.ai</option>
                <option value="tensordock">TensorDock</option>
                <option value="runpod">RunPod</option>
                <option value="modal">Modal</option>
              </FormSelect>
              <div>
                <label className="block text-xs font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>GPU Types</label>
                <div className="flex flex-wrap gap-1.5">
                  {GPU_TYPES.map(g => {
                    const sel = gpuTypes.includes(g.id);
                    return (
                      <button key={g.id} onClick={() => toggleGpu(g.id)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border cursor-pointer"
                        style={{
                          background: sel ? 'color-mix(in srgb, #a78bfa 10%, transparent)' : 'transparent',
                          borderColor: sel ? 'color-mix(in srgb, #a78bfa 35%, transparent)' : 'var(--color-border)',
                          color: sel ? '#c4b5fd' : 'var(--color-text-muted)',
                        }}>
                        {sel
                          ? <CircleCheck className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#a78bfa' }} />
                          : <Circle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-border)' }} />
                        }
                        {g.label}
                        <span className="text-[10px] font-normal opacity-60">{g.vram}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Idle timeout */}
              <div>
                <label className="block text-xs font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  Auto-stop after idle
                </label>
                <div className="flex items-center gap-2">
                  {[5, 10, 15, 30, 60, 0].map(min => (
                    <button key={min} onClick={() => setIdleTimeoutMin(min)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all cursor-pointer"
                      style={{
                        background: idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 10%, transparent)' : 'transparent',
                        borderColor: idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 35%, transparent)' : 'var(--color-border)',
                        color: idleTimeoutMin === min ? '#fbbf24' : 'var(--color-text-muted)',
                      }}>
                      {min === 0 ? 'Never' : `${min}min`}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
                  {idleTimeoutMin === 0
                    ? 'GPU will stay running until manually terminated'
                    : `GPU will auto-terminate after ${idleTimeoutMin} minutes without requests`
                  }
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      <SaveBar hasChanges={dirty} saving={saving} saved={saved} onSave={handleSave} />
    </div>
  );
}
