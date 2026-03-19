'use client';

import { useState, useEffect, useRef } from 'react';
import { useGpuStatus } from '@/hooks/useGpuStatus';
import { deployGpu, terminateGpu, getGpuLogs, getProviderConfig, patchProviderConfig, getRankedGpuOffers, type GpuOffer } from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, Button, FormSelect,
  AlertBanner, CardSectionHeader, SectionHeader,
} from '@/components/ui';
import { Square, ScrollText, RefreshCw, Zap, ServerCog, AlertCircle, Loader2, Check, Timer, Shuffle, Search, X } from 'lucide-react';
import { DOCKER_IMAGES, GPU_TYPES } from './provider-types';

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const TIMEOUT_PRESETS = [5, 10, 15, 30, 60, 0];

function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return 'var(--color-text-muted)';
  if (ms < 200) return '#10b981';
  if (ms < 500) return '#fbbf24';
  return '#f87171';
}

function dedupeByType(offers: GpuOffer[]): GpuOffer[] {
  const map = new Map<string, GpuOffer>();
  for (const o of offers) {
    const key = o.gpuType || o.gpuName || '';
    if (!key) continue;
    const ex = map.get(key);
    if (!ex || o.pricePerHr < ex.pricePerHr) map.set(key, o);
  }
  return [...map.values()];
}

export function GpuDeploySection() {
  const { gpu, error: gpuError, refresh } = useGpuStatus(true, 5000);
  const [image, setImage] = useState<string>(DOCKER_IMAGES[0].value);
  const [selectedGpus, setSelectedGpus] = useState<string[]>([GPU_TYPES[0].id]);
  const [provider, setProvider] = useState('');
  const [raceCount, setRaceCount] = useState(1);
  const [deploying, setDeploying] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Live GPU browser
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseOffers, setBrowseOffers] = useState<GpuOffer[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseFilter, setBrowseFilter] = useState('');
  const [browseProvider, setBrowseProvider] = useState('');

  // Idle timeout
  const [idleTimeoutMin, setIdleTimeoutMin] = useState(15);
  const [customTimeout, setCustomTimeout] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [timeoutDirty, setTimeoutDirty] = useState(false);
  const [timeoutSaving, setTimeoutSaving] = useState(false);
  const [timeoutSaved, setTimeoutSaved] = useState(false);

  useEffect(() => {
    getProviderConfig().then((cfg: any) => {
      if (typeof cfg.idleTimeoutMin === 'number') setIdleTimeoutMin(cfg.idleTimeoutMin);
      if (cfg.gpuImage) setImage(cfg.gpuImage);
      if (cfg.gpuTypes?.length) setSelectedGpus(cfg.gpuTypes);
      if (cfg.gpuProvider !== undefined) setProvider(cfg.gpuProvider);
    }).catch(() => {});
  }, []);

  async function loadBrowseOffers() {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const data = await getRankedGpuOffers({ provider: browseProvider || undefined, limit: 200 });
      setBrowseOffers(dedupeByType(data.offers));
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : 'Failed to fetch offers');
    } finally {
      setBrowseLoading(false);
    }
  }

  function openBrowse() {
    setBrowseOpen(true);
    if (browseOffers.length === 0) loadBrowseOffers();
  }

  const filteredOffers = browseOffers.filter(o => {
    const name = (o.gpuType || o.gpuName || '').toLowerCase();
    if (browseFilter && !name.includes(browseFilter.toLowerCase())) return false;
    if (browseProvider && o.provider !== browseProvider) return false;
    return true;
  });

  const handleTimeoutChange = (min: number) => {
    setIdleTimeoutMin(min);
    setTimeoutDirty(true);
    setTimeoutSaved(false);
    setShowCustom(false);
  };

  const handleCustomTimeout = () => {
    const val = parseInt(customTimeout);
    if (!isNaN(val) && val >= 0) {
      handleTimeoutChange(val);
      setCustomTimeout('');
    }
  };

  const saveTimeout = async () => {
    setTimeoutSaving(true);
    try {
      await patchProviderConfig({ idleTimeoutMin } as any);
      setTimeoutDirty(false);
      setTimeoutSaved(true);
      setTimeout(() => setTimeoutSaved(false), 3000);
    } catch {} finally { setTimeoutSaving(false); }
  };

  const isActive = gpu && gpu.status !== 'idle' && gpu.status !== 'error';

  async function handleDeploy() {
    setDeploying(true);
    setActionError(null);
    try {
      await deployGpu({
        dockerImage: image,
        gpuTypes: selectedGpus,
        provider: provider || undefined,
        raceCount: raceCount > 1 ? raceCount : undefined,
      });
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  }

  async function handleTerminate() {
    setTerminating(true);
    setActionError(null);
    try {
      await terminateGpu();
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Terminate failed');
    } finally {
      setTerminating(false);
    }
  }

  async function handleLoadLogs() {
    setLoadingLogs(true);
    try {
      const data = await getGpuLogs();
      setLogs(data.logs || '(no logs)');
    } catch {
      setLogs('Failed to load logs');
    } finally {
      setLoadingLogs(false);
    }
  }

  function toggleGpu(id: string) {
    setSelectedGpus(prev =>
      prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]
    );
  }

  function addFromBrowse(gpuType: string) {
    setSelectedGpus(prev => prev.includes(gpuType) ? prev : [...prev, gpuType]);
  }

  const selectedImageDesc = DOCKER_IMAGES.find(d => d.value === image)?.label;
  const providerLabel = provider === 'vast' ? 'Vast.ai' : provider === 'runpod' ? 'RunPod' : provider === 'tensordock' ? 'TensorDock' : provider === 'modal' ? 'Modal' : 'Auto';

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Deploy"
        subtitle="Deploy a self-hosted GPU pod for the full STT + LLM + TTS pipeline"
      />

      {actionError && <AlertBanner variant="error">{actionError}</AlertBanner>}
      {gpuError && <AlertBanner variant="warning">Cannot fetch GPU status: {gpuError}</AlertBanner>}

      {/* What runs inside the pod */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 rounded-xl text-xs"
        style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>
        <span style={{ color: 'var(--color-text-muted)', flexShrink: 0, marginRight: 4 }}>Inside the pod:</span>
        <span className="px-2.5 py-1 rounded-lg font-medium flex-shrink-0"
          style={{ background: 'color-mix(in srgb, #38bdf8 10%, transparent)', color: '#38bdf8', border: '1px solid color-mix(in srgb, #38bdf8 30%, transparent)' }}>
          STT · Whisper
        </span>
        <span style={{ color: 'var(--color-border)' }}>→</span>
        <span className="px-2.5 py-1 rounded-lg font-medium flex-shrink-0"
          style={{ background: 'color-mix(in srgb, #a78bfa 10%, transparent)', color: '#a78bfa', border: '1px solid color-mix(in srgb, #a78bfa 30%, transparent)' }}>
          LLM · TranslateGemma
        </span>
        <span style={{ color: 'var(--color-border)' }}>→</span>
        <span className="px-2.5 py-1 rounded-lg font-medium flex-shrink-0"
          style={{ background: 'color-mix(in srgb, #fbbf24 10%, transparent)', color: '#fbbf24', border: '1px solid color-mix(in srgb, #fbbf24 30%, transparent)' }}>
          TTS · Qwen3-TTS
        </span>
        <span style={{ color: 'var(--color-text-muted)', marginLeft: 'auto', flexShrink: 0 }}>
          health: ~30s · fully warm: ~10 min
        </span>
      </div>

      {/* Deploy Config */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={ServerCog} color="blue" title="Deploy Configuration" subtitle="Docker image and GPU selection" />
        </CardHeader>
        <CardBody className="space-y-5">
          {/* Docker image + Provider */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <FormSelect label="Docker Image" value={image} onChange={e => setImage(e.target.value)}>
                {DOCKER_IMAGES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </FormSelect>
            </div>
            <FormSelect label="Provider" value={provider} onChange={e => setProvider(e.target.value)}>
              <option value="">Auto (best available)</option>
              <option value="tensordock">TensorDock</option>
              <option value="vast">Vast.ai</option>
              <option value="runpod">RunPod</option>
              <option value="modal">Modal</option>
            </FormSelect>
          </div>

          {/* GPU Selection + Deploy action */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {/* Left: GPU pills + live browser */}
            <div
              className="rounded-xl border p-4 flex flex-col gap-3"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}
            >
              <div className="flex items-center justify-between">
                <h5 className="text-sm font-semibold">Select GPUs</h5>
                <button
                  onClick={browseOpen ? () => setBrowseOpen(false) : openBrowse}
                  className="flex items-center gap-1 text-[11px] font-medium cursor-pointer px-2 py-0.5 rounded-md border transition-colors"
                  style={{
                    color: browseOpen ? '#10b981' : 'var(--color-text-muted)',
                    borderColor: browseOpen ? 'color-mix(in srgb, #10b981 30%, transparent)' : 'var(--color-border)',
                    background: browseOpen ? 'color-mix(in srgb, #10b981 8%, transparent)' : 'transparent',
                  }}
                >
                  <Search className="w-3 h-3" /> Browse live
                </button>
              </div>

              {/* Static GPU pills */}
              <div className="flex flex-wrap gap-1.5">
                {GPU_TYPES.map(g => {
                  const selected = selectedGpus.includes(g.id);
                  return (
                    <button
                      key={g.id}
                      onClick={() => toggleGpu(g.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border cursor-pointer"
                      style={{
                        background: selected ? 'color-mix(in srgb, #10b981 12%, transparent)' : 'transparent',
                        borderColor: selected ? 'color-mix(in srgb, #10b981 40%, transparent)' : 'var(--color-border)',
                        color: selected ? '#10b981' : 'var(--color-text-muted)',
                      }}
                    >
                      {selected && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#10b981' }} />}
                      {g.label}
                      <span className="text-[10px] font-normal" style={{ color: selected ? 'color-mix(in srgb, #10b981 60%, transparent)' : 'var(--color-text-muted)' }}>
                        {g.vram}
                      </span>
                    </button>
                  );
                })}
                {/* GPUs added from live browser */}
                {selectedGpus.filter(id => !GPU_TYPES.find(g => g.id === id)).map(id => (
                  <button
                    key={id}
                    onClick={() => toggleGpu(id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border cursor-pointer"
                    style={{
                      background: 'color-mix(in srgb, #10b981 12%, transparent)',
                      borderColor: 'color-mix(in srgb, #10b981 40%, transparent)',
                      color: '#10b981',
                    }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#10b981' }} />
                    {id.replace(/NVIDIA\s*/i, '').replace(/GeForce\s*/i, '')}
                    <X className="w-2.5 h-2.5 opacity-60" />
                  </button>
                ))}
              </div>

              {/* Live browser panel */}
              {browseOpen && (
                <div className="border-t pt-3" style={{ borderColor: 'var(--color-border)' }}>
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      type="text"
                      placeholder="Search GPU…"
                      value={browseFilter}
                      onChange={e => setBrowseFilter(e.target.value)}
                      className="flex-1 text-xs rounded-lg border px-2.5 py-1.5 min-w-0"
                      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
                    />
                    <select
                      value={browseProvider}
                      onChange={e => setBrowseProvider(e.target.value)}
                      className="text-xs rounded-lg border px-2 py-1.5 cursor-pointer"
                      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
                    >
                      <option value="">All providers</option>
                      <option value="vast">Vast.ai</option>
                      <option value="tensordock">TensorDock</option>
                      <option value="runpod">RunPod</option>
                    </select>
                    <button
                      onClick={loadBrowseOffers}
                      disabled={browseLoading}
                      className="p-1.5 rounded-lg border cursor-pointer"
                      style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
                    >
                      <RefreshCw className={`w-3 h-3 ${browseLoading ? 'animate-spin' : ''}`} />
                    </button>
                  </div>

                  {browseError && <p className="text-[11px] text-red-400 mb-2">{browseError}</p>}

                  {browseLoading && browseOffers.length === 0 ? (
                    <div className="flex justify-center py-4">
                      <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-text-muted)' }} />
                    </div>
                  ) : filteredOffers.length === 0 ? (
                    <p className="text-[11px] text-center py-3" style={{ color: 'var(--color-text-muted)' }}>
                      {browseOffers.length === 0 ? 'No offers found. Check provider API keys.' : 'No results.'}
                    </p>
                  ) : (
                    <div className="overflow-auto max-h-48">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                            <th className="pb-1 text-left font-medium">GPU</th>
                            <th className="pb-1 text-left font-medium">Provider</th>
                            <th className="pb-1 text-right font-medium">VRAM</th>
                            <th className="pb-1 text-right font-medium">$/hr</th>
                            <th className="pb-1 text-right font-medium">ms</th>
                            <th className="pb-1" />
                          </tr>
                        </thead>
                        <tbody>
                          {filteredOffers.map((o, i) => {
                            const key = o.gpuType || o.gpuName || '';
                            const isAdded = selectedGpus.includes(key);
                            return (
                              <tr key={i} className="border-t" style={{ borderColor: 'var(--color-border-light)' }}>
                                <td className="py-1 pr-2 font-mono truncate max-w-[100px]" title={key}>
                                  {key.replace(/NVIDIA\s*/i, '').replace(/GeForce\s*/i, '')}
                                </td>
                                <td className="py-1 pr-2 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                                  {o.provider === 'vast' ? 'Vast.ai' : o.provider === 'runpod' ? 'RunPod' : o.provider === 'tensordock' ? 'TensorDock' : o.provider}
                                </td>
                                <td className="py-1 pr-2 text-right font-mono" style={{ color: 'var(--color-text-muted)' }}>
                                  {o.vramGb ? `${o.vramGb}G` : '—'}
                                </td>
                                <td className="py-1 pr-2 text-right font-mono">${o.pricePerHr.toFixed(3)}</td>
                                <td className="py-1 pr-2 text-right font-mono" style={{ color: latencyColor(o.totalMs) }}>
                                  {o.totalMs != null ? String(o.totalMs) : '—'}
                                </td>
                                <td className="py-1 text-right">
                                  <button
                                    onClick={() => isAdded ? toggleGpu(key) : addFromBrowse(key)}
                                    className="px-2 py-0.5 rounded text-[10px] font-medium border cursor-pointer transition-all"
                                    style={{
                                      background: isAdded ? 'color-mix(in srgb, #10b981 12%, transparent)' : 'transparent',
                                      borderColor: isAdded ? 'color-mix(in srgb, #10b981 40%, transparent)' : 'var(--color-border)',
                                      color: isAdded ? '#10b981' : 'var(--color-text-muted)',
                                    }}
                                  >
                                    {isAdded ? '✓' : '+'}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right: Deploy action */}
            <div
              className="rounded-xl border p-4 flex flex-col justify-between"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}
            >
              <div>
                <h5 className="text-sm font-semibold mb-2">Deploy to {providerLabel}</h5>
                <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--color-text-muted)' }}>
                  Finds the best available GPU, deploys the Docker image, and returns a ready endpoint.
                  Pipeline automatically routes to GPU when healthy.
                </p>
                {/* Parallel launch (race deploy) */}
                <div className="mb-4">
                  <p className="text-xs font-medium mb-1.5 flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
                    <Shuffle className="w-3 h-3" /> Parallel launch
                  </p>
                  <div className="flex gap-1.5 flex-wrap">
                    {[1, 2, 3, 5, 10].map(n => (
                      <button
                        key={n}
                        onClick={() => setRaceCount(n)}
                        className="px-2.5 py-1 rounded text-xs font-medium transition-all"
                        style={{
                          background: raceCount === n ? '#8b5cf6' : 'var(--color-surface)',
                          color: raceCount === n ? '#fff' : 'var(--color-text-muted)',
                          border: `1px solid ${raceCount === n ? '#8b5cf6' : 'var(--color-border)'}`,
                        }}
                      >
                        {n === 1 ? '1 (off)' : `×${n}`}
                      </button>
                    ))}
                  </div>
                  {raceCount > 1 && (
                    <p className="text-xs mt-1.5" style={{ color: '#a78bfa' }}>
                      Launches {raceCount} instances simultaneously — keeps the first that boots.
                      Extra cost ≈ ${((raceCount - 1) * 0.5 * 5 / 60).toFixed(2)} if boot takes ~5 min.
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-3">
                <Button onClick={handleDeploy} isLoading={deploying} loadingText="Deploying..." disabled={isActive || selectedGpus.length === 0}>
                  <Zap className="w-4 h-4" /> Deploy
                </Button>
                <Button variant="danger" onClick={handleTerminate} isLoading={terminating} loadingText="Stopping..." disabled={!isActive}>
                  <Square className="w-4 h-4" /> Terminate
                </Button>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Deploy Status Bar */}
      {gpu && gpu.status !== 'idle' && (() => {
        const isReady = gpu.status === 'ready';
        const isError = gpu.status === 'error';
        const isBooting = gpu.status === 'creating' || gpu.status === 'booting' || gpu.status === 'installing';
        const elapsedMin = Math.floor(gpu.elapsedSec / 60);
        const elapsedSecRem = gpu.elapsedSec % 60;
        const gpuProviderLabel = gpu.provider === 'vast' ? 'VAST.ai' : gpu.provider === 'runpod' ? 'RunPod' : gpu.provider === 'tensordock' ? 'TensorDock' : gpu.provider === 'modal' ? 'Modal' : gpu.provider || 'Unknown';

        return (
          <div className="flex gap-3 items-stretch">
            {/* Left: Deploy Status */}
            <div
              className="p-4 rounded-xl border flex-[8] min-w-0"
              style={{
                borderColor: isReady
                  ? 'color-mix(in srgb, #10b981 40%, transparent)' : isError
                  ? 'color-mix(in srgb, #ef4444 40%, transparent)' : 'var(--color-border)',
                background: isReady
                  ? 'color-mix(in srgb, #10b981 8%, var(--color-surface))' : isError
                  ? 'color-mix(in srgb, #ef4444 8%, var(--color-surface))' : 'var(--color-surface)',
              }}
            >
              <h5 className="text-sm font-semibold mb-2">Deploy Status</h5>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium flex items-center gap-2" style={{
                  color: isReady ? '#10b981' : isError ? '#ef4444' : 'var(--color-text)',
                }}>
                  {isBooting && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: '#10b981' }} />}
                  {isReady && <Check className="w-3.5 h-3.5" style={{ color: '#10b981' }} />}
                  {isError && <AlertCircle className="w-3.5 h-3.5" style={{ color: '#ef4444' }} />}
                  {gpu.message}
                </p>
                {isBooting && (
                  <span className="text-xs font-mono font-semibold tabular-nums" style={{ color: '#10b981' }}>
                    {elapsedMin}:{elapsedSecRem.toString().padStart(2, '0')}
                  </span>
                )}
                {isReady && gpu.deployDurationMs && (
                  <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                    deployed in {(gpu.deployDurationMs / 1000).toFixed(1)}s
                  </span>
                )}
              </div>

              {isBooting && (
                <div className="mb-3">
                  <div className="w-full rounded-full h-1.5" style={{ background: 'var(--color-border)' }}>
                    <div
                      className="h-1.5 rounded-full transition-all duration-1000 animate-pulse"
                      style={{
                        background: '#10b981',
                        width: `${Math.min(90, Math.max(10, gpu.elapsedSec * 0.5))}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {isReady && gpu.pipelineRouting && (
                <div className="flex gap-4 text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
                  <span>STT: <span style={{ color: gpu.pipelineRouting.stt === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting.stt}</span></span>
                  <span>LLM: <span style={{ color: gpu.pipelineRouting.llm === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting.llm}</span></span>
                  <span>TTS: <span style={{ color: gpu.pipelineRouting.tts === 'gpu' ? '#10b981' : 'var(--color-text)' }}>{gpu.pipelineRouting.tts}</span></span>
                  <span>Mode: <span className="font-medium" style={{ color: 'var(--color-text)' }}>{gpu.pipelineRouting.mode}</span></span>
                </div>
              )}

              {isBooting && (
                <div className="mt-3">
                  <Button variant="danger" size="sm" onClick={handleTerminate} isLoading={terminating} loadingText="Stopping...">
                    <Square className="w-3.5 h-3.5" /> Cancel Deploy
                  </Button>
                </div>
              )}

              {gpu.alert && <AlertBanner variant="warning" className="mt-3">{gpu.alert}</AlertBanner>}
            </div>

            {/* Right: Instance Info */}
            <div
              className="p-4 rounded-xl border flex-[2] min-w-0"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
            >
              <div className="flex items-center justify-between mb-3">
                <h5 className="text-sm font-semibold">Instance</h5>
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      isReady ? 'bg-emerald-500' :
                      isBooting ? 'bg-violet-500 animate-pulse' :
                      isError ? 'bg-red-500' :
                      'bg-gray-400 animate-pulse'
                    }`}
                  />
                  <span className={`text-[10px] font-medium ${
                    isReady ? 'text-emerald-400' :
                    isBooting ? 'text-violet-400' :
                    isError ? 'text-red-400' :
                    'text-gray-400'
                  }`}>
                    {isReady ? 'Online' :
                     isBooting ? 'Booting...' :
                     isError ? 'Failed' :
                     'Checking...'}
                  </span>
                </div>
              </div>
              <div className="space-y-2 text-xs">
                {gpu.provider && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Provider</span>
                    <span className="font-mono">{gpuProviderLabel}</span>
                  </div>
                )}
                {gpu.gpuType && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>GPU</span>
                    <span className="font-mono">{gpu.gpuType}</span>
                  </div>
                )}
                {gpu.podId && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>ID</span>
                    <span className="font-mono text-[10px] truncate max-w-[140px]" title={gpu.podId}>{gpu.podId}</span>
                  </div>
                )}
                {gpu.costPerHr != null && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Cost</span>
                    <span className="font-mono">${gpu.costPerHr.toFixed(3)}/hr</span>
                  </div>
                )}
                {gpu.endpoint && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Endpoint</span>
                    <span className="font-mono text-[10px] truncate max-w-[140px]" title={gpu.endpoint}>{gpu.endpoint}</span>
                  </div>
                )}
                {isReady && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Uptime</span>
                    <span className="font-mono">{formatUptime(gpu.elapsedSec)}</span>
                  </div>
                )}
              </div>

              {(isReady || isError) && (
                <div className="mt-3">
                  <Button variant="danger" size="sm" onClick={handleTerminate} isLoading={terminating} loadingText="Stopping...">
                    <Square className="w-3.5 h-3.5" /> {isReady ? 'Stop' : 'Terminate'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Error recovery */}
      {gpu?.status === 'error' && !deploying && (
        <div
          className="p-4 rounded-xl border"
          style={{ borderColor: 'color-mix(in srgb, #f59e0b 30%, transparent)', background: 'color-mix(in srgb, #f59e0b 5%, transparent)' }}
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">Deploy failed</p>
              <p className="text-xs leading-relaxed mb-3" style={{ color: 'var(--color-text-muted)' }}>
                {gpu?.message || 'Unknown error. Try redeploying.'}
              </p>
              <Button onClick={handleDeploy} disabled={selectedGpus.length === 0} size="sm">
                <Zap className="w-3.5 h-3.5" /> Retry Deploy
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-stop / Idle timeout */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={Timer} color="amber" title="Auto-Stop" subtitle="Terminate GPU after idle period to save costs" />
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {TIMEOUT_PRESETS.map(min => (
              <button key={min} onClick={() => handleTimeoutChange(min)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all cursor-pointer"
                style={{
                  background: idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 10%, transparent)' : 'transparent',
                  borderColor: idleTimeoutMin === min ? 'color-mix(in srgb, #f59e0b 35%, transparent)' : 'var(--color-border)',
                  color: idleTimeoutMin === min ? '#fbbf24' : 'var(--color-text-muted)',
                }}>
                {min === 0 ? 'Never' : `${min} min`}
              </button>
            ))}
            {!showCustom && !TIMEOUT_PRESETS.includes(idleTimeoutMin) && idleTimeoutMin > 0 && (
              <span className="px-3 py-1.5 rounded-lg text-xs font-medium border"
                style={{ background: 'color-mix(in srgb, #f59e0b 10%, transparent)', borderColor: 'color-mix(in srgb, #f59e0b 35%, transparent)', color: '#fbbf24' }}>
                {idleTimeoutMin} min
              </span>
            )}
            {showCustom ? (
              <div className="flex items-center gap-1.5">
                <input type="number" min="1" value={customTimeout} onChange={e => setCustomTimeout(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCustomTimeout(); if (e.key === 'Escape') setShowCustom(false); }}
                  placeholder="min" autoFocus
                  className="w-20 rounded-lg border px-2 py-1.5 text-xs font-mono"
                  style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }} />
                <Button variant="primary" size="sm" onClick={handleCustomTimeout} disabled={!customTimeout}>Set</Button>
                <Button variant="ghost" size="sm" onClick={() => setShowCustom(false)}>Cancel</Button>
              </div>
            ) : (
              <button onClick={() => setShowCustom(true)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed transition-all cursor-pointer hover:border-[var(--color-text-muted)]"
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
                Custom...
              </button>
            )}
          </div>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {idleTimeoutMin === 0
              ? 'GPU will stay running until manually terminated.'
              : `GPU will auto-terminate after ${idleTimeoutMin} minutes without requests.`
            }
          </p>
          {gpu && gpu.status === 'ready' && gpu.idleSec > 0 && (
            <p className="text-xs" style={{ color: idleTimeoutMin > 0 && gpu.idleSec > idleTimeoutMin * 30 ? '#fbbf24' : 'var(--color-text-muted)' }}>
              Current idle time: {formatUptime(gpu.idleSec)}
              {idleTimeoutMin > 0 && ` / ${idleTimeoutMin}min`}
            </p>
          )}
          {timeoutDirty && (
            <div className="flex items-center gap-3 pt-2">
              <Button onClick={saveTimeout} isLoading={timeoutSaving} loadingText="Saving..." size="sm">
                <Check className="w-3.5 h-3.5" /> Save Timeout
              </Button>
              {timeoutSaved && <span className="text-xs text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> Saved</span>}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Logs */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ScrollText className="w-5 h-5" style={{ color: 'var(--color-text-muted)' }} />
              <h3 className="font-semibold">GPU Logs</h3>
            </div>
            <Button variant="outline" size="sm" onClick={handleLoadLogs} isLoading={loadingLogs} loadingText="Loading...">
              Refresh Logs
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          <pre
            className="text-xs font-mono p-4 rounded-xl overflow-auto max-h-80 whitespace-pre-wrap"
            style={{ background: 'var(--color-bg)', color: 'var(--color-text-muted)' }}
          >
            {logs ?? 'Click "Refresh Logs" to load GPU pod logs.'}
          </pre>
        </CardBody>
      </Card>
    </div>
  );
}
